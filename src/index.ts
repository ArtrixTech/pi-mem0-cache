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
 *
 * Local writes are NOT replayed to mem0 later — the local store remains
 * searchable via the read fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "mem0-cache.json");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMOTE_READ_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_429_BLOCK_MS = 5 * 60 * 1000;
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

export function searchLocal(store: Store, query: string, limit = MAX_FALLBACK_RESULTS): LocalMemory[] {
  const tokens = tokenize(query);
  const all = Object.values(store.memories).filter((m) => !m.deleted);
  if (tokens.length === 0) return all.slice(0, limit);
  const scored = all
    .map((m) => {
      const text = m.memory.toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
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
  const serveLocalRead = (req: ClassifiedRequest, cached?: CachedResponse): Response | null => {
    if (cached) return jsonResponse(JSON.parse(cached.body), cached.status);
    if (req.kind === "read-search") {
      return jsonResponse({ results: searchLocal(store, req.query ?? "").map(stripInternal) });
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
      return serveLocalRead(req, cached) ?? jsonResponse({ error: "not available locally (network gate active)" }, 404);
    }

    store.stats.misses++;
    let failed: Response | null = null;
    try {
      const res = await fetchImpl(input as string | URL | Request, init);
      if (res.ok) {
        const body = await res.clone().text();
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
    const localAnswer = serveLocalRead(req);
    if (localAnswer) {
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

  const g = globalThis as { fetch?: typeof fetch & { [WRAPPED]?: boolean } };
  const authRef: { current?: CapturedAuth } = {};
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
      onFallback: (reason) => console.warn(`[pi-mem0-cache] ${reason}`),
      onPassthroughSuccess: () => {
        void syncer.maybeSync();
      },
    }) as typeof fetch & { [WRAPPED]?: boolean };
    wrapped[WRAPPED] = true;
    g.fetch = wrapped;
  }

  pi.registerCommand("mem0-cache", {
    description: "mem0 read cache: /mem0-cache [stats|sync|refresh|clear|clear-all|path]",
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
          ctx.ui.notify("usage: /mem0-cache [stats|sync|refresh|clear|clear-all|path]", "warning");
      }
    },
  });
}
