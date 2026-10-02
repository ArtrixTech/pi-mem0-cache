/**
 * Shared types and constants: the on-disk store shape, the intercepted request
 * shape, and the limits the rest of the plugin reads.
 *
 * This module imports nothing from its siblings, which makes it the root of the
 * dependency graph.
 */


import { homedir } from "node:os";
import { join } from "node:path";


export const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "mem0-cache.json");
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REMOTE_READ_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_429_BLOCK_MS = 5 * 60 * 1000;
export const DEFAULT_SHADOW_PATH = join(homedir(), ".pi", "agent", "mem0-shadow.jsonl");
/** Size at which the active segment is sealed and a fresh one starts.
 *
 * Sealing renames the active file to a date-stamped sibling and never removes
 * lines. The previous behaviour truncated the file to the most recent N lines,
 * which made any cumulative statistic silently lose its earliest evidence. */
export const SHADOW_ROTATE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_VECTORS_PATH = join(homedir(), ".pi", "agent", "mem0-vectors.json");
export const DEFAULT_MEM0_CONFIG_PATH = join(homedir(), ".pi", "agent", "mem0-config.json");
export const DEFAULT_EMBED_MODEL = "jina-embeddings-v5-text-nano";
/** Providers the embedding layer can talk to. All are OpenAI-compatible. */
export const EMBED_PROVIDERS: Record<string, { endpoint: string; keyEnv: string; model: string }> = {
  jina: {
    endpoint: "https://api.jina.ai/v1/embeddings",
    keyEnv: "JINA_API_KEY",
    model: "jina-embeddings-v5-text-nano",
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/embeddings",
    keyEnv: "OPENROUTER_API_KEY",
    model: "qwen/qwen3-embedding-8b",
  },
};
export const EMBED_COOLDOWN_MS = 60 * 1000;
/** Inputs per embedding request, and the character budget that caps a larger
 *  batch. 64 x ~250 chars is roughly 4K tokens: large enough to be efficient,
 *  small enough to finish inside the per-request timeout. A batch is closed at
 *  whichever limit is reached first, so a run of unusually long memories produces
 *  more, smaller requests. */
export const EMBED_BATCH_SIZE = Number(process.env.MEM0_EMBED_BATCH_SIZE) > 0 ? Number(process.env.MEM0_EMBED_BATCH_SIZE) : 64;
export const EMBED_BATCH_CHARS = 16_000;
/** Batches per `ensure()` call. 8 x 64 inputs is 512 memories, roughly 75s at ~9s
 *  per batch. Bounded so a first backfill never blocks a session for minutes; the
 *  next call resumes from the sidecar. Raise with MEM0_EMBED_MAX_BATCHES. */
export const EMBED_MAX_BATCHES_PER_CALL = Number(process.env.MEM0_EMBED_MAX_BATCHES) > 0 ? Number(process.env.MEM0_EMBED_MAX_BATCHES) : 8;
export const WRAPPED = Symbol.for("pi-mem0-cache.wrapped");
export const MAX_FALLBACK_RESULTS = 10;
/** Harvest guard: memories longer than this are truncated. A single 250K-char
 *  terminal paste once made up 23% of the corpus and poisoned both the keyword
 *  ranking and the embedding mean-pooling. Override with MEM0_MAX_MEMORY_CHARS. */
export const MAX_MEMORY_CHARS =
  Number(process.env.MEM0_MAX_MEMORY_CHARS) > 0 ? Number(process.env.MEM0_MAX_MEMORY_CHARS) : 4000;
export const DEFAULT_QUARANTINE_PATH = join(homedir(), ".pi", "agent", "mem0-quarantine.jsonl");

/** Optional metadata attached to a harvested memory whose text was truncated. */
export interface MemoryOverflow {
  originalChars: number;
  truncatedAt: number;
}

export interface CachedResponse {
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
  /** Present when the harvested text exceeded MAX_MEMORY_CHARS. */
  overflow?: MemoryOverflow;
  [key: string]: unknown;
}

