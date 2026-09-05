/**
 * pi-mem0-cache
 *
 * Wraps globalThis.fetch and intercepts calls to api.mem0.ai:
 * - Reads (search / getAll / get / history) are cached to disk with a 24h TTL.
 * - On API failure (quota exhausted, network down, 4xx/5xx), reads fall back
 *   to the stale cache entry, then to a local memory store.
 * - A 429 response arms a breaker (duration from retry-after): while armed,
 *   reads are answered locally without touching the API.
 * - A freshness gate limits remote reads to one per remoteReadIntervalMs
 *   (default 1h); /mem0-cache refresh resets it explicitly.
 * - Writes that fail against the API are applied to the local store instead.
 * - A shadow logger records local-vs-remote search agreement for every search
 *   miss (~/.pi/agent/mem0-shadow.jsonl). Purely observational.
 * - An embedding recall layer (Jina, OpenAI-compatible /v1/embeddings) ranks
 *   the local mirror semantically for gated/fallback reads and is shadow-logged
 *   next to the keyword ranking.
 *
 * Local writes are NOT replayed to mem0 later — the local store remains
 * searchable via the read fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "mem0-cache.json");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMOTE_READ_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_429_BLOCK_MS = 5 * 60 * 1000;
const DEFAULT_SHADOW_PATH = join(homedir(), ".pi", "agent", "mem0-shadow.jsonl");
const SHADOW_ROTATE_BYTES = 4 * 1024 * 1024;
const SHADOW_KEEP_LINES = 2000;
const DEFAULT_VECTORS_PATH = join(homedir(), ".pi", "agent", "mem0-vectors.json");
const DEFAULT_EMBED_MODEL = "jina-embeddings-v5-text-nano";
const EMBED_COOLDOWN_MS = 60 * 1000;
const WRAPPED = Symbol.for("pi-mem0-cache.wrapped");
const MAX_FALLBACK_RESULTS = 10;

interface CachedResponse {
  status: number;
  body: string;
  savedAt: number;
}

export interface LocalMemory {
  id: string;
  memory: string;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  source: "local" | "observed";
  /** Original /v3/memories/add/ payload (minus `messages`) captured when the
   *  write fell back locally — replayed verbatim on sync so scope params
   *  (user_id, app_id, …) survive. */
  addPayload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SyncState {
  backoffUntil?: number;
  lastAttemptAt?: number;
  lastResult?: string;
}

export interface NetState {
  /** Reads skip the network until this time (armed by a 429's retry-after). */
  readsBlockedUntil?: number;
  /** Last successful remote read — the freshness gate's reference point. */
  lastRemoteReadAt?: number;
}

export interface Store {
  version: 1;
  cache: Record<string, CachedResponse>;
  memories: Record<string, LocalMemory>;
  syncState: SyncState;
  netState: NetState;
  stats: {
    hits: number;
    misses: number;
    passthroughs: number;
    staleServed: number;
    fallbacks: number;
    localWrites: number;
    gated: number;
  };
}

export function emptyStore(): Store {
  return {
    version: 1,
    cache: {},
    memories: {},
    syncState: {},
    netState: {},
    stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0, gated: 0 },
  };
}

export function loadStore(path: string): Store {
  try {
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    const base = emptyStore();
    return {
      version: 1,
      cache: parsed.cache ?? {},
      memories: parsed.memories ?? {},
      syncState: parsed.syncState ?? {},
      netState: parsed.netState ?? {},
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
    };
  } catch {
    return emptyStore();
  }
}

export function makeSaver(store: Store, path: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2));
      renameSync(tmp, path);
    } catch (err) {
      console.warn("[pi-mem0-cache] failed to persist store:", err);
    }
  };
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (typeof timer.unref === "function") timer.unref();
  };
}

// ---------------------------------------------------------------------------
// Request classification

type FetchInput = string | URL | Request;

interface ClassifiedRequest {
  url: URL;
  method: string;
  bodyText: string | undefined;
  kind: "read-search" | "read-getall" | "read-get" | "read-history" | "read-other" | "write-add" | "write-update" | "write-delete" | "write-delete-all" | "write-other" | "other";
  memoryId?: string;
  query?: string;
}

export function isMem0Host(url: URL): boolean {
  return url.hostname === "api.mem0.ai" || url.hostname.endsWith(".mem0.ai");
}

export function classify(input: FetchInput, init?: RequestInit): ClassifiedRequest | null {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isMem0Host(url)) return null;

  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const rawBody = init?.body ?? (typeof input === "object" && "body" in input ? (input as Request).body : undefined);
  const bodyText = typeof rawBody === "string" ? rawBody : undefined;
  // Bodies that aren't plain strings (streams etc.) — passthrough, don't intercept.
  if (rawBody !== undefined && bodyText === undefined) return null;

  const path = url.pathname;
  const memoryIdMatch = path.match(/^\/v1\/memories\/([^/]+)\/?$/);
  const historyMatch = path.match(/^\/v1\/memories\/([^/]+)\/history\/?$/);

  let parsedBody: Record<string, unknown> | undefined;
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
  }

  if (method === "GET" && historyMatch) {
    return { url, method, bodyText, kind: "read-history", memoryId: historyMatch[1] };
  }
  if (method === "POST" && /^\/v[23]\/memories\/search\/?$/.test(path)) {
    return { url, method, bodyText, kind: "read-search", query: typeof parsedBody?.query === "string" ? parsedBody.query : undefined };
  }
  if (method === "POST" && /^\/v3\/memories\/add\/?$/.test(path)) {
    return { url, method, bodyText, kind: "write-add" };
  }
  if (method === "POST" && /^\/v3\/memories\/?$/.test(path)) {
    return { url, method, bodyText, kind: "read-getall" };
  }
  if (method === "GET" && memoryIdMatch) {
    return { url, method, bodyText, kind: "read-get", memoryId: memoryIdMatch[1] };
  }
  if ((method === "PUT" || method === "PATCH") && memoryIdMatch) {
    return { url, method, bodyText, kind: "write-update", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && memoryIdMatch) {
    return { url, method, bodyText, kind: "write-delete", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && /^\/v1\/memories\/?$/.test(path)) {
    return { url, method, bodyText, kind: "write-delete-all" };
  }
  if (method === "GET") {
    return { url, method, bodyText, kind: "read-other" };
  }
  return { url, method, bodyText, kind: "other" };
}

function cacheKey(req: ClassifiedRequest): string {
  return `${req.method} ${req.url.pathname}${req.url.search} ${req.bodyText ?? ""}`;
}

// ---------------------------------------------------------------------------
// Local memory operations

export function harvestMemories(store: Store, bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : [];
  for (const item of candidates) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.memory !== "string") continue;
    const existing = store.memories[m.id];
    // Never let an observed copy overwrite a local write.
    if (existing?.source === "local") continue;
    store.memories[m.id] = {
      ...m,
      id: m.id,
      memory: m.memory,
      created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
      updated_at: typeof m.updated_at === "string" ? m.updated_at : new Date().toISOString(),
      deleted: false,
      source: "observed",
    } as LocalMemory;
  }
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[一-鿿＀-￯]/g) ?? [];
}

