/**
 * Embedding recall: maintain the vector sidecar and rank the mirror by cosine
 * similarity over unit-length vectors.
 */

import { resolveProviderKey } from "./credentials.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_MEM0_CONFIG_PATH,
  EMBED_BATCH_CHARS,
  EMBED_BATCH_SIZE,
  EMBED_COOLDOWN_MS,
  EMBED_MAX_BATCHES_PER_CALL,
  EMBED_PROVIDERS,
  MAX_FALLBACK_RESULTS,
} from "./types.js";
import type { LocalMemory, Store } from "./types.js";

// ---------------------------------------------------------------------------
// Embedding recall: semantic ranking of the local mirror, over any
// OpenAI-compatible provider (OpenRouter, Jina, Voyage, Ollama, …)

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
    label: "jina",
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
  // 45s: an 8B embedding model over a batch of long CJK memories
  // takes materially longer than the 239M model the old default was tuned for.
  const timeoutMs = opts.timeoutMs ?? 45_000;
  // Per-input character cap. The provider rejects an oversized input with HTTP
  // 400 and the whole batch fails, so a single long memory could stall the layer
  // permanently. Truncating here means the worst case is a poorer embedding for
  // one memory, keeping embeddings for the rest of the batch.
  const maxInputChars = opts.maxInputChars ?? 8000;
  return {
    model: opts.model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const input = texts.map((t) => (t.length > maxInputChars ? t.slice(0, maxInputChars) : t));
      let res: Response;
      try {
        res = await fetchImpl(opts.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model: opts.model, input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network-level failures (DNS, TCP, TLS, timeout) arrive with no status
        // attached; name the provider so the health report says which one died.
        throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
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
   *  persistent provider failure, a few unlucky inputs aside. */
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
 * A failed batch is recorded and skipped, so one
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
        // few failed batches are recorded as a partial result. A
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
        // bounded, so a large first backfill finishes over several rounds,
        // of holding a session open for ten minutes. `void` because the search that
        // triggered this must not wait for the whole corpus.
        if (r.remaining > 0 && r.failedBatches === 0) {
          void (async () => {
            // Yield first so the caller's own await resolves with partial coverage
            // available, one round ahead of the rest.
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
