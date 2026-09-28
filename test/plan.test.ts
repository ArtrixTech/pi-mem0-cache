import { describe, expect, it } from "vitest";
import {
  PLANS,
  PREFERENCE,
  STRATEGY_NAMES,
  parseStrategy,
  requirements,
  resolveStrategy,
  unmet,
  type StrategyName,
} from "../src/recall/plan.js";

const BOTH = { dense: true, rerank: true };
const DENSE_ONLY = { dense: true, rerank: false };
const NEITHER = { dense: false, rerank: false };

describe("plan registry", () => {
  it("registers a plan for every non-auto strategy name", () => {
    for (const name of STRATEGY_NAMES) {
      if (name === "auto") continue;
      expect(PLANS[name], name).toBeDefined();
      expect(PLANS[name].strategy).toBe(name);
    }
  });

  it("gives every plan a summary", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.summary.length).toBeGreaterThan(0);
    }
  });

  it("derives requirements from the channel list and rerank flag", () => {
    expect(requirements(PLANS["dense+rerank"])).toEqual({ needsDense: true, needsRerank: true });
    expect(requirements(PLANS.dense)).toEqual({ needsDense: true, needsRerank: false });
    expect(requirements(PLANS.bm25)).toEqual({ needsDense: false, needsRerank: false });
    expect(requirements(PLANS.legacy)).toEqual({ needsDense: false, needsRerank: false });
  });

  it("ends every preference ladder in a plan that needs no capability", () => {
    // This is the invariant that makes resolution total: the final entry of each
    // ladder must be servable with nothing available.
    for (const [requested, ladder] of Object.entries(PREFERENCE)) {
      expect(ladder.length, requested).toBeGreaterThan(0);
      const last = PLANS[ladder[ladder.length - 1]];
      expect(unmet(last, NEITHER), `${requested} -> ${last.strategy}`).toBeUndefined();
    }
  });

  it("orders every ladder from the most capable plan to the least", () => {
    // A ladder that put a weaker plan first would degrade for no reason.
    const rank = (p: string) => requirements(PLANS[p as keyof typeof PLANS]).needsRerank
      ? 2
      : requirements(PLANS[p as keyof typeof PLANS]).needsDense
        ? 1
        : 0;
    for (const [requested, ladder] of Object.entries(PREFERENCE)) {
      const ranks = ladder.map(rank);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i], `${requested}: ${ladder.join(" -> ")}`).toBeLessThanOrEqual(ranks[i - 1]);
      }
    }
  });
});

describe("unmet", () => {
  it("names the missing embedding layer", () => {
    expect(unmet(PLANS["dense+rerank"], NEITHER)).toBe("embedding layer unavailable");
    expect(unmet(PLANS.dense, NEITHER)).toBe("embedding layer unavailable");
  });

  it("names the missing reranker", () => {
    expect(unmet(PLANS["dense+rerank"], DENSE_ONLY)).toBe("no reranker configured");
    // A dense-only plan needs no reranker, so the same capabilities satisfy it.
    expect(unmet(PLANS.dense, DENSE_ONLY)).toBeUndefined();
  });

  it("reports nothing for a plan that needs no provider", () => {
    expect(unmet(PLANS.bm25, NEITHER)).toBeUndefined();
    expect(unmet(PLANS.legacy, NEITHER)).toBeUndefined();
  });
});

describe("resolveStrategy", () => {
  it("picks dense+rerank for auto when both capabilities are present", () => {
    const r = resolveStrategy("auto", BOTH);
    expect(r.plan.strategy).toBe("dense+rerank");
    expect(r.skipped).toEqual([]);
    expect(r.degraded).toBeUndefined();
  });

  it("keeps dense+rerank when only the reranker is missing, by dropping to dense", () => {
    const r = resolveStrategy("auto", DENSE_ONLY);
    expect(r.plan.strategy).toBe("dense");
    expect(r.skipped.map((s) => s.strategy)).toEqual(["dense+rerank"]);
    expect(r.degraded).toContain("dense+rerank");
    expect(r.degraded).toContain("no reranker configured");
  });

  it("lands on bm25 for auto when no provider is available", () => {
    const r = resolveStrategy("auto", NEITHER);
    expect(r.plan.strategy).toBe("bm25");
    expect(r.skipped.map((s) => s.strategy)).toEqual(["dense+rerank", "dense"]);
    expect(r.degraded).toContain("bm25");
  });

  it("always resolves, for every requested strategy and capability combination", () => {
    // Resolution is total: the health command and the serving path both depend on
    // it returning a plan. 
    for (const requested of STRATEGY_NAMES) {
      for (const caps of [BOTH, DENSE_ONLY, NEITHER]) {
        const r = resolveStrategy(requested as StrategyName, caps);
        expect(r.plan, `${requested} ${JSON.stringify(caps)}`).toBeDefined();
        expect(unmet(r.plan, caps)).toBeUndefined();
      }
    }
  });

  it("honours an explicit bm25 request even when everything is available", () => {
    // An operator pinning a strategy during an A/B must get exactly that plan.
    const r = resolveStrategy("bm25", BOTH);
    expect(r.plan.strategy).toBe("bm25");
    expect(r.skipped).toEqual([]);
  });

  it("honours an explicit dense+rerank request when available", () => {
    const r = resolveStrategy("dense+rerank", BOTH);
    expect(r.plan.strategy).toBe("dense+rerank");
  });

  it("degrades an explicit dense+rerank request to bm25 with no provider", () => {
    const r = resolveStrategy("dense+rerank", NEITHER);
    expect(r.plan.strategy).toBe("bm25");
    expect(r.skipped.map((s) => s.strategy)).toEqual(["dense+rerank", "dense"]);
  });

  it("lets a fusion request fall through to dense when it cannot rerank", () => {
    // Dense measures better than fusion (0.677 against 0.633), so serving the
    // fused pipeline would be the worse answer for the same capability set.
    const r = resolveStrategy("fusion+rerank", DENSE_ONLY);
    expect(r.plan.strategy).toBe("dense");
    expect(r.skipped.map((s) => s.strategy)).toEqual(["fusion+rerank"]);
  });

  it("keeps fusion reachable when asked for directly", () => {
    const r = resolveStrategy("fusion", BOTH);
    expect(r.plan.strategy).toBe("fusion");
    expect(r.skipped).toEqual([]);
  });

  it("carries the measured nDCG on the chosen plan", () => {
    const r = resolveStrategy("auto", BOTH);
    expect(r.plan.measuredNdcg).toBeCloseTo(0.821, 3);
  });

  it("records the requested strategy on the resolution", () => {
    expect(resolveStrategy("fusion", BOTH).requested).toBe("fusion");
    expect(resolveStrategy("auto", NEITHER).requested).toBe("auto");
  });
});

describe("parseStrategy", () => {
  it("accepts every registered name including auto", () => {
    for (const name of STRATEGY_NAMES) {
      expect(parseStrategy(name)).toBe(name);
    }
  });

  it("returns undefined for unset and for nonsense, so the caller can tell them apart", () => {
    expect(parseStrategy(undefined)).toBeUndefined();
    expect(parseStrategy("")).toBeUndefined();
    expect(parseStrategy("nope")).toBeUndefined();
    // Back-compat guard: a typo falls through to the default and is
    // coerced into a plan nobody chose.
    expect(parseStrategy("Dense")).toBeUndefined();
  });
});
