/**
 * Strategy registry and capability-driven resolution.
 *
 * WHY THIS MODULE EXISTS
 * The local-read strategy was a string compared against literal lists scattered
 * through `rankLocal`, and the default was the fusion pipeline. The gold-set
 * ablation (scripts/score-full.mjs, 57 judged queries over a mean 2570 in-scope
 * memories) measured every combination:
 *
 *   dense+rerank    nDCG@10 0.821   MRR 0.905   zero@10 0.035
 *   fusion+rerank   nDCG@10 0.821   MRR 0.905   zero@10 0.035
 *   dense           nDCG@10 0.677   MRR 0.850   zero@10 0.070
 *   fusion          nDCG@10 0.633   MRR 0.729   zero@10 0.053
 *   bm25            nDCG@10 0.346   MRR 0.549   zero@10 0.281
 *   legacy          nDCG@10 0.241   MRR 0.431   zero@10 0.474
 *
 * The reranker equalises fusion and dense, so the two best rows are the same
 * pipeline with a different retrieval stage feeding it. The lexical channel
 * therefore earns no place in the serving path while embeddings work: it costs a
 * fused candidate slot that a reranker must then reorder past, and it measured
 * worse than dense alone at every stage it participated in.
 *
 * Its value is availability. BM25 is pure local arithmetic: no key, no network,
 * no provider that can stop answering. The ladder below gives it that role — the
 * floor the system lands on when every provider is gone.
 *
 * WHAT RESOLUTION MEANS
 * A caller asks for a strategy, possibly "auto". Resolution walks a preference
 * list for that strategy and returns the first plan whose required capabilities
 * are present, reporting what was skipped and why. Capability checks are
 * injected, so the resolver stays testable without a network or a store.
 */

