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
 * Successful remote writes echo into the mirror (delete/update/delete-all
 * propagate; adds harvest from the response) and invalidate the read cache.
 * Writes that fall back locally are queued: adds replay on sync from their
 * original payload; update/delete/delete-all intents replay from an op log
 * in the order they were applied.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEXICAL_WEIGHT_DEFAULT,
  LexicalChannel,
  recall,
  type ChannelHit,
  type ChannelStatus,
  type FusedHit,
  type RecallChannel,
} from "./recall/fusion.js";
import { createDefaultReranker } from "./recall/rerank.js";
import { parseStrategy, resolveStrategy } from "./recall/plan.js";
import { extractScope, filterByScope, matchesScope, type ScopeFilters } from "./recall/scope.js";
import { clampMemory, harvestMemories, searchLocal, searchLocalScored } from "./memory.js";
import { cacheKey, classify } from "./request.js";
import { loadStore, makeSaver } from "./store.js";
import {
  DEFAULT_429_BLOCK_MS,
  DEFAULT_EMBED_MODEL,
  DEFAULT_MEM0_CONFIG_PATH,
  DEFAULT_REMOTE_READ_INTERVAL_MS,
  DEFAULT_SHADOW_PATH,
  DEFAULT_STORE_PATH,
  DEFAULT_TTL_MS,
  DEFAULT_VECTORS_PATH,
  EMBED_BATCH_CHARS,
  EMBED_BATCH_SIZE,
  EMBED_COOLDOWN_MS,
  EMBED_MAX_BATCHES_PER_CALL,
  EMBED_PROVIDERS,
  MAX_FALLBACK_RESULTS,
  SHADOW_KEEP_LINES,
  SHADOW_ROTATE_BYTES,
  WRAPPED,
} from "./types.js";
import type {
  CachedResponse,
  ClassifiedRequest,
  FetchInput,
  LocalMemory,
  LocalStrategy,
  PendingOp,
  Store,
} from "./types.js";

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
 * Successful remote writes echo into the mirror (delete/update/delete-all
 * propagate; adds harvest from the response) and invalidate the read cache.
 * Writes that fall back locally are queued: adds replay on sync from their
 * original payload; update/delete/delete-all intents replay from an op log
 * in the order they were applied.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";


// ---------------------------------------------------------------------------
// Local memory operations


// ---------------------------------------------------------------------------
// Local read strategies

/** Live corpus of a store, as BM25 docs. */
function liveDocs(store: Store): { id: string; text: string }[] {
  return Object.values(store.memories)
    .filter((m) => !m.deleted)
    .map((m) => ({ id: m.id, text: m.memory }));
}

/** Resolve an id list back to memories, dropping any that vanished or are
 *  tombstoned between ranking and response. */
function materialize(store: Store, ids: string[], limit: number): LocalMemory[] {
  const out: LocalMemory[] = [];
  for (const id of ids) {
    const m = store.memories[id];
    if (m && !m.deleted) out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** Rank the mirror for one query under the configured strategy.
 *
 * Scope filtering happens on the corpus *before* ranking, not on the result:
 * out-of-scope memories must never enter channel candidate pools, or the
 * reranker and the shadow log would both see data the request is not entitled
 * to. A tombstoned memory is dropped at the same point.
 *
 * Strategy resolution happens per call so a test-mode switch takes effect on the
 * next read. Every strategy is answerable: "dense"
 * degrades to "bm25" when the embed harness returns nothing, and
 * "fusion+rerank" degrades to "fusion" without a reranker, so no configuration
 * can leave local reads unanswerable.
 */
export async function rankLocal(
  store: Store,
  query: string,
  opts: {
    embed?: EmbedHarness;
    localStrategy?: LocalStrategy;
    reranker?: Reranker;
    scope?: ScopeFilters;
    /** Fusion weight for the lexical channel; see LEXICAL_WEIGHT_DEFAULT. */
    lexicalWeight?: number;
    onStrategy?: (info: { strategy: LocalStrategy; degraded?: string; channels: ChannelStatus[] }) => void;
  } = {},
  limit = MAX_FALLBACK_RESULTS,
): Promise<LocalMemory[]> {
  const requested = opts.localStrategy ?? "auto";

  // Resolve what can actually run before touching the corpus: the ladder reports
  // which plans were skipped and why, and it always lands on something servable.
  const resolution = resolveStrategy(requested, {
    // `enabled` is the harness' own health flag: it clears on a successful call
    // and sets on a failure with a cooldown, which is exactly the signal the
    // ladder needs to route around a dead embedding provider.
    dense: opts.embed !== undefined && opts.embed.status().enabled,
    rerank: opts.reranker !== undefined,
  });
  const plan = resolution.plan;

  if (plan.strategy === "legacy") {
    opts.onStrategy?.({ strategy: "legacy", channels: [] });
    return filterByScope(searchLocal(store, query, limit), opts.scope) as LocalMemory[];
  }

  // Scope the corpus once, then rank within it.
  const scoped = Object.values(store.memories).filter((m) => !m.deleted && matchesScope(m, opts.scope));
  const docs = scoped.map((m) => ({ id: m.id, text: m.memory }));

  const channels: RecallChannel[] = [];
  for (const name of plan.channels) {
    if (name === "lexical") {
      channels.push(new LexicalChannel({ docs, weight: opts.lexicalWeight ?? LEXICAL_WEIGHT_DEFAULT }));
    } else if (opts.embed) {
      channels.push(new EmbedHarnessChannel(opts.embed, scoped));
    }
  }

  // The resolver only admits a dense plan when the harness reports healthy, and
  // the harness can fail between that check and this call. The recall step drops a
  // throwing channel, so a plan that loses its only channel falls back here.
  if (channels.length === 0) {
    channels.push(new LexicalChannel({ docs, weight: opts.lexicalWeight ?? LEXICAL_WEIGHT_DEFAULT }));
  }

  const reranker =
    plan.rerank && opts.reranker
      ? (q: string, c: FusedHit[], textOf: (id: string) => string) => opts.reranker!(q, c, textOf)
      : undefined;

  const result = await recall({
    query,
    channels,
    perChannelLimit: 50,
    fusedLimit: limit,
    // Channels return ids; the reranker needs the document body. Resolving it
    // here keeps payload storage out of the channel implementations.
    documentText: (id) => store.memories[id]?.memory ?? "",
    reranker,
  });

  // Report the strategy that actually answered. A channel that failed mid-call
  // leaves a plan whose name no longer describes what produced the hits, and the
  // shadow log must record the truth.
  const survivors = result.status.filter((s) => s.ok).map((s) => s.name);
  const served = describeServed(survivors, result.reranked);
  const degraded =
    resolution.degraded ??
    (served !== plan.strategy
      ? `${plan.strategy} served as ${served}: ${result.status.filter((s) => !s.ok).map((s) => `${s.name} (${s.error ?? "failed"})`).join(", ")}`
      : undefined);

  opts.onStrategy?.({ strategy: served, ...(degraded ? { degraded } : {}), channels: result.status });
  const ids = result.hits.map((h) => h.id);
  return materialize(store, ids, limit);
}

/** Name the pipeline that produced a result, from its surviving channels and
 *  whether a rerank happened. A single surviving channel is named alone so a plan
 *  that lost a channel reports what genuinely served the read. */
function describeServed(survivors: string[], reranked: boolean): LocalStrategy {
  const hasLexical = survivors.includes("lexical");
  const hasDense = survivors.includes("dense");
  if (hasLexical && hasDense) return reranked ? "fusion+rerank" : "fusion";
  if (hasDense) return reranked ? "dense+rerank" : "dense";
  return "bm25";
}

/** Adapts the embedding harness' search to the channel interface.
 *
 * The harness ranks the whole mirror, so its result is intersected with the
 * scoped id set here — the harness predates scope filtering and is not trusted
 * to respect it. */
class EmbedHarnessChannel implements RecallChannel {
  readonly name = "dense";
  constructor(
    private embed: EmbedHarness,
    private allowed?: LocalMemory[],
  ) {}
  async search(query: string): Promise<ChannelHit[]> {
    const hits = await this.embed.search(query);
    if (!hits) throw new Error(this.embed.status().lastError ?? "embedding layer unavailable");
    const allowed = this.allowed ? new Set(this.allowed.map((m) => m.id)) : undefined;
    return hits.filter((h) => !allowed || allowed.has(h.m.id)).map((h) => ({ id: h.m.id, score: h.score }));
  }
}

/** Cross-encoder reranking of a fused candidate pool. */
/** Final reordering stage over the fused pool. Receives the fused hits and a
 *  resolver for their texts, and returns them in the new order. */
export type Reranker = (
  query: string,
  candidates: FusedHit[],
  textOf: (id: string) => string,
) => Promise<ChannelHit[]>;

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
      // The same bound harvest applies, applied here too. A 250,819-character add
      // payload reached the store through this path, then failed every upload
      // (mem0 rejected it with HTTP 400) and every embedding request.
      const clamped = clampMemory(memory, id);
      store.memories[id] = {
        id,
        memory: clamped.text,
        created_at: now,
        updated_at: now,
        source: "local",
        // The replay payload carries the clamped text, so the upload mem0 accepts
        // matches what the mirror holds.
        addPayload: { ...addPayload, memory: clamped.text, messages: undefined },
        ...(clamped.overflow ? { overflow: clamped.overflow } : {}),
      } as LocalMemory;
      if (clamped.overflow) store.stats.harvestDropped = (store.stats.harvestDropped ?? 0) + 1;
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
        // source stays as-is: a mirrored (observed) memory updated offline is
        // carried to the cloud by the queued op below, not by an add replay.
        if (!id.startsWith("local-")) {
          store.ops.push({ kind: "write-update", memoryId: id, bodyText: req.bodyText, at: Date.now() });
        }
        // local-* memories fold the edit into their pending add replay.
      } else {
        store.memories[id] = { id, memory: text ?? "", created_at: now, updated_at: now, source: "local" };
      }
      return { message: "Memory updated locally (mem0 API unavailable).", id };
    }
    case "write-delete": {
      const id = req.memoryId ?? "";
      if (store.memories[id]) store.memories[id].deleted = true;
      // Cloud ids queue a delete op even when never mirrored — the intent must
      // reach the server. local-* ids purge at sync without ever uploading.
      if (!id.startsWith("local-")) {
        store.ops.push({ kind: "write-delete", memoryId: id, at: Date.now() });
      }
      return { message: "Memory deleted locally (mem0 API unavailable)." };
    }
    case "write-delete-all": {
      for (const m of Object.values(store.memories)) m.deleted = true;
      store.ops.push({ kind: "write-delete-all", query: req.url.search, at: Date.now() });
      return { message: "Memories deleted locally (mem0 API unavailable)." };
    }
    default:
      return { message: "Handled locally (mem0 API unavailable)." };
  }
}