/** A write intent captured while the API was unavailable, replayed verbatim
 *  on sync. Adds are not ops — they replay from LocalMemory.addPayload. */
export interface PendingOp {
  kind: "write-update" | "write-delete" | "write-delete-all";
  memoryId?: string;
  /** Original update body, replayed verbatim. */
  bodyText?: string;
  /** Original delete-all query string, so scope params survive the replay. */
  query?: string;
  at: number;
}

/** Stable identity for a queued write intent. Shared by the save merge and the
 *  applied-op tombstones, so a key computed at replay time matches the key the
 *  merge checks. */
export function opKey(o: PendingOp): string {
  return `${o.kind}|${o.memoryId ?? ""}|${o.query ?? ""}|${o.at}`;
}

/** Cap on the applied-op tombstone map. Past it the oldest entries drop out;
 *  replay is idempotent, so an evicted tombstone costs at most one extra
 *  replay of an op whose effects are already in place. */
export const OPS_DONE_MAX = 500;

export interface SyncState {
  backoffUntil?: number;
  lastAttemptAt?: number;
  lastResult?: string;
  /** Permanent-failure counter per item id. An item the server rejects in a way
   *  that cannot succeed on retry is retired after MAX_SYNC_FAILURES attempts,
   *  so it stops consuming a request per run. */
  failures?: Record<string, number>;
  /** Items retired from the queue, with the reason. Kept so a wrongly-retired
   *  memory can be found and re-queued. */
  quarantined?: Record<string, { reason: string; at: number }>;
  /** Ops that left the queue (applied or retired), keyed by opKey and valued
   *  with the completion time. The save merge skips disk-side ops listed here:
   *  without it the merge's union pulled a just-applied op straight back from
   *  the stale disk copy, and every later sync replayed it. */
  opsDone?: Record<string, number>;
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
  ops: PendingOp[];
  /** Set when this session deliberately cleared the corpus, so a save knows an
   *  empty memory map is a decision and not the absence of a load. */
  wipedAt?: number;
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
    /** Memories whose text was truncated by the harvest guard. */
    harvestDropped: number;
    /** Strategy that served the most recent local read (test mode). */
    lastStrategy?: LocalStrategy;
    /** Set when that strategy could not run as requested. */
    lastStrategyDegraded?: string;
  };
}


export type FetchInput = string | URL | Request;

export interface ClassifiedRequest {
  url: URL;
  method: string;
  bodyText: string | undefined;
  kind: "read-search" | "read-getall" | "read-get" | "read-history" | "read-other" | "write-add" | "write-update" | "write-delete" | "write-delete-all" | "write-other" | "other";
  memoryId?: string;
  query?: string;
  /** Query string of the original request. The SDK's single-item GETs scope
   *  through `?user_id=…`. A GET carries no body under fetch, so the query
   *  string is the sole scope carrier for those reads. */
  search?: string;
}

export type LocalStrategy =
  /** Resolve the best available pipeline from the measured preference ladder.
   *  The default: dense+rerank when both work, dense when only embeddings work,
   *  bm25 when no provider is available. */
  | "auto"
  /** Legacy single-character keyword scorer. Kept for A/B and fallback. */
  | "legacy"
  /** BM25 + CJK bigram only. The availability floor: needs no provider. */
  | "bm25"
  /** Embedding cosine only (whatever the embed harness provides). */
  | "dense"
  /** BM25 + dense fused with RRF, the lexical side down-weighted. */
  | "fusion"
  /** Fusion, then the reranker reorders the pool. */
  | "fusion+rerank"
  /** Dense, then the reranker reorders the pool. Measured joint-best with
   *  fusion+rerank, and the simpler pipeline of the two. */
  | "dense+rerank";

/** Entity-id keys mem0 accepts on a write or filter. A request carrying
 *  none of them is rejected: "At least one entity ID is required". */
export const ENTITY_FILTER_KEYS = new Set(["user_id", "agent_id", "app_id", "run_id"]);
