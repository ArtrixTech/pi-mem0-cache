/**
 * Local read ranking: resolve a recall plan against the available capabilities
 * and rank the scope-filtered corpus through it.
 */

import {
  LEXICAL_WEIGHT_DEFAULT,
  LexicalChannel,
  recall,
  type ChannelHit,
  type ChannelStatus,
  type FusedHit,
  type RecallChannel,
} from "./recall/fusion.js";
import { resolveStrategy, type StrategyName } from "./recall/plan.js";
import { filterByScope, matchesScope, type ScopeFilters } from "./recall/scope.js";
import { searchLocal } from "./memory.js";
import { MAX_FALLBACK_RESULTS } from "./types.js";
import type { LocalMemory, LocalStrategy, Store } from "./types.js";
import type { EmbedHarness } from "./embed.js";

// ---------------------------------------------------------------------------
// Local read strategies

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
    onStrategy?: (info: { strategy: LocalStrategy; requested: StrategyName; degraded?: string; channels: ChannelStatus[] }) => void;
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
    opts.onStrategy?.({ strategy: "legacy", requested: resolution.requested, channels: [] });
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
  // shadow log must record the truth. One exception: an empty candidate pool
  // skips the reranker with every channel healthy — the pipeline answered
  // exactly as planned (there was simply nothing to reorder), and naming the
  // un-reranked stage as what "served" invented a degradation with an empty
  // reason on every zero-result read.
  const failedChannels = result.status.filter((s) => !s.ok);
  const rerankSkippedEmpty = plan.rerank && !result.reranked && failedChannels.length === 0;
  const survivors = result.status.filter((s) => s.ok).map((s) => s.name);
  const served = rerankSkippedEmpty ? plan.strategy : describeServed(survivors, result.reranked);
  const degraded =
    resolution.degraded ??
    (served !== plan.strategy
      ? `${plan.strategy} served as ${served}: ${failedChannels.map((s) => `${s.name} (${s.error ?? "failed"})`).join(", ")}`
      : undefined);

  opts.onStrategy?.({ strategy: served, requested: resolution.requested, ...(degraded ? { degraded } : {}), channels: result.status });
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
export class EmbedHarnessChannel implements RecallChannel {
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