export function searchLocalScored(
  store: Store,
  query: string,
  limit = MAX_FALLBACK_RESULTS,
): { m: LocalMemory; score: number }[] {
  const tokens = tokenize(query);
  const all = Object.values(store.memories).filter((m) => !m.deleted);
  if (tokens.length === 0) return all.slice(0, limit).map((m) => ({ m, score: 0 }));
  const scored = all
    .map((m) => {
      const text = m.memory.toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function searchLocal(store: Store, query: string, limit = MAX_FALLBACK_RESULTS): LocalMemory[] {
  return searchLocalScored(store, query, limit).map((s) => s.m);
}

function stripInternal(m: LocalMemory): Record<string, unknown> {
  const { deleted, source, ...rest } = m;
  return rest;
}

function applyLocalWrite(store: Store, req: ClassifiedRequest): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (req.kind) {
    case "write-add": {
      let contents: string[] = [];
      let addPayload: Record<string, unknown> = {};
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { messages?: { content?: string }[] } & Record<string, unknown>;
        const { messages, ...rest } = body;
        addPayload = rest;
        contents = (messages ?? [])
          .map((m) => m.content)
          .filter((c): c is string => typeof c === "string" && c.length > 0);
      } catch {
        /* ignore */
      }
      const memory = contents.join("\n") || "(empty)";
      const id = `local-${randomUUID()}`;
      store.memories[id] = { id, memory, created_at: now, updated_at: now, source: "local", addPayload };
      return { message: "Memory stored locally (mem0 API unavailable).", id, status: "PENDING" };
    }
    case "write-update": {
      const id = req.memoryId ?? "";
      let text: string | undefined;
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { text?: string };
        text = body.text;
      } catch {
        /* ignore */
      }
      const existing = store.memories[id];
      if (existing) {
        if (text !== undefined) existing.memory = text;
        existing.updated_at = now;
        existing.source = "local";
      } else {
        store.memories[id] = { id, memory: text ?? "", created_at: now, updated_at: now, source: "local" };
      }
      return { message: "Memory updated locally (mem0 API unavailable).", id };
    }
    case "write-delete": {
      const id = req.memoryId ?? "";
      if (store.memories[id]) store.memories[id].deleted = true;
      return { message: "Memory deleted locally (mem0 API unavailable)." };
    }
    case "write-delete-all": {
      for (const m of Object.values(store.memories)) m.deleted = true;
      return { message: "Memories deleted locally (mem0 API unavailable)." };
    }
    default:
      return { message: "Handled locally (mem0 API unavailable)." };
  }
}

// ---------------------------------------------------------------------------
// Shadow log: records local-vs-remote search agreement on every miss

export interface ShadowLocalHit {
  id: string;
  score: number;
}

export interface ShadowRemoteHit {
  id: string;
  score?: number;
}

export interface ShadowEntry {
  ts: number;
  /** remote = miss answered by the API; fallback = API failed, local answered */
  mode: "remote" | "fallback";
  query: string;
  local: ShadowLocalHit[];
  remote: ShadowRemoteHit[];
  overlap5: number;
  overlap10: number;
  /** reciprocal rank of the remote top-1 id within the local ranking (0 = absent) */
  mrr: number;
  /** vector-recall side (present when the embedding layer answered) */
  localVec?: ShadowLocalHit[];
  overlapVec5?: number;
  overlapVec10?: number;
  mrrVec?: number;
}

export function compareShadow(
  local: { id: string }[],
  remote: { id: string }[],
): { overlap5: number; overlap10: number; mrr: number } {
  const localTop10 = local.slice(0, 10);
  const remoteTop10 = remote.slice(0, 10);
  const overlap = (k: number): number => {
    const remoteTopK = remoteTop10.slice(0, k).map((h) => h.id);
    const localTopK = new Set(localTop10.slice(0, k).map((h) => h.id));
    return remoteTopK.filter((id) => localTopK.has(id)).length;
  };
  const remoteTop1 = remoteTop10[0]?.id;
  const rank = remoteTop1 === undefined ? -1 : localTop10.findIndex((h) => h.id === remoteTop1);
  return { overlap5: overlap(5), overlap10: overlap(10), mrr: rank >= 0 ? 1 / (rank + 1) : 0 };
}