/** Propagate a confirmed-remote write into the mirror: delete/update/
 *  delete-all leave no harvestable trace in the response body, so without
 *  this echo the mirror would keep serving the mutated/deleted memories. */
export function applyRemoteWriteEcho(store: Store, req: ClassifiedRequest): void {
  const now = new Date().toISOString();
  if (req.kind === "write-update" && req.memoryId) {
    const id = req.memoryId;
    let text: string | undefined;
    try {
      const body = JSON.parse(req.bodyText ?? "{}") as { text?: unknown };
      if (typeof body.text === "string") text = body.text;
    } catch {
      /* ignore */
    }
    const existing = store.memories[id];
    if (existing) {
      if (text !== undefined) existing.memory = text;
      existing.updated_at = now;
    } else if (text !== undefined) {
      store.memories[id] = { id, memory: text, created_at: now, updated_at: now, source: "observed" };
    }
  } else if (req.kind === "write-delete" && req.memoryId) {
    const m = store.memories[req.memoryId];
    if (m) m.deleted = true;
  } else if (req.kind === "write-delete-all") {
    for (const m of Object.values(store.memories)) m.deleted = true;
  }
}

/** A confirmed-remote mutation carries newer state than any op queued offline
 *  for the same target; queued ops for it would replay stale intents. */
