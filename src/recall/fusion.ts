/**
 * Recall channels and their fusion.
 *
 * Three independent channels produce candidate rankings over the local mirror:
 *
 * - `lexical` (BM25): never fails, no network. The floor.
 * - `dense`: semantic recall via an embeddings provider. Covers paraphrase and
 *   short conversational queries that a lexical scorer cannot reach at all —
 *   measured on the shadow log, 74% of queries share no discriminating term with
 *   their ground truth.
 * - `rerank`: a cross-encoder that re-scores the fused candidate list. Fixes
 *   ordering, not recall: the fused pool already contains the right memory far
 *   more often than it is ranked first.
 *
 * They are combined with Reciprocal Rank Fusion, which needs only ranks and so
 * requires no score calibration between a BM25 score, a cosine similarity and a
 * cross-encoder logit. Each channel is optional and degrades independently: a
 * dead provider removes its channel, and fusion continues over the rest.
 */

import { buildBm25Index, searchBm25, tokenizeBM25, type Bm25Index, type Bm25Hit } from "./bm25.js";

/** RRF damping constant. 60 is the value from the original TREC work and is
 *  what most retrieval stacks still use; it keeps the top ranks dominant
 *  without letting a single channel's #1 monopolize the fused list. */
export const RRF_K = 60;

export interface ChannelHit {
  id: string;
  score: number;
}

/** One named ranking channel. `available()` gates a channel for fusion, and a
 *  configured-but-failing provider gets reported in the recall status so its
 *  absence stays visible. */
export interface RecallChannel {
  name: string;
  search(query: string, limit: number): Promise<ChannelHit[]> | ChannelHit[];
}