export interface ShadowSummary {
  comparisons: number;
  fallbacks: number;
  meanOverlap5: number;
  meanOverlap10: number;
  meanMrr: number;
  perfect5Rate: number;
  top1Recall: number;
  vecComparisons: number;
  meanOverlapVec5: number;
  meanOverlapVec10: number;
  meanMrrVec: number;
  top1VecRecall: number;
}

export function summarizeShadow(entries: ShadowEntry[]): ShadowSummary {
  const remote = entries.filter((e) => e.mode === "remote");
  const n = remote.length;
  const mean = (pick: (e: ShadowEntry) => number) => (n === 0 ? 0 : remote.reduce((sum, e) => sum + pick(e), 0) / n);
  const withVec = remote.filter((e) => e.localVec !== undefined);
  const nv = withVec.length;
  const meanVec = (pick: (e: ShadowEntry) => number) => (nv === 0 ? 0 : withVec.reduce((sum, e) => sum + pick(e), 0) / nv);
  return {
    comparisons: n,
    fallbacks: entries.length - n,
    meanOverlap5: mean((e) => e.overlap5),
    meanOverlap10: mean((e) => e.overlap10),
    meanMrr: mean((e) => e.mrr),
    perfect5Rate: n === 0 ? 0 : remote.filter((e) => e.overlap5 >= 5).length / n,
    top1Recall: n === 0 ? 0 : remote.filter((e) => e.mrr > 0).length / n,
    vecComparisons: nv,
    meanOverlapVec5: meanVec((e) => e.overlapVec5 ?? 0),
    meanOverlapVec10: meanVec((e) => e.overlapVec10 ?? 0),
    meanMrrVec: meanVec((e) => e.mrrVec ?? 0),
    top1VecRecall: nv === 0 ? 0 : withVec.filter((e) => (e.mrrVec ?? 0) > 0).length / nv,
  };
}

/** Append one entry, then compact the file once it exceeds rotateBytes,
 *  keeping the most recent keepLines lines. */
export function appendShadowLog(
  path: string,
  entry: ShadowEntry,
  rotateBytes = SHADOW_ROTATE_BYTES,
  keepLines = SHADOW_KEEP_LINES,
): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size > rotateBytes) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeFileSync(path, `${lines.slice(-keepLines).join("\n")}\n`);
    }
  } catch (err) {
    console.warn("[pi-mem0-cache] failed to append shadow log:", err);
  }
}

export function readShadowEntries(path: string): ShadowEntry[] {
  try {
    if (!existsSync(path)) return [];
    const entries: ShadowEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as ShadowEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function remoteSearchHits(body: string | null): ShadowRemoteHit[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const hits: ShadowRemoteHit[] = [];
    for (const item of results.slice(0, 10)) {
      if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
        const hit = item as { id: string; score?: unknown };
        hits.push(typeof hit.score === "number" ? { id: hit.id, score: hit.score } : { id: hit.id });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** Compare the pre-fetch mirror state against the remote answer for one search.
 *  Called BEFORE harvestMemories on the success path, so the local rankings
 *  reflect what a freshness-gated read would have served from the mirror.
 *  Keyword ranking is always recorded; the vector ranking is added when the
 *  embedding layer answers. */
async function recordShadow(
  log: (entry: ShadowEntry) => void,
  mode: ShadowEntry["mode"],
  req: ClassifiedRequest,
  remoteBody: string | null,
  store: Store,
  embed?: EmbedHarness,
): Promise<void> {
  const remote = remoteSearchHits(remoteBody);
  const local = searchLocalScored(store, req.query ?? "", 10).map(({ m, score }) => ({ id: m.id, score }));
  const { overlap5, overlap10, mrr } = compareShadow(local, remote);
  const entry: ShadowEntry = {
    ts: Date.now(),
    mode,
    query: (req.query ?? "").slice(0, 200),
    local,
    remote,
    overlap5,
    overlap10,
    mrr,
  };
  const vecRanked = embed ? await embed.search(req.query ?? "").catch(() => null) : null;
  if (vecRanked) {
    const localVec = vecRanked.slice(0, 10).map(({ m, score }) => ({ id: m.id, score: Number(score.toFixed(4)) }));
    const vec = compareShadow(localVec, remote);
    entry.localVec = localVec;
    entry.overlapVec5 = vec.overlap5;
    entry.overlapVec10 = vec.overlap10;
    entry.mrrVec = vec.mrr;
  }
  log(entry);
}

// ---------------------------------------------------------------------------
// Embedding recall (Jina): semantic ranking of the local mirror

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  /** sha1 of the embedded memory text — detects stale vectors */
  hash: string;
  vec: number[];
}

export interface VectorStore {
  model: string;
  dims: number;
  vectors: Record<string, VectorRecord>;
  updatedAt?: number;
}

export function emptyVectorStore(): VectorStore {
  return { model: "", dims: 0, vectors: {} };
}

export function loadVectorStore(path: string): VectorStore {
  try {
    if (!existsSync(path)) return emptyVectorStore();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VectorStore>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      dims: typeof parsed.dims === "number" ? parsed.dims : 0,
      vectors: parsed.vectors ?? {},
    };
  } catch {
    return emptyVectorStore();
  }
}

export function makeVectorSaver(vecStore: VectorStore, path: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(vecStore));
      renameSync(tmp, path);
    } catch (err) {
      console.warn("[pi-mem0-cache] failed to persist vectors:", err);
    }
  };
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (typeof timer.unref === "function") timer.unref();
  };
}

function textHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function createJinaEmbedder(
  apiKey: string,
  model = DEFAULT_EMBED_MODEL,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Embedder {
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetchImpl("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`jina embeddings HTTP ${res.status}`);
      const parsed = (await res.json()) as { data?: { embedding?: unknown; index?: number }[] };
      const data = Array.isArray(parsed.data) ? [...parsed.data] : [];
      data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vecs = data.map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : null));
      if (vecs.length === 0 || vecs.some((v) => !v || v.length === 0)) {
        throw new Error("jina embeddings: malformed response body");
      }
      return vecs as number[][];
    },
  };
}