/** A strategy name, including the pseudo-strategy "auto". */
export const STRATEGY_NAMES = [
  "auto",
  "dense+rerank",
  "dense",
  "fusion+rerank",
  "fusion",
  "bm25",
  "legacy",
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/** What a plan needs before it can run. */
export interface Capabilities {
  /** The embedding harness is configured and its last call succeeded. */
  dense: boolean;
  /** A reranker is configured (key present). Its health is not probed here: a
   *  failed rerank degrades inside the recall step, which has the fallback. */
  rerank: boolean;
}

/** How a plan retrieves and reorders. */
export interface StrategyPlan {
  strategy: Exclude<StrategyName, "auto">;
  /** Channels to run, in the order their names are registered. */
  channels: ("lexical" | "dense")[];
  /** Whether the reranker runs after fusion. */
  rerank: boolean;
  /** NDCG@10 measured on the gold set, or null for a plan never measured at this
   *  candidate-pool width. Surfaced in the health command so the shipped default
   *  is traceable to a measurement. */
  measuredNdcg: number | null;
  summary: string;
}

/**
 * The plan registry. Each entry maps to exactly one serving behaviour.
 *
 * `fusion` and `fusion+rerank` stay registered: the ablation that demoted them is
 * reproducible, and a future corpus with different lexical properties deserves a
 * cheap way to re-test the comparison.
 */
export const PLANS: Record<Exclude<StrategyName, "auto">, StrategyPlan> = {
  "dense+rerank": {
    strategy: "dense+rerank",
    channels: ["dense"],
    rerank: true,
    measuredNdcg: 0.821,
    summary: "semantic retrieval, then a cross-encoder reorders the pool",
  },
  dense: {
    strategy: "dense",
    channels: ["dense"],
    rerank: false,
    measuredNdcg: 0.677,
    summary: "semantic retrieval only",
  },
  "fusion+rerank": {
    strategy: "fusion+rerank",
    channels: ["lexical", "dense"],
    rerank: true,
    measuredNdcg: 0.821,
    summary: "lexical and semantic retrieval fused, then reordered",
  },
  fusion: {
    strategy: "fusion",
    channels: ["lexical", "dense"],
    rerank: false,
    measuredNdcg: 0.633,
    summary: "lexical and semantic retrieval fused with weighted RRF",
  },
  bm25: {
    strategy: "bm25",
    channels: ["lexical"],
    rerank: false,
    measuredNdcg: 0.346,
    summary: "local keyword ranking, needs no provider",
  },
  legacy: {
    strategy: "legacy",
    channels: [],
    rerank: false,
    measuredNdcg: 0.241,
    summary: "pre-2026 single-character keyword scorer, kept for A/B",
  },
};

/**
 * Preference ladders. Each requested strategy lists the plans to try, best
 * first. Every ladder terminates in a plan that needs no capability, so
 * resolution can never fail to produce an answer.
 */
export const PREFERENCE: Record<StrategyName, Exclude<StrategyName, "auto">[]> = {
  // The shipped default: match the best measured pipeline, then degrade along the
  // axis of what is actually missing.
  auto: ["dense+rerank", "dense", "bm25"],
  "dense+rerank": ["dense+rerank", "dense", "bm25"],
  dense: ["dense", "bm25"],
  // A fusion request drops straight to dense when it cannot rerank: the fused
  // pipeline measured 0.633 against dense's 0.677, so serving fusion would be a
  // worse answer for no gain. Fusion stays reachable by asking for it directly.
  "fusion+rerank": ["fusion+rerank", "dense", "bm25"],
  fusion: ["fusion", "dense", "bm25"],
  bm25: ["bm25"],
  legacy: ["legacy"],
};

/** Why a plan in the ladder was skipped. */
export interface Skip {
  strategy: Exclude<StrategyName, "auto">;
  reason: string;
}

export interface Resolution {
  /** The plan that will serve the read. */
  plan: StrategyPlan;
  /** What the caller asked for, after parsing. */
  requested: StrategyName;
  /** Plans ahead of the chosen one in the ladder that could not run. */
  skipped: Skip[];
  /** Human-readable degradation note, for the shadow log and the health command. */
  degraded?: string;
}

/** What a plan needs, read from its channel list and rerank flag. */
export function requirements(plan: StrategyPlan): { needsDense: boolean; needsRerank: boolean } {
  return { needsDense: plan.channels.includes("dense"), needsRerank: plan.rerank };
}

/** Whether the available capabilities satisfy a plan, with the reason when not. */
export function unmet(plan: StrategyPlan, caps: Capabilities): string | undefined {
  const { needsDense, needsRerank } = requirements(plan);
  if (needsDense && !caps.dense) return "embedding layer unavailable";
  if (needsRerank && !caps.rerank) return "no reranker configured";
  return undefined;
}

/**
 * Resolve a request against what is actually available.
 *
 * Walks the ladder for `requested`, skipping plans whose requirements are unmet,
 * and returns the first that can run. Every ladder ends in `bm25`, which requires
 * nothing, so the result is always servable.
 */
export function resolveStrategy(requested: StrategyName, caps: Capabilities): Resolution {
  const ladder = PREFERENCE[requested] ?? PREFERENCE.auto;
  const skipped: Skip[] = [];
  for (const name of ladder) {
    const plan = PLANS[name];
    const reason = unmet(plan, caps);
    if (reason === undefined) {
      const degraded =
        skipped.length === 0
          ? undefined
          : `${requested} resolved to ${plan.strategy}: ${skipped.map((s) => `${s.strategy} (${s.reason})`).join(", ")}`;
      return { plan, requested, skipped, ...(degraded ? { degraded } : {}) };
    }
    skipped.push({ strategy: name, reason });
  }
  // Unreachable while every ladder terminates in a plan needing nothing, kept as a
  // total function so a future edit to PREFERENCE cannot produce undefined.
  return {
    plan: PLANS.bm25,
    requested,
    skipped,
    degraded: `${requested} resolved to bm25: no plan in the ladder was satisfiable`,
  };
}

/** Parse a user-supplied strategy name. Unknown values resolve to undefined so
 *  the caller can distinguish "not set" from "set to nonsense". */
export function parseStrategy(value: string | undefined): StrategyName | undefined {
  if (!value) return undefined;
  return (STRATEGY_NAMES as readonly string[]).includes(value) ? (value as StrategyName) : undefined;
}
