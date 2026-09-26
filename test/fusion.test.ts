import { describe, expect, it, vi } from "vitest";
import {
  cosine,
  DenseChannel,
  fuseRrf,
  LexicalChannel,
  recall,
  RRF_K,
  type ChannelHit,
  type RecallChannel,
} from "../src/recall/fusion.js";

describe("fuseRrf", () => {
  it("favours a document both channels agree on", () => {
    const fused = fuseRrf(
      [
        { name: "lexical", hits: [{ id: "a", score: 9 }, { id: "b", score: 5 }] },
        { name: "dense", hits: [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }] },
      ],
      10,
    );
    // b is 2nd and 1st; a is 1st and absent; c is absent and 2nd.
    expect(fused[0].id).toBe("b");
  });

  it("records the per-channel rank of each hit", () => {
    const fused = fuseRrf([{ name: "lexical", hits: [{ id: "a", score: 1 }] }], 10);
    expect(fused[0].ranks).toEqual({ lexical: 1 });
  });

  it("scores a lone top rank as 1/(K+1)", () => {
    const fused = fuseRrf([{ name: "x", hits: [{ id: "a", score: 1 }] }], 10);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it("ignores scores entirely, so incomparable scales fuse safely", () => {
    const a = fuseRrf([{ name: "x", hits: [{ id: "1", score: 1e-9 }, { id: "2", score: 1e9 }] }], 10);
    expect(a.map((h) => h.id)).toEqual(["1", "2"]);
  });

  it("returns nothing for no channels", () => {
    expect(fuseRrf([], 10)).toEqual([]);
  });

  it("breaks ties deterministically by id", () => {
    const fused = fuseRrf(
      [
        { name: "x", hits: [{ id: "b", score: 1 }] },
        { name: "y", hits: [{ id: "a", score: 1 }] },
      ],
      10,
    );
    expect(fused.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("respects the limit", () => {
    const hits: ChannelHit[] = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, score: 20 - i }));
    expect(fuseRrf([{ name: "x", hits }], 5)).toHaveLength(5);
  });
});

describe("cosine", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    expect(cosine([1, 2], [1, 2])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is scale invariant", () => {
    expect(cosine([1, 2], [10, 20])).toBeCloseTo(1, 10);
  });

  it("returns 0 for a zero vector instead of NaN", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("LexicalChannel", () => {
  const docs = [
    { id: "a", text: "veeam 备份作业移除" },
    { id: "b", text: "香港出发 hkexpress" },
  ];

  it("ranks via BM25 and stays synchronous", () => {
    const ch = new LexicalChannel({ docs });
    const hits = ch.search("备份作业", 10) as ChannelHit[];
    expect(hits[0].id).toBe("a");
  });

  it("reports vocabulary gaps for a query term absent from the corpus", () => {
    const ch = new LexicalChannel({ docs });
    expect(ch.unmatched("香港 量子纠缠")).toContain("量子");
  });
});

describe("DenseChannel", () => {
  it("ranks by cosine against pre-supplied vectors", async () => {
    const ch = new DenseChannel({
      embedder: { model: "test", embed: async () => [[1, 0]] },
      docs: [
        { id: "near", text: "x" },
        { id: "far", text: "y" },
      ],
      getVector: (id) => (id === "near" ? [1, 0.1] : [0, 1]),
    });
    const hits = await ch.search("q", 10);
    expect(hits[0].id).toBe("near");
  });

  it("skips documents without vectors", async () => {
    const ch = new DenseChannel({
      embedder: { model: "test", embed: async () => [[1, 0]] },
      docs: [
        { id: "has", text: "x" },
        { id: "missing", text: "y" },
      ],
      getVector: (id) => (id === "has" ? [1, 0] : undefined),
    });
    expect((await ch.search("q", 10)).map((h) => h.id)).toEqual(["has"]);
  });
});

describe("recall", () => {
  const lexical: RecallChannel = { name: "lexical", search: () => [{ id: "a", score: 5 }, { id: "b", score: 3 }] };
  const dense: RecallChannel = { name: "dense", search: () => [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }] };

  it("fuses available channels and reports each as ok", async () => {
    const r = await recall({ query: "q", channels: [lexical, dense] });
    expect(r.status.map((s) => s.ok)).toEqual([true, true]);
    expect(r.hits[0].id).toBe("b");
    expect(r.hits[0].ranks).toEqual({ lexical: 2, dense: 1 });
  });

  it("drops a failing channel and still answers from the rest", async () => {
    const broken: RecallChannel = {
      name: "dense",
      search: () => {
        throw new Error("provider 403: insufficient balance");
      },
    };
    const errors: string[] = [];
    const r = await recall({ query: "q", channels: [lexical, broken], onChannelError: (n) => errors.push(n) });
    expect(r.hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(r.status.find((s) => s.name === "dense")).toMatchObject({ ok: false });
    expect(r.status.find((s) => s.name === "dense")?.error).toContain("403");
    expect(errors).toEqual(["dense"]);
  });

  it("returns empty rather than throwing when every channel fails", async () => {
    const broken: RecallChannel = {
      name: "x",
      search: () => {
        throw new Error("down");
      },
    };
    const r = await recall({ query: "q", channels: [broken] });
    expect(r.hits).toEqual([]);
    expect(r.status[0].ok).toBe(false);
  });

  it("applies the reranker ordering to the fused pool", async () => {
    const r = await recall({
      query: "q",
      channels: [lexical, dense],
      reranker: async (_q, candidates) => [{ id: "a", score: 1 }, ...candidates.filter((c) => c.id !== "a").map((c) => ({ id: c.id, score: 0 }))],
    });
    expect(r.reranked).toBe(true);
    expect(r.hits[0].id).toBe("a");
  });

  it("keeps fused order and flags reranked=false when the reranker throws", async () => {
    const r = await recall({
      query: "q",
      channels: [lexical, dense],
      reranker: async () => {
        throw new Error("rerank 500");
      },
    });
    expect(r.reranked).toBe(false);
    expect(r.hits[0].id).toBe("b");
    expect(r.status.find((s) => s.name === "rerank")?.ok).toBe(false);
  });

  it("does not call the reranker when there are no candidates", async () => {
    const spy = vi.fn();
    const r = await recall({ query: "q", channels: [], reranker: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(r.hits).toEqual([]);
  });
});