export function normalizeVec(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? v.map(() => 0) : v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  const an = normalizeVec(a);
  const bn = normalizeVec(b);
  let dot = 0;
  for (let i = 0; i < Math.min(an.length, bn.length); i++) dot += an[i] * bn[i];
  return dot;
}

export function searchLocalVector(
  queryVec: number[],
  corpus: LocalMemory[],
  vectors: Record<string, VectorRecord>,
  limit = MAX_FALLBACK_RESULTS,
): { m: LocalMemory; score: number }[] {
  return corpus
    .map((m) => {
      const v = vectors[m.id]?.vec;
      return { m, score: v ? cosine(queryVec, v) : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Embed corpus entries incrementally: new/changed texts only, stale vectors
 *  for deleted memories pruned, model mismatch wipes the store. Throws on
 *  provider failure — callers decide cooldown policy. */
export async function ensureEmbeddings(
  store: Store,
  vecStore: VectorStore,
  embedder: Embedder,
): Promise<{ embedded: number; corpus: number }> {
  if (vecStore.model !== embedder.model) {
    vecStore.vectors = {};
    vecStore.model = embedder.model;
    vecStore.dims = 0;
  }
  const live = Object.values(store.memories).filter((m) => !m.deleted);
  const targets = live.filter((m) => {
    const v = vecStore.vectors[m.id];
    return !v || v.hash !== textHash(m.memory);
  });
  for (const id of Object.keys(vecStore.vectors)) {
    const m = store.memories[id];
    if (!m || m.deleted) delete vecStore.vectors[id];
  }
  if (targets.length === 0) return { embedded: 0, corpus: live.length };
  // Chunked embedding: thousands of inputs in one request would blow the
  // per-request timeout; 256 inputs per call stays fast and well under limits.
  const vecs: number[][] = [];
  const CHUNK = 256;
  for (let i = 0; i < targets.length; i += CHUNK) {
    vecs.push(...(await embedder.embed(targets.slice(i, i + CHUNK).map((m) => m.memory))));
  }
  targets.forEach((m, i) => {
    vecStore.vectors[m.id] = { hash: textHash(m.memory), vec: vecs[i] };
  });
  vecStore.dims = vecs[0]?.length ?? 0;
  vecStore.updatedAt = Date.now();
  return { embedded: targets.length, corpus: live.length };
}

/** Interceptor-facing embedding harness: never throws, answers null when the
 *  provider is unavailable, and cools down for a minute after any failure. */
export interface EmbedHarness {
  ensure(): Promise<void>;
  /** Vector ranking for one query, or null when unavailable. */
  search(query: string): Promise<{ m: LocalMemory; score: number }[] | null>;
  status(): { enabled: boolean; model: string; vectors: number; corpus: number; lastError?: string; cooldownUntil?: number };
  /** Force a full re-embed; returns a human-readable result line. */
  refresh(): Promise<string>;
}

export function createEmbedHarness(
  store: Store,
  saveVectors: () => void,
  vecStore: VectorStore,
  embedder: Embedder,
): EmbedHarness {
  let cooldownUntil = 0;
  let lastError: string | undefined;
  const fail = (err: unknown): void => {
    lastError = err instanceof Error ? err.message : String(err);
    cooldownUntil = Date.now() + EMBED_COOLDOWN_MS;
  };
  const ensure = async (): Promise<void> => {
    if (Date.now() < cooldownUntil) return;
    try {
      const r = await ensureEmbeddings(store, vecStore, embedder);
      if (r.embedded > 0) saveVectors();
      lastError = undefined;
    } catch (err) {
      fail(err);
    }
  };
  const search = async (query: string): Promise<{ m: LocalMemory; score: number }[] | null> => {
    if (Date.now() < cooldownUntil) return null;
    try {
      await ensure();
      const withVec = Object.values(store.memories).filter((m) => !m.deleted && vecStore.vectors[m.id]);
      if (withVec.length === 0) return null;
      const [queryVec] = await embedder.embed([query]);
      return searchLocalVector(queryVec, withVec, vecStore.vectors);
    } catch (err) {
      fail(err);
      return null;
    }
  };
  const status = () => ({
    enabled: true,
    model: embedder.model,
    vectors: Object.keys(vecStore.vectors).length,
    corpus: Object.values(store.memories).filter((m) => !m.deleted).length,
    lastError,
    cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : undefined,
  });
  const refresh = async (): Promise<string> => {
    cooldownUntil = 0;
    lastError = undefined;
    vecStore.vectors = {};
    vecStore.dims = 0;
    try {
      const r = await ensureEmbeddings(store, vecStore, embedder);
      saveVectors();
      return `embedded ${r.embedded}/${r.corpus}, model ${embedder.model}, dims ${vecStore.dims}`;
    } catch (err) {
      fail(err);
      return `embed failed: ${lastError}`;
    }
  };
  return { ensure, search, status, refresh };
}

/** Default provider selection from the environment: Jina when JINA_API_KEY is
 *  present; MEM0_EMBED=0 forces off regardless. */
export function createDefaultEmbedder(): Embedder | undefined {
  if (process.env.MEM0_EMBED === "0") return undefined;
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) return undefined;
  return createJinaEmbedder(apiKey, process.env.MEM0_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, (...args) =>
    globalThis.fetch(...args),
  );
}

// ---------------------------------------------------------------------------
// Fetch interceptor

const ENTITY_FILTER_KEYS = new Set(["user_id", "agent_id", "app_id", "run_id"]);

/**
 * Workaround for mem0ai/mem0#6168: mem0's "*" wildcard matches only non-null
 * values, so the pi mem0 plugin's global-scope reads (filters.app_id = "*")
 * can never see global-scope writes (stored with app_id = null). Dropping the
 * "*" entity filter restores the intended "unconstrained" semantics.
 */
export function normalizeWildcardFilters(bodyText: string | undefined): string | undefined {
  if (!bodyText) return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (typeof parsed !== "object" || parsed === null) return bodyText;
  const body = parsed as Record<string, unknown>;
  const filters = body.filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return bodyText;
  const f = filters as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(f)) {
    if (ENTITY_FILTER_KEYS.has(key) && f[key] === "*") {
      delete f[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(body) : bodyText;
}

export interface CapturedAuth {
  origin: string;
  headers: Record<string, string>;
}

export function extractHeaders(input: FetchInput, init?: RequestInit): Record<string, string> | undefined {
  const raw = init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined);
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  try {
    new Headers(raw as HeadersInit).forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    return undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface InterceptorOptions {
  store: Store;
  save: () => void;
  ttlMs: number;
  onFallback?: (reason: string) => void;
  /** Shared cell the interceptor fills with the last seen mem0 auth headers. */
  authRef?: { current?: CapturedAuth };
  /** Called after any successful mem0 API response (read or write). */
  onPassthroughSuccess?: () => void;
  /** Freshness window: synthesizable reads (search / getAll / get) issued
   *  within this interval since the last successful remote read are answered
   *  locally without touching the network. 0 disables the gate. */
  remoteReadIntervalMs?: number;
  /** Receives one ShadowEntry per read-search miss (remote or fallback-served). */
  shadowLog?: (entry: ShadowEntry) => void;
  /** Embedding harness: semantic ranking of the mirror for gated/fallback
   *  reads; null results degrade to the keyword ranking. */
  embed?: EmbedHarness;
  /** Shared cell capturing the client's most recent read filters (user_id, …) —
   *  pull-all reuses them minus entity-scoping keys. */
  filtersRef?: { current?: Record<string, unknown> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createInterceptor(
  fetchImpl: typeof fetch,
  opts: InterceptorOptions,
): typeof fetch {
  const { store, save, ttlMs, onFallback, remoteReadIntervalMs = 0 } = opts;

  /** Answer a read without the network: stale cache first, then the local
   *  store. Null for reads that can't be synthesized (history, unknown). */
  const serveLocalRead = async (req: ClassifiedRequest, cached?: CachedResponse): Promise<Response | null> => {
    if (cached) return jsonResponse(JSON.parse(cached.body), cached.status);
    if (req.kind === "read-search") {
      const vecRanked = opts.embed ? await opts.embed.search(req.query ?? "") : null;
      const ranked: LocalMemory[] = vecRanked ? vecRanked.map((s) => s.m) : searchLocal(store, req.query ?? "");
      return jsonResponse({ results: ranked.map(stripInternal) });
    }
    if (req.kind === "read-getall") {
      const all = Object.values(store.memories).filter((m) => !m.deleted).map(stripInternal);
      return jsonResponse({ results: all, count: all.length });
    }
    if (req.kind === "read-get" && req.memoryId) {
      const m = store.memories[req.memoryId];
      if (m && !m.deleted) return jsonResponse(stripInternal(m));
    }
    return null;
  };

  const interceptor = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    let req = classify(input, init);
    if (!req || req.kind === "other") {
      return fetchImpl(input as string | URL | Request, init);
    }

    if (opts.authRef) {
      const headers = extractHeaders(input, init);
      if (headers?.authorization) {
        opts.authRef.current = { origin: req.url.origin, headers };
      }
    }

    if (req.kind === "read-search" || req.kind === "read-getall") {
      const normalized = normalizeWildcardFilters(req.bodyText);
      if (normalized !== undefined && normalized !== req.bodyText) {
        req = { ...req, bodyText: normalized };
        init = { ...init, body: normalized };
      }
      if (opts.filtersRef && req.bodyText) {
        try {
          const parsed = JSON.parse(req.bodyText) as { filters?: Record<string, unknown> };
          if (typeof parsed.filters === "object" && parsed.filters !== null && Object.keys(parsed.filters).length > 0) {
            opts.filtersRef.current = parsed.filters;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // -- Writes ---------------------------------------------------------------
    if (req.kind.startsWith("write-")) {
      if (req.kind === "write-other") return fetchImpl(input as string | URL | Request, init);
      try {
        const res = await fetchImpl(input as string | URL | Request, init);
        if (res.ok) {
          store.stats.passthroughs++;
          opts.onPassthroughSuccess?.();
          return res;
        }
        store.stats.fallbacks++;
        store.stats.localWrites++;
        const writeErrBody = await res.clone().text().catch(() => "");
        onFallback?.(
          `write ${req.kind} fell back to local store (HTTP ${res.status})${writeErrBody ? `: ${writeErrBody.slice(0, 200)}` : ""}`,
        );
      } catch (err) {
        store.stats.fallbacks++;
        store.stats.localWrites++;
        onFallback?.(`write ${req.kind} fell back to local store (${err instanceof Error ? err.message : String(err)})`);
      }
      const result = applyLocalWrite(store, req);
      save();
      return jsonResponse(result);
    }

    // -- Reads ----------------------------------------------------------------
    const key = cacheKey(req);
    const cached = store.cache[key];
    const fresh = cached !== undefined && Date.now() - cached.savedAt < ttlMs;

    if (cached && fresh) {
      store.stats.hits++;
      return jsonResponse(JSON.parse(cached.body), cached.status);
    }

    // -- Network gates -------------------------------------------------------
    // 429 breaker (armed from retry-after) and the freshness window both answer
    // reads locally without touching the API. Only reads we can synthesize are
    // gated; history / unknown reads stay on the network path.
    const gateable = req.kind === "read-search" || req.kind === "read-getall" || req.kind === "read-get";
    const breakerArmed =
      store.netState.readsBlockedUntil !== undefined && Date.now() < store.netState.readsBlockedUntil;
    const freshnessActive =
      remoteReadIntervalMs > 0 &&
      store.netState.lastRemoteReadAt !== undefined &&
      Date.now() - store.netState.lastRemoteReadAt < remoteReadIntervalMs;
    if (gateable && (breakerArmed || freshnessActive)) {
      store.stats.gated++;
      save();
      return (await serveLocalRead(req, cached)) ?? jsonResponse({ error: "not available locally (network gate active)" }, 404);
    }

    store.stats.misses++;
    let failed: Response | null = null;
    try {
      const res = await fetchImpl(input as string | URL | Request, init);
      if (res.ok) {
        const body = await res.clone().text();
        if (req.kind === "read-search" && opts.shadowLog) {
          await recordShadow(opts.shadowLog, "remote", req, body, store, opts.embed);
        }
        store.cache[key] = { status: res.status, body, savedAt: Date.now() };
        harvestMemories(store, body);
        store.netState.lastRemoteReadAt = Date.now();
        delete store.netState.readsBlockedUntil;
        store.stats.passthroughs++;
        opts.onPassthroughSuccess?.();
        save();
        return res;
      }
      failed = res;
      store.stats.fallbacks++;
      const errBody = await res.clone().text().catch(() => "");
      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        store.netState.readsBlockedUntil =
          Date.now() + (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_429_BLOCK_MS);
      }
      onFallback?.(`read ${req.kind} fell back (HTTP ${res.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
    } catch (err) {
      store.stats.fallbacks++;
      onFallback?.(`read ${req.kind} fell back (${err instanceof Error ? err.message : String(err)})`);
    }

    if (cached) {
      store.stats.staleServed++;
      save();
      return jsonResponse(JSON.parse(cached.body), cached.status);
    }

    // Local fallback for search / getAll / single get.
    const localAnswer = await serveLocalRead(req);
    if (localAnswer) {
      if (req.kind === "read-search" && opts.shadowLog) {
        await recordShadow(opts.shadowLog, "fallback", req, null, store, opts.embed);
      }
      save();
      return localAnswer;
    }

    // Can't synthesize a meaningful answer (history, unknown reads): return the
    // original failed response, or rethrow for network errors.
    if (failed) return failed;
    throw new Error("mem0 API unreachable and no local fallback available");
  };

  return interceptor as typeof fetch;
}

// ---------------------------------------------------------------------------
// Sync: upload locally-stored memories once the API works again

export interface SyncRunnerOptions {
  store: Store;
  save: () => void;
  fetchImpl: typeof fetch;
  getAuth: () => CapturedAuth | undefined;
  onEvent?: (message: string) => void;
  /** Backoff after a failed sync attempt (default 1h). */
  backoffMs?: number;
}

export interface SyncResult {
  uploaded: number;
  failed: number;
  skipped: boolean;
  pending: number;
}

const DEFAULT_SYNC_BACKOFF_MS = 60 * 60 * 1000;

export function createSyncRunner(opts: SyncRunnerOptions) {
  const { store, save, fetchImpl, getAuth, onEvent } = opts;
  const backoffMs = opts.backoffMs ?? DEFAULT_SYNC_BACKOFF_MS;
  let inFlight: Promise<SyncResult> | null = null;

  const pendingList = () => Object.values(store.memories).filter((m) => m.source === "local" && !m.deleted);

  async function sync(force = false): Promise<SyncResult> {
    // Locally-created memories deleted before ever syncing never reached the
    // cloud — purge them outright.
    for (const m of Object.values(store.memories)) {
      if (m.source === "local" && m.deleted) delete store.memories[m.id];
    }

    const pending = pendingList();
    const auth = getAuth();
    if (pending.length === 0 || !auth) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pending.length };
    }
    const now = Date.now();
    if (!force && store.syncState.backoffUntil && now < store.syncState.backoffUntil) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pending.length };
    }
    store.syncState.lastAttemptAt = now;

    let uploaded = 0;
    let failed = 0;
    for (const m of pending) {
      const payload = { ...(m.addPayload ?? {}), messages: [{ role: "user", content: m.memory }] };
      try {
        const res = await fetchImpl(`${auth.origin}/v3/memories/add/`, {
          method: "POST",
          headers: { ...auth.headers, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          uploaded++;
          harvestMemories(store, await res.text().catch(() => ""));
          m.source = "observed";
          delete m.addPayload;
        } else {
          failed++;
          store.syncState.backoffUntil = Date.now() + backoffMs;
          onEvent?.(`sync paused after HTTP ${res.status}; retrying after backoff`);
          break;
        }
      } catch (err) {
        failed++;
        store.syncState.backoffUntil = Date.now() + backoffMs;
        onEvent?.(`sync paused after error: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    store.syncState.lastResult = `uploaded ${uploaded}, failed ${failed}, pending ${pendingList().length}`;
    save();
    if (uploaded > 0 || failed > 0) {
      onEvent?.(`sync: ${store.syncState.lastResult}`);
    }
    return { uploaded, failed, skipped: false, pending: pendingList().length };
  }

  /** Fire-and-forget; dedupes concurrent runs. Returns null when nothing to do. */
  function maybeSync(): Promise<SyncResult> | null {
    if (inFlight) return inFlight;
    if (pendingList().length === 0) return null;
    inFlight = sync(false)
      .catch(() => ({ uploaded: 0, failed: 0, skipped: true, pending: pendingList().length }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { sync, maybeSync, pendingCount: () => pendingList().length };
}

// ---------------------------------------------------------------------------
// Pull-all: full-mirror harvest via paginated getAll (bypasses the interceptor)

export interface PullAllOptions {
  store: Store;
  /** Unwrapped fetch — pull-all must bypass the interceptor's gates/cache. */
  fetchImpl: typeof fetch;
  getAuth: () => CapturedAuth | undefined;
  /** Entity filters observed from the client's own reads; app_id/agent_id/run_id
   *  are dropped so the mirror covers every app of the user. */
  getFilters: () => Record<string, unknown> | undefined;
  pageSize?: number;
  maxPages?: number;
}

export interface PullAllResult {
  pages: number;
  fetched: number;
  newHarvested: number;
  /** Server-reported total for the filter scope (0 when absent). */
  total: number;
}

/** Fallback auth built from the mem0 client's environment key (Token scheme,
 *  default platform origin) — used when no request has been observed yet. */
export function authFromEnv(): CapturedAuth | undefined {
  const key = process.env.MEM0_API_KEY;
  if (!key) return undefined;
  return { origin: process.env.MEM0_API_ORIGIN || "https://api.mem0.ai", headers: { authorization: `Token ${key}` } };
}

/** Fallback filters parsed from any cached request key in the store — lets
 *  pull-all run before the client has made a single read this session. */
export function filtersFromCache(store: Store): Record<string, unknown> | undefined {
  for (const key of Object.keys(store.cache)) {
    if (!key.startsWith("POST /v3/memories/")) continue;
    const bodyStart = key.indexOf(" ");
    if (bodyStart < 0) continue;
    try {
      const parsed = JSON.parse(key.slice(bodyStart + 1)) as { filters?: Record<string, unknown> };
      if (parsed.filters && typeof parsed.filters === "object" && Object.keys(parsed.filters).length > 0) {
        return parsed.filters;
      }
    } catch {
      /* skip malformed key */
    }
  }
  return undefined;
}

export async function pullAllMemories(opts: PullAllOptions): Promise<PullAllResult> {
  const { store, fetchImpl, getAuth, getFilters, pageSize = 500, maxPages = 50 } = opts;
  const auth = getAuth();
  if (!auth) throw new Error("no mem0 auth captured yet — run any mem0 read first");
  const filters = getFilters();
  if (!filters || Object.keys(filters).length === 0) {
    throw new Error("no mem0 filters captured yet — run any memory search first");
  }
  const baseFilters: Record<string, unknown> = { ...filters };
  for (const key of ["app_id", "agent_id", "run_id"]) delete baseFilters[key];
  const before = Object.keys(store.memories).length;
  let fetched = 0;
  let pages = 0;
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${auth.origin}/v3/memories/?page=${page}&page_size=${pageSize}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ filters: baseFilters }),
    });
    if (!res.ok) throw new Error(`getAll page ${page} HTTP ${res.status}`);
    const body = (await res.json()) as { results?: unknown[]; count?: number };
    const results = Array.isArray(body.results) ? body.results : [];
    pages++;
    fetched += results.length;
    if (typeof body.count === "number") total = body.count;
    if (results.length > 0) harvestMemories(store, JSON.stringify({ results }));
    // Stop when the page runs short OR the server-reported total is reached —
    // the server may clamp page_size below what we asked for.
    if (results.length < pageSize) break;
    if (total > 0 && fetched >= total) break;
  }
  return { pages, fetched, newHarvested: Object.keys(store.memories).length - before, total };
}

// ---------------------------------------------------------------------------
// Extension entry

export default function piMem0Cache(pi: ExtensionAPI): void {
  const storePath = process.env.MEM0_CACHE_PATH ?? DEFAULT_STORE_PATH;
  const ttlMs = Number(process.env.MEM0_CACHE_TTL_MS) > 0 ? Number(process.env.MEM0_CACHE_TTL_MS) : DEFAULT_TTL_MS;
  const remoteReadIntervalMs =
    Number(process.env.MEM0_CACHE_REMOTE_READ_INTERVAL_MS) > 0
      ? Number(process.env.MEM0_CACHE_REMOTE_READ_INTERVAL_MS)
      : DEFAULT_REMOTE_READ_INTERVAL_MS;
  const store = loadStore(storePath);
  const save = makeSaver(store, storePath);
  const shadowEnabled = process.env.MEM0_CACHE_SHADOW !== "0";
  const shadowPath = process.env.MEM0_CACHE_SHADOW_PATH ?? DEFAULT_SHADOW_PATH;
  const vectorsPath = process.env.MEM0_VECTORS_PATH ?? DEFAULT_VECTORS_PATH;
  const vecStore = loadVectorStore(vectorsPath);
  const saveVectors = makeVectorSaver(vecStore, vectorsPath);
  const embedder = createDefaultEmbedder();
  const embed = embedder ? createEmbedHarness(store, saveVectors, vecStore, embedder) : undefined;

  const g = globalThis as { fetch?: typeof fetch & { [WRAPPED]?: boolean } };
  const authRef: { current?: CapturedAuth } = {};
  const filtersRef: { current?: Record<string, unknown> } = {};
  // Capture the original fetch BEFORE wrapping so the sync runner's replayed
  // adds go straight to the network instead of re-entering the interceptor.
  const realFetch = g.fetch;
  const syncer = createSyncRunner({
    store,
    save,
    fetchImpl: (...args: Parameters<typeof fetch>) => {
      if (!realFetch) throw new Error("fetch unavailable");
      return realFetch(...args);
    },
    getAuth: () => authRef.current,
    onEvent: (msg) => console.warn(`[pi-mem0-cache] ${msg}`),
  });

  if (typeof g.fetch === "function" && !g.fetch[WRAPPED]) {
    const wrapped = createInterceptor(g.fetch, {
      store,
      save,
      ttlMs,
      remoteReadIntervalMs,
      authRef,
      shadowLog: shadowEnabled ? (entry) => appendShadowLog(shadowPath, entry) : undefined,
      embed,
      filtersRef,
      onFallback: (reason) => console.warn(`[pi-mem0-cache] ${reason}`),
      onPassthroughSuccess: () => {
        void syncer.maybeSync();
      },
    }) as typeof fetch & { [WRAPPED]?: boolean };
    wrapped[WRAPPED] = true;
    g.fetch = wrapped;
  }

  pi.registerCommand("mem0-cache", {
    description: "mem0 read cache: /mem0-cache [stats|sync|refresh|clear|clear-all|path|shadow|embed|pull-all]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim() || "stats";
      switch (sub) {
        case "stats": {
          const s = store.stats;
          const localCount = syncer.pendingCount();
          const sync = store.syncState.lastResult ? ` | last sync: ${store.syncState.lastResult}` : "";
          const blocked = store.netState.readsBlockedUntil;
          const gate =
            blocked !== undefined && Date.now() < blocked
              ? ` | reads blocked until ${new Date(blocked).toISOString()}`
              : store.netState.lastRemoteReadAt !== undefined
                ? ` | last remote read ${Math.round((Date.now() - store.netState.lastRemoteReadAt) / 60000)}min ago`
                : "";
          ctx.ui.notify(
            `mem0-cache: ${Object.keys(store.cache).length} cached reads, ` +
              `${localCount} pending local memories | hits ${s.hits}, misses ${s.misses}, ` +
              `passthroughs ${s.passthroughs}, stale ${s.staleServed}, fallbacks ${s.fallbacks}, ` +
              `localWrites ${s.localWrites}, gated ${s.gated}${sync}${gate}`,
            "info",
          );
          break;
        }
        case "refresh": {
          delete store.netState.lastRemoteReadAt;
          delete store.netState.readsBlockedUntil;
          save();
          ctx.ui.notify("mem0-cache: gates cleared — the next read hits the mem0 API", "info");
          break;
        }
        case "sync": {
          const r = await syncer.sync(true);
          ctx.ui.notify(
            r.skipped
              ? `mem0-cache sync: nothing to do (${r.pending} pending, ${authRef.current ? "backoff active or " : ""}${authRef.current ? "" : "no mem0 auth captured yet"})`
              : `mem0-cache sync: uploaded ${r.uploaded}, failed ${r.failed}, pending ${r.pending}`,
            "info",
          );
          break;
        }
        case "shadow": {
          const s = summarizeShadow(readShadowEntries(shadowPath));
          let msg =
            `mem0-cache shadow: ${s.comparisons} comparisons (${s.fallbacks} fallback) | ` +
            `overlap@5 ${s.meanOverlap5.toFixed(2)}/5, overlap@10 ${s.meanOverlap10.toFixed(2)}/10 | ` +
            `remote top-1 in local top-10: ${(s.top1Recall * 100).toFixed(0)}% | MRR ${s.meanMrr.toFixed(2)}`;
          if (s.vecComparisons > 0) {
            msg +=
              ` | vector: ${s.vecComparisons} comparisons, overlap@5 ${s.meanOverlapVec5.toFixed(2)}/5, ` +
              `top-1 recall ${(s.top1VecRecall * 100).toFixed(0)}%, MRR ${s.meanMrrVec.toFixed(2)}`;
          }
          ctx.ui.notify(msg, "info");
          break;
        }
        case "embed": {
          if (!embed) {
            ctx.ui.notify("mem0-cache embed: disabled — set JINA_API_KEY to enable (MEM0_EMBED=0 forces off)", "warning");
            break;
          }
          const s = embed.status();
          ctx.ui.notify(
            `mem0-cache embed: ${s.vectors}/${s.corpus} vectors | model ${s.model}` +
              `${s.lastError ? ` | last error: ${s.lastError}` : ""}` +
              `${s.cooldownUntil ? ` | cooling down until ${new Date(s.cooldownUntil).toISOString()}` : ""}`,
            "info",
          );
          break;
        }
        case "embed refresh": {
          if (!embed) {
            ctx.ui.notify("mem0-cache embed: disabled — set JINA_API_KEY to enable", "warning");
            break;
          }
          const msg = await embed.refresh();
          ctx.ui.notify(`mem0-cache embed refresh: ${msg}`, "info");
          break;
        }
        case "pull-all": {
          try {
            const r = await pullAllMemories({
              store,
              fetchImpl: (...args) => {
                if (!realFetch) throw new Error("fetch unavailable");
                return realFetch(...args);
              },
              getAuth: () => authRef.current ?? authFromEnv(),
              getFilters: () => filtersRef.current ?? filtersFromCache(store),
            });
            save();
            ctx.ui.notify(
              `mem0-cache pull-all: ${r.pages} pages, ${r.fetched} fetched, ${r.newHarvested} new ` +
                `(mirror ${Object.keys(store.memories).length}${r.total ? `/${r.total}` : ""})`,
              "info",
            );
            if (embed) {
              await embed.ensure();
              const s = embed.status();
              ctx.ui.notify(`mem0-cache pull-all: vectors ${s.vectors}/${s.corpus}`, "info");
            }
          } catch (err) {
            ctx.ui.notify(
              `mem0-cache pull-all failed: ${err instanceof Error ? err.message : String(err)}`,
              "warning",
            );
          }
          break;
        }
        case "clear":
          store.cache = {};
          save();
          ctx.ui.notify("mem0-cache: read cache cleared (local memories kept)", "info");
          break;
        case "clear-all":
          store.cache = {};
          store.memories = {};
          save();
          ctx.ui.notify("mem0-cache: cache and local memories cleared", "info");
          break;
        case "path":
          ctx.ui.notify(`mem0-cache store: ${storePath}`, "info");
          break;
        default:
          ctx.ui.notify("usage: /mem0-cache [stats|sync|refresh|clear|clear-all|path|shadow|embed|pull-all]", "warning");
      }
    },
  });
}