export function reconcileOps(store: Store, req: ClassifiedRequest): void {
  if (req.kind === "write-delete-all") {
    store.ops = [];
  } else if ((req.kind === "write-update" || req.kind === "write-delete") && req.memoryId) {
    const id = req.memoryId;
    store.ops = store.ops.filter((o) => o.memoryId !== id);
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
  /** BM25-only ranking side — the lexical floor, logged next to `local` (the
   *  legacy scorer) so the two compare on identical live traffic. */
  localBm25?: ShadowLocalHit[];
  overlapBm25_5?: number;
  overlapBm25_10?: number;
  mrrBm25?: number;
  /** Fused (lexical + dense, RRF) ranking side, stored as ids. */
  localFusion?: string[];
  overlapFusion5?: number;
  overlapFusion10?: number;
  mrrFusion?: number;
  /** Dense-only ranking side: the shipped default's retrieval stage. */
  localDense?: string[];
  overlapDense5?: number;
  overlapDense10?: number;
  mrrDense?: number;
  /** Dense followed by the reranker: the shipped default end to end. */
  localDenseRerank?: string[];
  overlapDenseRerank5?: number;
  overlapDenseRerank10?: number;
  mrrDenseRerank?: number;
  /** Query terms BM25 found nowhere in the corpus — a vocabulary-gap signal
   *  that separates "no lexical signal" from "lexical signal misranked". */
  unmatched?: string[];
  /** Per-channel failures observed while building this entry. */
  channelErrors?: Record<string, string>;
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
  /** Legacy keyword scorer (the `local` field). */
  meanOverlap5: number;
  meanOverlap10: number;
  meanMrr: number;
  perfect5Rate: number;
  top1Recall: number;
  /** Per-strategy rows, keyed by strategy name. Each carries its own comparison
   *  count, since a strategy that could not run on an entry is excluded rather
   *  than counted as zero. */
  strategies: Record<string, StrategySummary>;
}

export interface StrategySummary {
  comparisons: number;
  meanOverlap5: number;
  meanOverlap10: number;
  meanMrr: number;
  top1Rate: number;
}

/** How to read one strategy out of a shadow entry. Adding a strategy to the
 *  comparison table means adding a row here. */
const STRATEGY_ROWS: { name: string; ids: (e: ShadowEntry) => string[] | undefined; mrr: (e: ShadowEntry) => number | undefined }[] = [
  { name: "legacy", ids: (e) => e.local.map((h) => h.id), mrr: (e) => e.mrr },
  { name: "remote", ids: (e) => e.remote.map((h) => h.id), mrr: () => 1 },
  {
    name: "bm25",
    ids: (e) => e.localBm25?.map((h) => h.id),
    mrr: (e) => e.mrrBm25,
  },
  { name: "dense", ids: (e) => e.localDense ?? e.localVec?.map((h) => h.id), mrr: (e) => e.mrrDense ?? e.mrrVec },
  { name: "fusion", ids: (e) => e.localFusion, mrr: (e) => e.mrrFusion },
  { name: "dense+rerank", ids: (e) => e.localDenseRerank, mrr: (e) => e.mrrDenseRerank },
];

/** Summarise one strategy over the entries where it produced a ranking. */
function summarizeStrategy(remote: ShadowEntry[], row: (typeof STRATEGY_ROWS)[number]): StrategySummary {
  const eligible = remote.filter((e) => row.mrr(e) !== undefined);
  const n = eligible.length;
  const mean = (pick: (e: ShadowEntry) => number) => (n === 0 ? 0 : eligible.reduce((s, e) => s + pick(e), 0) / n);
  return {
    comparisons: n,
    // Derived from the recorded id list against remote's own list, so a
    // strategy's overlap is recomputable from the log alone.
    meanOverlap5: mean((e) => overlapWithRemote(row.ids(e) ?? [], e, 5)),
    meanOverlap10: mean((e) => overlapWithRemote(row.ids(e) ?? [], e, 10)),
    meanMrr: mean((e) => row.mrr(e) ?? 0),
    top1Rate: n === 0 ? 0 : eligible.filter((e) => (row.mrr(e) ?? 0) > 0).length / n,
  };
}

/** How many of the strategy's top-N ids appear in remote's list. */
function overlapWithRemote(ids: string[], entry: ShadowEntry, n: number): number {
  const remoteIds = new Set(entry.remote.map((h) => h.id));
  return ids.slice(0, n).filter((id) => remoteIds.has(id)).length;
}

export function summarizeShadow(entries: ShadowEntry[]): ShadowSummary {
  const remote = entries.filter((e) => e.mode === "remote");
  const n = remote.length;
  const mean = (pick: (e: ShadowEntry) => number) => (n === 0 ? 0 : remote.reduce((sum, e) => sum + pick(e), 0) / n);
  return {
    comparisons: n,
    fallbacks: entries.length - n,
    meanOverlap5: mean((e) => e.overlap5),
    meanOverlap10: mean((e) => e.overlap10),
    meanMrr: mean((e) => e.mrr),
    perfect5Rate: n === 0 ? 0 : remote.filter((e) => e.overlap5 >= 5).length / n,
    top1Recall: n === 0 ? 0 : remote.filter((e) => e.mrr > 0).length / n,
    strategies: Object.fromEntries(STRATEGY_ROWS.map((row) => [row.name, summarizeStrategy(remote, row)])),
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
/** Test mode: a single shadow entry records what *every* strategy would have
 *  answered, so strategies are compared on identical live traffic. The remote
 *  ranking is the shared ground truth; `served` names the one the agent saw. */
export interface ShadowStrategyRanking {
  /** ids in rank order (top 10), so any strategy can be scored post-hoc from the
   *  log without reproducing its internals. */
  ids: string[];
  overlap5: number;
  overlap10: number;
  mrr: number;
  /** Populated when the strategy could not run (provider down, etc.). */
  error?: string;
}

async function recordShadow(
  log: (entry: ShadowEntry) => void,
  mode: ShadowEntry["mode"],
  req: ClassifiedRequest,
  remoteBody: string | null,
  store: Store,
  embed?: EmbedHarness,
  /// Recorded alongside the other strategies so the shipped default's rerank
  /// stage is measured on live traffic. Absent means the dense+rerank side is
  /// simply not logged for this entry.
  reranker?: Reranker,
  lexicalWeight: number = LEXICAL_WEIGHT_DEFAULT,
): Promise<void> {
  const remote = remoteSearchHits(remoteBody);
  const query = req.query ?? "";
  // Log under the request's own scope: the shadow log must measure what this
  // read was entitled to see, not what a scope-free corpus would have returned.
  const scope = extractScope(req.bodyText, req.search);
  const scopedDocs = (): { id: string; text: string }[] =>
    Object.values(store.memories)
      .filter((m) => !m.deleted && matchesScope(m, scope))
      .map((m) => ({ id: m.id, text: m.memory }));
  const local = searchLocalScored(store, query, 10).map(({ m, score }) => ({ id: m.id, score }));
  const { overlap5, overlap10, mrr } = compareShadow(local, remote);
  const entry: ShadowEntry = {
    ts: Date.now(),
    mode,
    query: query.slice(0, 200),
    local,
    remote,
    overlap5,
    overlap10,
    mrr,
  };

  // BM25 ranking — the new lexical floor, logged on the same entry so the
  // legacy-vs-BM25 comparison comes from live traffic.
  const lexicalChannel = new LexicalChannel({ docs: scopedDocs() });
  const bm25Hits = lexicalChannel.search(query, 10) as ChannelHit[];
  const bm25Ids = bm25Hits.map((h) => h.id);
  if (bm25Ids.length > 0) {
    const bm = compareShadow(
      bm25Ids.map((id) => ({ id })),
      remote,
    );
    entry.localBm25 = bm25Ids.map((id, i) => ({ id, score: Number((bm25Hits[i].score ?? 0).toFixed(4)) }));
    entry.overlapBm25_5 = bm.overlap5;
    entry.overlapBm25_10 = bm.overlap10;
    entry.mrrBm25 = bm.mrr;
    entry.unmatched = lexicalChannel.unmatched(query).slice(0, 10);
  }

  // Fused ranking — what the fusion strategy would have served. Recorded as ids
  // so it survives any later scorer change.
  const denseDocs = embed ? Object.values(store.memories).filter((m) => !m.deleted && matchesScope(m, scope)) : [];
  if (embed) {
    try {
      const result = await recall({
        query,
        channels: [
          new LexicalChannel({ docs: scopedDocs(), weight: lexicalWeight }),
          new EmbedHarnessChannel(embed, denseDocs),
        ],
        perChannelLimit: 50,
        fusedLimit: 10,
      });
      const fusedIds = result.hits.map((h) => h.id);
      if (fusedIds.length > 0) {
        const f = compareShadow(
          fusedIds.map((id) => ({ id })),
          remote,
        );
        entry.localFusion = fusedIds;
        entry.overlapFusion5 = f.overlap5;
        entry.overlapFusion10 = f.overlap10;
        entry.mrrFusion = f.mrr;
      }
      const failed = result.status.filter((s) => !s.ok);
      if (failed.length > 0) {
        entry.channelErrors = Object.fromEntries(failed.map((s) => [s.name, s.error ?? "unknown"]));
      }
    } catch (err) {
      entry.channelErrors = { fusion: err instanceof Error ? err.message : String(err) };
    }
  }

  // The shipped default's own pipeline: dense alone, and dense reranked. Recorded
  // separately from fusion so the ladder's stages can be compared on live traffic
  // rather than only on the frozen gold set.
  if (embed) {
    try {
      const denseText = new Map(denseDocs.map((m) => [m.id, m.memory]));
      const denseOnly = await recall({
        query,
        channels: [new EmbedHarnessChannel(embed, denseDocs)],
        perChannelLimit: 50,
        fusedLimit: 10,
      });
      const denseIds = denseOnly.hits.map((h) => h.id);
      if (denseIds.length > 0) {
        const d = compareShadow(
          denseIds.map((id) => ({ id })),
          remote,
        );
        entry.localDense = denseIds;
        entry.overlapDense5 = d.overlap5;
        entry.overlapDense10 = d.overlap10;
        entry.mrrDense = d.mrr;
      }

      if (reranker) {
        const rr = await recall({
          query,
          channels: [new EmbedHarnessChannel(embed, denseDocs)],
          perChannelLimit: 50,
          fusedLimit: 10,
          documentText: (id) => denseText.get(id) ?? "",
          reranker: (q, c, textOf) => reranker(q, c, textOf),
        });
        const rrIds = rr.hits.map((h) => h.id);
        if (rrIds.length > 0) {
          const d = compareShadow(
            rrIds.map((id) => ({ id })),
            remote,
          );
          entry.localDenseRerank = rrIds;
          entry.overlapDenseRerank5 = d.overlap5;
          entry.overlapDenseRerank10 = d.overlap10;
          entry.mrrDenseRerank = d.mrr;
        }
      }
    } catch (err) {
      entry.channelErrors = { ...(entry.channelErrors ?? {}), dense: err instanceof Error ? err.message : String(err) };
    }
  }

  const vecRanked = embed ? await embed.search(query).catch(() => null) : null;
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
  /** Set once vectors are unit-length. Absent on older sidecars, which is what
   *  triggers the migration in ensureEmbeddings. */
  normalized?: boolean;
  updatedAt?: number;
}

export function emptyVectorStore(): VectorStore {
  // normalized: true — an empty store has nothing left to convert.
  return { model: "", dims: 0, vectors: {}, normalized: true };
}

export function loadVectorStore(path: string): VectorStore {
  try {
    if (!existsSync(path)) return emptyVectorStore();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VectorStore>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      dims: typeof parsed.dims === "number" ? parsed.dims : 0,
      vectors: parsed.vectors ?? {},
      // Absent on a sidecar written before vectors were normalised at write time,
      // which is the signal ensureEmbeddings uses to run the migration.
      ...(parsed.normalized === true ? { normalized: true } : {}),
      ...(typeof parsed.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
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
  return createOpenAiCompatEmbedder({
    apiKey,
    model,
    endpoint: process.env.MEM0_EMBED_ENDPOINT ?? "https://api.jina.ai/v1/embeddings",
    label: "embeddings",
    fetchImpl,
  });
}

/**
 * Any OpenAI-compatible /v1/embeddings provider (Jina, OpenRouter, Voyage,
 * local Ollama, …). The wire shape is identical across all of them: POST
 * {model, input: string[]} -> {data: [{embedding, index}]}. Provider choice is
 * therefore configuration, not code — which is what makes the provider swap and
 * the test-mode A/B a config change alone.
 */
export interface OpenAiCompatEmbedderOptions {
  apiKey: string;
  model: string;
  endpoint: string;
  /** Prefix for thrown error messages, e.g. "openrouter". */
  label?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Per-input character cap; see createOpenAiCompatEmbedder. */
  maxInputChars?: number;
}

export function createOpenAiCompatEmbedder(opts: OpenAiCompatEmbedderOptions): Embedder {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const label = opts.label ?? "embeddings";
  // 45s rather than 15s: an 8B embedding model over a batch of long CJK memories
  // takes materially longer than the 239M model the old default was tuned for.
  const timeoutMs = opts.timeoutMs ?? 45_000;
  // Per-input character cap. The provider rejects an oversized input with HTTP
  // 400 and the whole batch fails, so a single long memory could stall the layer
  // permanently. Truncating here means the worst case is a poorer embedding for
  // one memory rather than no embeddings for any of them.
  const maxInputChars = opts.maxInputChars ?? 8000;
  return {
    model: opts.model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const input = texts.map((t) => (t.length > maxInputChars ? t.slice(0, maxInputChars) : t));
      const res = await fetchImpl(opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // Surface the provider's own message: a bare status code is what let a
        // 403 "insufficient balance" sit unnoticed for nine days.
        const body = await res.clone().text().catch(() => "");
        throw new Error(`${label} ${res.status}: ${body.slice(0, 200) || "no body"}`);
      }
      const parsed = (await res.json()) as { data?: { embedding?: unknown; index?: number }[] };
      const data = Array.isArray(parsed.data) ? [...parsed.data] : [];
      data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vecs = data.map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : null));
      if (vecs.length === 0 || vecs.some((v) => !v || v.length === 0)) {
        throw new Error(`${label}: malformed response body`);
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
  // Assumes unit-normalised inputs; see normaliseVectorsBelow.
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function searchLocalVector(
  queryVec: number[],
  corpus: LocalMemory[],
  vectors: Record<string, VectorRecord>,
  limit = MAX_FALLBACK_RESULTS,
): { m: LocalMemory; score: number }[] {
  // The query vector is normalised once here; the corpus vectors were normalised
  // when they were written. Normalising inside `cosine` meant re-normalising every
  // 4096-dimension corpus vector on every query — about 18M redundant
  // multiplications across a 4395-memory corpus, which is what made a dense read
  // take seconds.
  const q = normalizeVec(queryVec);
  const scored: { m: LocalMemory; score: number }[] = [];
  for (const m of corpus) {
    const v = vectors[m.id]?.vec;
    if (!v) continue;
    const score = cosine(q, v);
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Embed corpus entries incrementally: new/changed texts only, stale vectors
 *  for deleted memories pruned, model mismatch wipes the store. Throws on
 *  provider failure — callers decide cooldown policy. */
export interface EnsureProgress {
  /** Texts embedded in this call. */
  embedded: number;
  /** Live memories in the corpus. */
  corpus: number;
  /** Batches that failed and were skipped; the next call retries them. */
  failedBatches: number;
  /** Batches attempted in this call. A call where every batch failed is a
   *  persistent provider failure rather than a few unlucky inputs. */
  batches?: number;
  /** Targets still lacking a vector once this call finished. Zero means the
   *  sidecar covers the corpus. */
  remaining: number;
  /** True when this call also converted the sidecar to unit-length vectors. */
  migratedNormalization?: boolean;
  /** First error seen, for the health report. */
  firstError?: string;
}

/**
 * Bring the vector sidecar up to date with the corpus.
 *
 * WHY THIS IS BATCH-WISE AND RESUMABLE
 * The first version embedded every stale memory in chunks of 256 and wrote the
 * sidecar once at the end. Two failures compounded: 256 x ~250 chars is roughly
 * 18K tokens in one request, which exceeded the 15s per-request timeout, and the
 * all-or-nothing write meant every timeout discarded the whole run. A 4386-memory
 * corpus therefore never converged — the embedding layer reported 0 vectors on
 * every call and the pipeline silently served BM25.
 *
 * Three changes fix it. Batches are small enough to finish inside the timeout. Each
 * successful batch is persisted immediately, so progress survives a later failure.
 * A failed batch is recorded and skipped rather than aborting the run, so one
 * oversized memory cannot block the other 4385.
 *
 * A fourth change bounds the call. A full 4386-memory backfill at ~9s per batch is
 * roughly ten minutes of wall time, and the first version ran all of it inside one
 * `await` — long enough to block a session, and long enough to be killed by a
 * caller with its own deadline. `maxBatches` caps the work per call: each call
 * advances coverage by a bounded amount and the next call resumes from the
 * sidecar, so a large corpus converges over several calls while every call returns
 * promptly.
 */
export async function ensureEmbeddings(
  store: Store,
  vecStore: VectorStore,
  embedder: Embedder,
  opts: { save?: () => void; batchSize?: number; maxBatches?: number } = {},
): Promise<EnsureProgress> {
  const migratedNormalization = vecStore.normalized !== true;
  if (vecStore.model !== embedder.model) {
    vecStore.vectors = {};
    vecStore.model = embedder.model;
    vecStore.dims = 0;
  }
  // One-time migration to unit-length vectors. An earlier version stored raw
  // provider output and normalised inside `cosine`, which re-normalised every
  // corpus vector on every query. Detecting it by measuring one vector costs a few
  // thousand multiplications once; normalising inside the comparison cost about
  // 18M per query.
  let migrated = 0;
  if (vecStore.normalized !== true) {
    for (const rec of Object.values(vecStore.vectors)) {
      if (rec.vec?.length) rec.vec = normalizeVec(rec.vec);
      migrated++;
    }
    vecStore.normalized = true;
    if (migrated > 0) opts.save?.();
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
  const remaining = targets.length;
  if (remaining === 0) {
    return { embedded: 0, corpus: live.length, failedBatches: 0, batches: 0, remaining: 0, migratedNormalization };
  }

  const batchSize = opts.batchSize ?? EMBED_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? EMBED_MAX_BATCHES_PER_CALL;
  let embedded = 0;
  let failedBatches = 0;
  let firstError: string | undefined;

  // Group by input count and character budget, whichever trips first.
  const batches: LocalMemory[][] = [];
  for (const m of targets) {
    const current = batches[batches.length - 1];
    const currentChars = current ? current.reduce((s, x) => s + x.memory.length, 0) : 0;
    if (!current || current.length >= batchSize || currentChars + m.memory.length > EMBED_BATCH_CHARS) {
      batches.push([m]);
    } else {
      current.push(m);
    }
  }

  const todo = batches.slice(0, maxBatches);
  for (let i = 0; i < todo.length; i++) {
    const batch = todo[i];
    try {
      const vecs = await embedder.embed(batch.map((m) => m.memory));
      batch.forEach((m, j) => {
        // Normalise at write time so a lookup is a plain dot product: the corpus
        // vectors are read far more often than they are written.
        vecStore.vectors[m.id] = { hash: textHash(m.memory), vec: normalizeVec(vecs[j]) };
      });
      vecStore.dims = vecs[0]?.length ?? vecStore.dims;
      vecStore.updatedAt = Date.now();
      embedded += batch.length;
      // Persist per batch: a later timeout must not discard completed work.
      opts.save?.();
    } catch (err) {
      failedBatches++;
      firstError = firstError ?? (err instanceof Error ? err.message : String(err));
      // Back off after a failure: a burst of failed batches usually means the
      // provider is rate limiting, and retrying immediately deepens it.
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    embedded,
    corpus: live.length,
    failedBatches,
    batches: todo.length,
    remaining: remaining - embedded,
    migratedNormalization,
    ...(firstError ? { firstError } : {}),
  };
}

/** Interceptor-facing embedding harness: never throws, answers null when the
 *  provider is unavailable, and cools down for a minute after any failure. */
export interface EmbedHarness {
  ensure(): Promise<void>;
  /** Vector ranking for one query, or null when unavailable. */
  search(query: string): Promise<{ m: LocalMemory; score: number }[] | null>;
  status(): {
    enabled: boolean;
    model: string;
    vectors: number;
    corpus: number;
    lastError?: string;
    lastProgress?: { embedded: number; failedBatches: number; remaining: number };
    cooldownUntil?: number;
  };
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
  /** Whether the last failure was persistent (corpus-level) or transient
   *  (this read's query embedding). Only a persistent failure disables the layer:
   *  a query embedding is one network round trip, and a single blip must not route
   *  the next read to BM25. */
  let errorKind: "none" | "transient" | "persistent" = "none";
  const fail = (err: unknown, kind: "transient" | "persistent" = "persistent"): void => {
    lastError = err instanceof Error ? err.message : String(err);
    errorKind = kind;
    if (kind === "persistent") cooldownUntil = Date.now() + EMBED_COOLDOWN_MS;
  };
  let ensurePromise: Promise<void> | null = null;
  /** Query embeddings, keyed by query text. An agent re-issues similar queries
   *  constantly, and a query embedding is a 1-5s network round trip, so a repeat
   *  should not pay for it twice. Bounded so a long session cannot grow it
   *  without limit. */
  const queryCache = new Map<string, number[]>();
  const QUERY_CACHE_MAX = 256;
  /**
   * Embed one query.
   *
   * Kept separate from `ensure()` on purpose. The corpus backfill and a query
   * embedding fail for different reasons and deserve different responses: a
   * corpus failure means the layer cannot work at all, while a query failure —
   * measured at 1.3s to 5.0s against a 45s ceiling, so genuine timeouts are rare —
   * should degrade this one read and leave the layer usable for the next one. A
   * shared `fail()` call meant a single network blip disabled dense retrieval for
   * a full minute.
   */
  const embedQuery = async (query: string): Promise<number[] | null> => {
    const hit = queryCache.get(query);
    if (hit) return hit;
    try {
      const [vec] = await embedder.embed([query]);
      if (!vec) return null;
      const unit = normalizeVec(vec);
      if (queryCache.size >= QUERY_CACHE_MAX) {
        // Drop the oldest insertion; Map preserves insertion order.
        const oldest = queryCache.keys().next().value;
        if (oldest !== undefined) queryCache.delete(oldest);
      }
      queryCache.set(query, unit);
      return unit;
    } catch (err) {
      lastError = `query embedding failed: ${err instanceof Error ? err.message : String(err)}`;
      errorKind = "transient";
      return null;
    }
  };
  /** Coverage reached by the last ensure, for the status report. */
  let lastProgress: { embedded: number; failedBatches: number; remaining: number } | undefined;
  const ensure = (): Promise<void> => {
    // One in-flight backfill at a time: onPassthroughSuccess fires on every
    // successful mem0 call, and overlapping runs would re-embed the same targets.
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      if (Date.now() < cooldownUntil) return;
      try {
        const r = await ensureEmbeddings(store, vecStore, embedder, { save: saveVectors });
        lastProgress = { embedded: r.embedded, failedBatches: r.failedBatches, remaining: r.remaining };
        // Partial success is the normal path while a large corpus backfills, so a
        // few failed batches are recorded rather than treated as a dead layer. A
        // call where EVERY batch failed is the opposite case: the provider is not
        // answering at all, and retrying each read would waste a request every
        // time. ensureEmbeddings catches per batch, so this is the only place the
        // distinction can be drawn.
        if (r.failedBatches === 0) {
          lastError = undefined;
          errorKind = "none";
        } else if (r.failedBatches >= (r.batches ?? r.failedBatches)) {
          fail(`all ${r.failedBatches} batch(es) failed: ${r.firstError ?? "unknown"}`);
        } else {
          lastError = `${r.failedBatches} batch(es) failed: ${r.firstError ?? "unknown"}`;
          if (errorKind === "none") errorKind = "persistent";
        }
        // Keep going in the background while coverage is incomplete: each call is
        // bounded, so a large first backfill finishes over several rounds instead
        // of holding a session open for ten minutes. `void` because the search that
        // triggered this must not wait for the whole corpus.
        if (r.remaining > 0 && r.failedBatches === 0) {
          void (async () => {
            // Yield first so the caller's own await resolves with partial coverage
            // available rather than after another full round.
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (ensurePromise === null) void ensure();
          })();
        }
      } catch (err) {
        fail(err);
      }
    })().finally(() => {
      ensurePromise = null;
    });
    return ensurePromise;
  };
  const search = async (query: string): Promise<{ m: LocalMemory; score: number }[] | null> => {
    if (Date.now() < cooldownUntil) return null;
    try {
      await ensure();
      const withVec = Object.values(store.memories).filter((m) => !m.deleted && vecStore.vectors[m.id]);
      if (withVec.length === 0) return null;
      const queryVec = await embedQuery(query);
      if (!queryVec) return null;
      const ranked = searchLocalVector(queryVec, withVec, vecStore.vectors);
      // Clear only a prior transient query failure. A persistent error is cleared
      // by the backfill succeeding, not by one query working.
      if (errorKind === "transient") {
        lastError = undefined;
        errorKind = "none";
      }
      return ranked;
    } catch (err) {
      // A corpus-embedding failure is persistent (bad key, exhausted quota) and
      // disables the layer. A query failure is transient, and the two paths are
      // separated: `embedQuery` reports its own failure without a cooldown.
      fail(err);
      return null;
    }
  };
  const status = () => ({
    // Enabled means the layer can be asked for a ranking, not that vectors are
    // already on disk: the first search triggers the backfill. Reporting
    // enabled=false on an empty sidecar would route every read to BM25 for the
    // whole first backfill. A failed call or an active cooldown is what disables
    // it, and `search()` returns null when the corpus genuinely has no vectors.
    enabled: Date.now() >= cooldownUntil && errorKind !== "persistent",
    model: embedder.model,
    vectors: Object.keys(vecStore.vectors).length,
    corpus: Object.values(store.memories).filter((m) => !m.deleted).length,
    lastError,
    lastProgress,
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

/** Default provider selection, in order: MEM0_EMBED_PROVIDER, then any provider
 *  whose API key is present (openrouter before jina, since one key covers both
 *  embed and rerank), then `jinaApiKey` from mem0-config.json. MEM0_EMBED=0
 *  forces the whole layer off. */
export function createDefaultEmbedder(): Embedder | undefined {
  if (process.env.MEM0_EMBED === "0") return undefined;
  const explicit = process.env.MEM0_EMBED_PROVIDER;
  const order = explicit ? [explicit] : ["openrouter", "jina"];
  for (const name of order) {
    const preset = EMBED_PROVIDERS[name];
    if (!preset) continue;
    const apiKey = resolveProviderKey(name);
    if (!apiKey) continue;
    return createOpenAiCompatEmbedder({
      apiKey,
      model: process.env.MEM0_EMBED_MODEL ?? preset.model,
      endpoint: process.env.MEM0_EMBED_ENDPOINT ?? preset.endpoint,
      label: name,
    });
  }
  // Last resort: the Jina key stored next to the mem0 key, so a terminal that
  // never sourced ~/.zshrc still gets embedding.
  const configKey = readJinaKeyFromConfig(process.env.MEM0_CONFIG_PATH);
  if (configKey) {
    const jina = EMBED_PROVIDERS.jina;
    return createOpenAiCompatEmbedder({
      apiKey: configKey,
      model: process.env.MEM0_EMBED_MODEL ?? jina.model,
      endpoint: process.env.MEM0_EMBED_ENDPOINT ?? jina.endpoint,
      label: "jina(config)",
    });
  }
  return undefined;
}

export function readJinaKeyFromConfig(path = DEFAULT_MEM0_CONFIG_PATH): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { jinaApiKey?: unknown };
    return typeof parsed.jinaApiKey === "string" && parsed.jinaApiKey ? parsed.jinaApiKey : undefined;
  } catch {
    return undefined;
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
  /** Receives one ShadowEntry per read-search miss (remote or fallback-served). */
  shadowLog?: (entry: ShadowEntry) => void;
  /** Embedding harness: semantic ranking of the mirror for gated/fallback
   *  reads; null results degrade to the keyword ranking. */
  embed?: EmbedHarness;
  /** Shared cell capturing the client's most recent read filters (user_id, …) —
   *  pull-all reuses them minus entity-scoping keys. */
  filtersRef?: { current?: Record<string, unknown> };
  /** Test mode: when set, local reads are served by the named strategy instead
   *  of the default fusion, and every served read is written to the shadow log
   *  with the strategy that produced it — so strategies can be compared on real
   *  traffic without changing what the agent sees mid-session. */
  localStrategy?: LocalStrategy;
  /** Cross-encoder reranking of the fused pool. Enabled with the
   *  "fusion+rerank" and "dense+rerank" strategies; absent means those degrade. */
  reranker?: Reranker;
  /** Fusion weight for the lexical channel; see LEXICAL_WEIGHT_DEFAULT. */
  lexicalWeight?: number;
  /** Enable per-strategy shadow comparison on every read-search miss. */
  testMode?: boolean;
}

/** How a local (non-network) search read is answered. */
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
      const ranked: LocalMemory[] = await rankLocal(
        store,
        req.query ?? "",
        {
          embed: opts.embed,
          localStrategy: opts.localStrategy,
          reranker: opts.reranker,
          lexicalWeight: opts.lexicalWeight,
          scope: extractScope(req.bodyText, req.search),
          onStrategy: (info) => {
            store.stats.lastStrategy = info.strategy;
            if (info.degraded) {
              store.stats.lastStrategyDegraded = info.degraded;
              onFallback?.(
                `local read strategy "${opts.localStrategy ?? "fusion"}" degraded to "${info.strategy}": ${info.degraded}`,
              );
            }
            const failed = info.channels.filter((c) => !c.ok);
            for (const c of failed) onFallback?.(`recall channel ${c.name} failed: ${c.error ?? "unknown"}`);
          },
        },
      );
      return jsonResponse({ results: ranked.map(stripInternal) });
    }
    if (req.kind === "read-getall") {
      // Scope-filtered: a project-scoped getAll must not return another
      // project's memories. See src/recall/scope.ts for the filtering rule.
      const scope = extractScope(req.bodyText, req.search);
      const all = Object.values(store.memories)
        .filter((m) => !m.deleted && matchesScope(m, scope))
        .map(stripInternal);
      return jsonResponse({ results: all, count: all.length });
    }
    if (req.kind === "read-get" && req.memoryId) {
      const scope = extractScope(req.bodyText, req.search);
      const m = store.memories[req.memoryId];
      if (m && !m.deleted && matchesScope(m, scope)) return jsonResponse(stripInternal(m));
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
          // Harvest the write response (v3 add returns the created memory) so
          // the mirror tracks newly written memories organically.
          const body = await res.clone().text().catch(() => "");
          if (body) harvestMemories(store, body);
          applyRemoteWriteEcho(store, req);
          reconcileOps(store, req);
          // Every cached read predates this mutation.
          store.cache = {};
          store.stats.passthroughs++;
          opts.onPassthroughSuccess?.();
          save();
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
      // The mirror just changed — cached reads predate the mutation.
      store.cache = {};
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
          await recordShadow(opts.shadowLog, "remote", req, body, store, opts.embed, opts.reranker, opts.lexicalWeight);
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
        await recordShadow(opts.shadowLog, "fallback", req, null, store, opts.embed, opts.reranker, opts.lexicalWeight);
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
  /** Called once when an item is retired from the queue after repeated
   *  permanent failures, so the operator learns a memory did not sync. */
  onQuarantine?: (id: string, reason: string) => void;
  /** Backoff after a failed sync attempt (default 1h). */
  backoffMs?: number;
}

/** Attempts before a permanently-rejected item leaves the queue. A payload the
 *  server answers with 400/404/422 will answer the same way next time, so
 *  three tries is enough to conclude the answer is final. */
export const MAX_SYNC_FAILURES = 3;

/**
 * Whether a rejection can succeed on retry.
 *
 * The distinction decides the response: a permanent rejection is counted and
 * eventually retired, while a transient one keeps its place and arms backoff.
 * Retrying a 400 forever costs a request per run and never converges, and
 * retiring a 500 discards a memory the server would accept moments later.
 */
function isPermanentStatus(status: number): boolean {
  if (status === 408 || status === 429) return false; // timeout / rate limited
  if (status >= 500) return false;
  return status >= 400;
}

type ReplayOutcome = { ok: true } | { ok: false; permanent: boolean; reason: string };

export interface SyncResult {
  uploaded: number;
  failed: number;
  skipped: boolean;
  /** Pending work remaining: local adds + queued ops, excluding quarantined. */
  pending: number;
  appliedOps: number;
  /** Requests attempted in this run. */
  attempts: number;
  /** Items retired this run after repeated permanent failures. */
  quarantined: string[];
}

const DEFAULT_SYNC_BACKOFF_MS = 60 * 60 * 1000;

export function createSyncRunner(opts: SyncRunnerOptions) {
  const { store, save, fetchImpl, getAuth, onEvent } = opts;
  const backoffMs = opts.backoffMs ?? DEFAULT_SYNC_BACKOFF_MS;
  let inFlight: Promise<SyncResult> | null = null;

  const pendingList = () =>
    Object.values(store.memories).filter(
      (m) => m.source === "local" && !m.deleted && !store.syncState.quarantined?.[m.id],
    );
  const pendingTotal = () => pendingList().length + store.ops.length;
  const quarantine = (id: string, reason: string): void => {
    store.syncState.quarantined = { ...(store.syncState.quarantined ?? {}), [id]: { reason, at: Date.now() } };
    delete store.syncState.failures?.[id];
    onEvent?.(`sync: retired ${id} after ${MAX_SYNC_FAILURES} permanent failures (${reason})`);
    opts.onQuarantine?.(id, reason);
  };

  /** Record a permanent failure and retire the item once it has had enough
   *  attempts. Returns true when this failure retired it. */
  const notePermanentFailure = (id: string, reason: string): boolean => {
    const failures = { ...(store.syncState.failures ?? {}) };
    const count = (failures[id] ?? 0) + 1;
    failures[id] = count;
    store.syncState.failures = failures;
    if (count >= MAX_SYNC_FAILURES) {
      quarantine(id, reason);
      return true;
    }
    return false;
  };

  async function replayAdd(m: LocalMemory, auth: CapturedAuth): Promise<ReplayOutcome> {
    const payload = { ...(m.addPayload ?? {}), messages: [{ role: "user", content: m.memory }] };
    try {
      const res = await fetchImpl(`${auth.origin}/v3/memories/add/`, {
        method: "POST",
        headers: { ...auth.headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = `HTTP ${res.status}`;
        const bodyText = await res.text().catch(() => "");
        return isPermanentStatus(res.status)
          ? { ok: false, permanent: true, reason: `HTTP ${res.status}${bodyText ? ` ${bodyText.slice(0, 120)}` : ""}` }
          : { ok: false, permanent: false, reason: `HTTP ${res.status}` };
      }
      harvestMemories(store, await res.text().catch(() => ""));
      m.source = "observed";
      delete m.addPayload;
      return { ok: true };
    } catch {
      return { ok: false, permanent: false, reason: "network error" };
    }
  }

  /** Replay one queued write intent. 404 counts as applied: the server-side
   *  goal state (updated/gone) is unreachable because the target is gone —
   *  the mirror converges by dropping its copy. */
  async function replayOp(op: PendingOp, auth: CapturedAuth): Promise<ReplayOutcome> {
    const headers = { ...auth.headers, "content-type": "application/json" };
    const classify = (res: Response): ReplayOutcome =>
      isPermanentStatus(res.status)
        ? { ok: false, permanent: true, reason: `HTTP ${res.status}` }
        : { ok: false, permanent: false, reason: `HTTP ${res.status}` };
    try {
      if (op.kind === "write-update" && op.memoryId) {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.memoryId}/`, {
          method: "PUT",
          headers,
          body: op.bodyText ?? "{}",
        });
        if (!res.ok && res.status !== 404) return classify(res);
        if (res.status === 404) delete store.memories[op.memoryId];
      } else if (op.kind === "write-delete" && op.memoryId) {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.memoryId}/`, { method: "DELETE", headers });
        if (!res.ok && res.status !== 404) return classify(res);
        delete store.memories[op.memoryId]; // server-gone: drop the tombstone
      } else if (op.kind === "write-delete-all") {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.query ?? ""}`, { method: "DELETE", headers });
        if (!res.ok && res.status !== 404) return classify(res);
        for (const m of Object.values(store.memories)) if (m.deleted) delete store.memories[m.id];
      }
      store.ops = store.ops.filter((o) => o !== op);
      return { ok: true };
    } catch {
      return { ok: false, permanent: false, reason: "network error" };
    }
  }

  async function sync(force = false): Promise<SyncResult> {
    // Locally-created memories deleted before ever syncing never reached the
    // cloud — purge them outright.
    for (const m of Object.values(store.memories)) {
      if (m.source === "local" && m.deleted) delete store.memories[m.id];
    }

    const pending = pendingList();
    const auth = getAuth();
    if ((pending.length === 0 && store.ops.length === 0) || !auth) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] };
    }
    const now = Date.now();
    if (!force && store.syncState.backoffUntil && now < store.syncState.backoffUntil) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] };
    }
    store.syncState.lastAttemptAt = now;

    // Replay in the order the writes happened locally: adds (created_at) and
    // queued ops (at) merge into one chronological queue, so a delete-all
    // recorded before a later add replays before it.
    const queue: { at: number; kind: "add" | "op"; id: string; run: () => Promise<ReplayOutcome> }[] = [
      ...pending.map((m) => ({
        at: Date.parse(m.created_at) || 0,
        kind: "add" as const,
        id: m.id,
        run: () => replayAdd(m, auth),
      })),
      ...store.ops.map((op) => ({
        at: op.at,
        kind: "op" as const,
        id: op.memoryId ?? `op-${op.at}`,
        run: () => replayOp(op, auth),
      })),
    ].sort((a, b) => a.at - b.at);

    let uploaded = 0;
    let appliedOps = 0;
    let failed = 0;
    let attempts = 0;
    const retired: string[] = [];
    let sawTransient = false;
    for (const item of queue) {
      attempts++;
      const outcome = await item.run();
      if (outcome.ok) {
        if (item.kind === "add") uploaded++;
        else appliedOps++;
        continue;
      }
      failed++;
      if (outcome.permanent) {
        // Retire only the item the server refuses. Every item behind it still
        // gets its attempt: one unacceptable payload used to stop the whole
        // queue, which left four ordinary memories unsynced indefinitely.
        if (item.kind === "add" && notePermanentFailure(item.id, outcome.reason)) retired.push(item.id);
        else if (item.kind === "op") notePermanentFailure(item.id, outcome.reason);
        continue;
      }
      // Transient: the server is unhappy with the run, not the payload. Stop
      // here and back off rather than issuing the rest against a failing host.
      sawTransient = true;
      store.syncState.backoffUntil = Date.now() + backoffMs;
      onEvent?.(`sync paused after a failed replay; retrying after backoff`);
      break;
    }
    if (sawTransient) {
      // cleared below only when nothing transient happened
    } else if (uploaded > 0 || appliedOps > 0) {
      store.syncState.backoffUntil = 0;
    }
    store.syncState.lastResult = `uploaded ${uploaded}, ops applied ${appliedOps}, failed ${failed}, pending ${pendingTotal()}${retired.length ? `, retired ${retired.length}` : ""}`;
    save();
    if (uploaded > 0 || appliedOps > 0 || failed > 0) {
      onEvent?.(`sync: ${store.syncState.lastResult}`);
    }
    return { uploaded, failed, skipped: false, pending: pendingTotal(), appliedOps, attempts, quarantined: retired };
  }

  /** Fire-and-forget; dedupes concurrent runs. Returns null when nothing to do. */
  function maybeSync(): Promise<SyncResult> | null {
    if (inFlight) return inFlight;
    if (pendingList().length === 0 && store.ops.length === 0) return null;
    inFlight = sync(false)
      .catch(() => ({ uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { sync, maybeSync, pendingCount: () => pendingList().length, pendingOps: () => store.ops.length };
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
    // Key format: "METHOD <path> <body-json>" — the JSON body may contain
    // spaces (raw query text), so rejoin everything after the path.
    const parts = key.split(" ");
    if (parts.length < 3) continue;
    try {
      const parsed = JSON.parse(parts.slice(2).join(" ")) as { filters?: Record<string, unknown> };
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

/** Keychain service name per provider, written by scripts/setup-key.sh. */
export const KEYCHAIN_SERVICES: Record<string, string> = {
  openrouter: "pi-mem0-cache.openrouter",
  jina: "pi-mem0-cache.jina",
  mem0: "pi-mem0-cache.mem0",
};

/**
 * Read a secret from the macOS Keychain.
 *
 * Keys stored this way never appear in a shell export, a dotfile, a process
 * argument, or a repo — `security -w` prints the value on stdout, so it is read
 * as a buffer and never echoed. Returns undefined when the entry is missing or
 * the platform has no keychain, so every caller keeps an env fallback.
 */
export function readKeyFromKeychain(service: string): string | undefined {
  // Tests must be able to run without reading the machine's real credentials:
  // a developer with a live key in the keychain would otherwise get a different
  // code path than CI. Set MEM0_KEYCHAIN=0 to disable all keychain reads.
  if (process.env.MEM0_KEYCHAIN === "0") return undefined;
  if (!service) return undefined;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const trimmed = String(out).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a provider's API key: environment first, then the Keychain. An empty
 *  env var counts as absent, so `export OPENROUTER_API_KEY=` cannot mask a
 *  keychain key. */
export function resolveProviderKey(provider: string): string | undefined {
  const preset = EMBED_PROVIDERS[provider];
  const envName = preset?.keyEnv ?? `${provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const service = KEYCHAIN_SERVICES[provider];
  return service ? readKeyFromKeychain(service) : undefined;
}

/** Parse a strategy name from env, ignoring unknown values. */
export function readStrategy(value: string | undefined): LocalStrategy | undefined {
  return parseStrategy(value) as LocalStrategy | undefined;
}

/** Fusion weight for the lexical channel, from MEM0_FUSION_BM25_WEIGHT.
 *  1 restores equal weighting; the default is the gold-set-derived value. */
export function readLexicalWeight(value: string | undefined): number {
  if (value === undefined || value === "") return LEXICAL_WEIGHT_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : LEXICAL_WEIGHT_DEFAULT;
}

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
  // A missing reranker is a supported state: the fusion strategy still answers,
  // and only "fusion+rerank" reports a degradation.
  const reranker = createDefaultReranker(resolveProviderKey);

  // -- Test mode ------------------------------------------------------------
  // MEM0_RECALL_STRATEGY picks what answers local reads; MEM0_RECALL_TEST=1
  // (or simply setting a strategy) switches the shadow logger into comparison
  // mode, where every read records what each strategy would have answered
  // against the same remote ground truth. Test mode changes what is measured,
  // never what the agent receives.
  const localStrategy = readStrategy(process.env.MEM0_RECALL_STRATEGY);
  const lexicalWeight = readLexicalWeight(process.env.MEM0_FUSION_BM25_WEIGHT);
  const testMode = process.env.MEM0_RECALL_TEST === "1" || localStrategy !== undefined;

  const g = globalThis as { fetch?: typeof fetch & { [WRAPPED]?: boolean } };
  const authRef: { current?: CapturedAuth } = {};
  const filtersRef: { current?: Record<string, unknown> } = {};
  // Capture the original fetch BEFORE wrapping so the sync runner's replayed
  // adds go straight to the network, bypassing the interceptor.
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
      localStrategy,
      reranker,
      lexicalWeight,
      testMode,
      onFallback: (reason) => console.warn(`[pi-mem0-cache] ${reason}`),
      onPassthroughSuccess: () => {
        void syncer.maybeSync();
        void embed?.ensure();
      },
    }) as typeof fetch & { [WRAPPED]?: boolean };
    wrapped[WRAPPED] = true;
    g.fetch = wrapped;
  }

  // Warm the vector sidecar at session start: covers mirror drift accumulated
  // before any search traffic has flowed through the interceptor.
  void embed?.ensure();

  pi.registerCommand("mem0-cache", {
    description:
      "mem0 read cache: /mem0-cache [stats|provider|sync|refresh|clear|clear-all|path|shadow|embed|embed refresh|pull-all]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim() || "stats";
      switch (sub) {
        case "stats": {
          const s = store.stats;
          const localCount = syncer.pendingCount();
          const opCount = syncer.pendingOps();
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
              `${localCount} pending local memories${opCount > 0 ? `, ${opCount} pending ops` : ""} | hits ${s.hits}, misses ${s.misses}, ` +
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
          const entries = readShadowEntries(shadowPath);
          const s = summarizeShadow(entries);
          // Strategy comparison table, best-first on MRR. Every column is scored
          // against the same remote ground truth, so they are directly comparable.
          // Rows come from the summary map, so adding a strategy to STRATEGY_ROWS
          // is enough to make it appear here.
          const rows = Object.entries(s.strategies)
            .filter(([, v]) => v.comparisons > 0)
            .map(([name, v]) => ({
              name,
              n: v.comparisons,
              o5: v.meanOverlap5,
              o10: v.meanOverlap10,
              mrr: v.meanMrr,
              top1: v.top1Rate,
            }));
          const table = rows
            .sort((a, b) => b.mrr - a.mrr)
            .map(
              (r) =>
                `${r.name.padEnd(13)} n=${String(r.n).padStart(4)}  o@5 ${r.o5.toFixed(2)}  o@10 ${r.o10.toFixed(2)}  MRR ${r.mrr.toFixed(3)}  top1 ${(r.top1 * 100).toFixed(0)}%`,
            )
            .join("\n");
          let msg = `mem0-cache shadow: ${s.comparisons} comparisons (${s.fallbacks} fallback)\n${table}`;
          // Per-channel failures are the thing that silently degrades output, so
          // each strategy gets its own line, keeping them separately readable.
          const errs = new Map<string, number>();
          for (const e of entries) {
            for (const [k, v] of Object.entries(e.channelErrors ?? {})) {
              errs.set(`${k}: ${v.slice(0, 60)}`, (errs.get(`${k}: ${v.slice(0, 60)}`) ?? 0) + 1);
            }
          }
          if (errs.size > 0) {
            msg +=
              "\nchannel errors:\n" +
              [...errs.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([k, n]) => `  ${n}x ${k}`)
                .join("\n");
          }
          ctx.ui.notify(msg, "info");
          break;
        }
        case "provider": {
          // Credential and health report. Never prints a key value — only the
          // source it came from and the last error the provider returned.
          const lines: string[] = [];
          for (const [name, preset] of Object.entries(EMBED_PROVIDERS)) {
            const envSet = Boolean(process.env[preset.keyEnv]);
            const keychain = readKeyFromKeychain(KEYCHAIN_SERVICES[name] ?? "");
            const source = envSet ? `env ${preset.keyEnv}` : keychain ? `keychain (${KEYCHAIN_SERVICES[name]})` : "none";
            lines.push(
              `${name.padEnd(11)} ${source.padEnd(38)} default model ${preset.model}`,
            );
          }
          const active = embedder ? `${embedder.model}` : "none (local reads use BM25 only)";
          lines.push(``, `active embedder: ${active}`);

          // Show the resolution, not just the request: the operator's question is
          // "what is answering my reads", and the answer is a plan plus whatever
          // was skipped to reach it.
          const caps = {
            dense: embed !== undefined && embed.status().enabled,
            rerank: reranker !== undefined,
          };
          const res = resolveStrategy(localStrategy ?? "auto", caps);
          const ndcg = res.plan.measuredNdcg === null ? "unmeasured" : `nDCG@10 ${res.plan.measuredNdcg.toFixed(3)}`;
          lines.push(`requested strategy: ${localStrategy ?? "auto (default)"}`);
          lines.push(`serving strategy:   ${res.plan.strategy}  (${res.plan.summary}; ${ndcg})`);
          for (const s of res.skipped) {
            lines.push(`  skipped ${s.strategy.padEnd(14)} ${s.reason}`);
          }
          lines.push(
            `capabilities:       embed ${caps.dense ? "ok" : "off"} | rerank ${caps.rerank ? "ok" : "off"}`,
          );
          lines.push(
            `providers:          openrouter ${resolveProviderKey("openrouter") ? "key present" : "no key"}`,
          );
          lines.push(`test mode: ${testMode ? "on" : "off"}`);
          if (embed) {
            const s = embed.status();
            lines.push(
              `embed layer: ${s.vectors}/${s.corpus} vectors` +
                `${s.lastError ? ` | last error: ${s.lastError}` : ""}` +
                `${s.cooldownUntil ? ` | cooling down` : ""}`,
            );
          }
          lines.push(``, `add a key:  ./scripts/setup-key.sh ${Object.keys(EMBED_PROVIDERS).join("|")}`);
          ctx.ui.notify(`mem0-cache provider:\n${lines.join("\n")}`, embedder ? "info" : "warning");
          break;
        }
        case "embed": {
          if (!embed) {
            ctx.ui.notify(
              "mem0-cache embed: disabled — set JINA_API_KEY or mem0-config.json jinaApiKey (MEM0_EMBED=0 forces off)",
              "warning",
            );
            break;
          }
          await embed.ensure(); // self-heal sidecar drift before reporting
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
            ctx.ui.notify("mem0-cache embed: disabled — set JINA_API_KEY or mem0-config.json jinaApiKey", "warning");
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

export { EMBED_PROVIDERS, MAX_MEMORY_CHARS } from "./types.js";
export type {
  CachedResponse,
  ClassifiedRequest,
  FetchInput,
  LocalMemory,
  LocalStrategy,
  MemoryOverflow,
  NetState,
  PendingOp,
  Store,
  SyncState,
} from "./types.js";
export { emptyStore, loadStore, makeSaver } from "./store.js";
export { classify, isMem0Host } from "./request.js";
export { clampMemory, harvestMemories, searchLocal, searchLocalScored, tokenize } from "./memory.js";