export interface FusedHit {
  id: string;
  /** Fused RRF score. */
  score: number;
  /** Per-channel ranks, for diagnostics: {lexical: 3, dense: 11}. */
  ranks: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion over any number of channels.
 *
 * score(id) = Σ_channel 1 / (RRF_K + rank_channel(id))
 *
 * A channel that ranked a document highest contributes 1/(K+1); appearing in
 * several channels accumulates. Documents absent from a channel contribute
 * nothing from it, which is what lets a channel simply be dropped on failure.
 */
export function fuseRrf(channels: { name: string; hits: ChannelHit[] }[], limit: number, k = RRF_K): FusedHit[] {
  const acc = new Map<string, FusedHit>();
  for (const { name, hits } of channels) {
    for (let rank = 0; rank < hits.length; rank++) {
      const id = hits[rank].id;
      const entry = acc.get(id) ?? { id, score: 0, ranks: {} };
      entry.ranks[name] = rank + 1;
      entry.score += 1 / (k + rank + 1);
      acc.set(id, entry);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Lexical channel

export interface LexicalChannelOptions {
  docs: { id: string; text: string }[];
  /** Pre-built index, so a caller scoring many queries builds it once. */
  index?: Bm25Index;
}

/** BM25 over the mirror. Synchronous and dependency-free by design: this is the
 *  channel that must answer when every provider is down. */
export class LexicalChannel implements RecallChannel {
  readonly name = "lexical";
  private index: Bm25Index;

  constructor(opts: LexicalChannelOptions) {
    this.index = opts.index ?? buildBm25Index(opts.docs);
  }

  search(query: string, limit: number): ChannelHit[] {
    return searchBm25(this.index, query, { limit }).map((h: Bm25Hit) => ({ id: h.id, score: h.score }));
  }

  /** Query terms that match nothing in the corpus — a vocabulary-gap signal. */
  unmatched(query: string): string[] {
    const hits = searchBm25(this.index, query, { limit: 1 });
    return hits[0]?.unmatched ?? [...new Set(tokenizeBM25(query))];
  }
}

// ---------------------------------------------------------------------------
// Dense channel

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface DenseChannelOptions {
  embedder: Embedder;
  /** Only vectors for ids present here are used. */
  docs: { id: string; text: string }[];
  getVector: (id: string) => number[] | undefined;
  /** Chunk size for provider calls; providers cap inputs per request. */
  chunkSize?: number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Semantic channel: embeds the query, then ranks the already-embedded corpus by
 *  cosine. Throws on provider failure; the caller is responsible for dropping
 *  the channel (see `resolveChannels`). */
export class DenseChannel implements RecallChannel {
  readonly name = "dense";

  constructor(private opts: DenseChannelOptions) {}

  async search(query: string, limit: number): Promise<ChannelHit[]> {
    const [queryVec] = await this.opts.embedder.embed([query]);
    if (!queryVec?.length) return [];
    const scored: ChannelHit[] = [];
    for (const doc of this.opts.docs) {
      const vec = this.opts.getVector(doc.id);
      if (!vec) continue;
      scored.push({ id: doc.id, score: cosine(queryVec, vec) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Channel resolution with independent degradation

export interface ChannelStatus {
  name: string;
  ok: boolean;
  error?: string;
  hits: number;
}

export interface FuseOptions {
  channels: RecallChannel[];
  /** Candidates pulled from each channel before fusing. */
  perChannelLimit?: number;
  /** Size of the fused pool handed to the reranker / returned. */
  fusedLimit?: number;
  /** Optional final reordering stage over the fused pool. */
  reranker?: (query: string, candidates: FusedHit[]) => Promise<ChannelHit[]> | ChannelHit[];
  onChannelError?: (name: string, error: unknown) => void;
}

export interface FuseResult {
  hits: FusedHit[];
  status: ChannelStatus[];
  reranked: boolean;
}

/**
 * Run every available channel, fuse the survivors, then optionally rerank.
 *
 * A channel that throws is reported in `status` and excluded from the fusion;
 * the call still returns whatever the remaining channels produced. When no
 * channel succeeds the result is an empty list, so the caller can always fall
 * back further.
 */
export async function recall(opts: FuseOptions & { query: string }): Promise<FuseResult> {
  const perChannelLimit = opts.perChannelLimit ?? 50;
  const fusedLimit = opts.fusedLimit ?? 10;
  const status: ChannelStatus[] = [];

  const settled = await Promise.all(
    opts.channels.map(async (ch) => {
      try {
        const hits = await ch.search(opts.query, perChannelLimit);
        status.push({ name: ch.name, ok: true, hits: hits.length });
        return { name: ch.name, hits };
      } catch (err) {
        status.push({ name: ch.name, ok: false, error: err instanceof Error ? err.message : String(err), hits: 0 });
        opts.onChannelError?.(ch.name, err);
        return { name: ch.name, hits: [] as ChannelHit[] };
      }
    }),
  );

  const fused = fuseRrf(
    settled.filter((c) => c.hits.length > 0),
    perChannelLimit,
  );

  if (!opts.reranker || fused.length === 0) {
    return { hits: fused.slice(0, fusedLimit), status, reranked: false };
  }

  try {
    const reranked = await opts.reranker(opts.query, fused.slice(0, perChannelLimit));
    const order = new Map(reranked.map((h, i) => [h.id, i]));
    const byId = new Map(fused.map((h) => [h.id, h]));
    const ordered = [...fused]
      .sort((a, b) => {
        const ra = order.get(a.id);
        const rb = order.get(b.id);
        // Reranked documents first, in the reranker's order; anything the
        // reranker did not score keeps its fused order after them.
        if (ra === undefined && rb === undefined) return b.score - a.score;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      })
      .map((h) => byId.get(h.id)!);
    return { hits: ordered.slice(0, fusedLimit), status, reranked: true };
  } catch (err) {
    status.push({
      name: "rerank",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hits: 0,
    });
    opts.onChannelError?.("rerank", err);
    return { hits: fused.slice(0, fusedLimit), status, reranked: false };
  }
}
