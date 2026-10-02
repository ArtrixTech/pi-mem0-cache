import { describe, expect, it } from "vitest";
import { emptyStore, rankLocal } from "../src/index.js";
import type { EmbedHarness, LocalMemory, Store } from "../src/index.js";
import type { Reranker } from "../src/rank.js";

function mem(id: string, text: string): LocalMemory {
  return {
    id,
    memory: text,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    source: "observed",
  } as LocalMemory;
}

function storeWith(...memories: LocalMemory[]): Store {
  const s = emptyStore();
  for (const m of memories) s.memories[m.id] = m;
  return s;
}

/** Harness fake with the exact EmbedHarness surface rankLocal consults. */
function fakeEmbed(search: EmbedHarness["search"]): EmbedHarness {
  return {
    ensure: async () => {},
    search,
    status: () => ({ enabled: true, model: "test", vectors: 0, corpus: 0 }),
    refresh: async () => "ok",
  };
}

type StrategyInfo = { strategy: string; requested: string; degraded?: string };

describe("rankLocal strategy reporting", () => {
  it("does not report a degradation when the reranker is skipped on an empty pool", async () => {
    // Live failure this pinned: every zero-result local read warned
    // `degraded to "dense": dense+rerank served as dense: ` with an empty
    // reason. No channel failed — there was simply nothing to rerank.
    const store = storeWith(mem("a", "unrelated content"));
    let rerankCalled = false;
    const reranker: Reranker = async () => {
      rerankCalled = true;
      return [];
    };
    const infos: StrategyInfo[] = [];
    const out = await rankLocal(store, "nothing matches", {
      embed: fakeEmbed(async () => []),
      reranker,
      onStrategy: (info) => infos.push(info),
    });
    expect(out).toEqual([]);
    expect(rerankCalled).toBe(false);
    expect(infos).toHaveLength(1);
    expect(infos[0].degraded).toBeUndefined();
    expect(infos[0].strategy).toBe("dense+rerank");
    expect(infos[0].requested).toBe("auto");
  });

  it("reports the real reason when the dense channel fails", async () => {
    const store = storeWith(mem("a", "some text"));
    const infos: StrategyInfo[] = [];
    await rankLocal(store, "query", {
      embed: fakeEmbed(async () => null),
      reranker: async () => [],
      onStrategy: (info) => infos.push(info),
    });
    expect(infos[0].degraded).toContain("dense+rerank served as");
    expect(infos[0].degraded).toContain("dense (");
  });

  it("reports the reranker failure when reordering throws", async () => {
    const store = storeWith(mem("a", "some text"));
    const m = store.memories.a;
    const infos: StrategyInfo[] = [];
    await rankLocal(store, "query", {
      embed: fakeEmbed(async () => [{ m, score: 0.9 }]),
      reranker: async () => {
        throw new Error("rerank boom");
      },
      onStrategy: (info) => infos.push(info),
    });
    expect(infos[0].strategy).toBe("dense");
    expect(infos[0].degraded).toBe("dense+rerank served as dense: rerank (rerank boom)");
  });
});
