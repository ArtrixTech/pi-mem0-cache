import { describe, expect, it } from "vitest";
import { buildBm25Index, searchBm25, tokenizeBM25 } from "../src/recall/bm25.js";

describe("tokenizeBM25", () => {
  it("keeps Latin words whole and lowercased", () => {
    expect(tokenizeBM25("HK Express")).toEqual(["hk", "express"]);
  });

  it("drops punctuation and keeps alphanumerics", () => {
    expect(tokenizeBM25("gpdev: node >=24.18.0")).toEqual(["gpdev", "node", "24", "18", "0"]);
  });

  it("indexes CJK as overlapping bigrams", () => {
    expect(tokenizeBM25("香港出发")).toEqual(["香港", "港出", "出发"]);
  });

  it("keeps a lone CJK character as a unigram so single-char queries work", () => {
    expect(tokenizeBM25("猫")).toEqual(["猫"]);
  });

  it("does not emit a bigram spanning a script boundary", () => {
    expect(tokenizeBM25("veeam备份")).toEqual(["veeam", "备份"]);
  });

  it("returns nothing for punctuation-only input", () => {
    expect(tokenizeBM25("   ---  ")).toEqual([]);
  });
});

describe("searchBm25", () => {
  const docs = [
    { id: "veeam", text: "veeam 备份作业需要移除" },
    { id: "hkexpress", text: "香港出发去日本，考虑 hkexpress" },
    { id: "unrelated", text: "完全不相关的记忆内容" },
  ];

  it("ranks the memory sharing query bigrams first", () => {
    const idx = buildBm25Index(docs);
    const hits = searchBm25(idx, "香港出发");
    expect(hits[0].id).toBe("hkexpress");
  });

  it("discriminates on CJK content", () => {
    const idx = buildBm25Index(docs);
    const hits = searchBm25(idx, "备份作业");
    expect(hits[0].id).toBe("veeam");
    // "完全不相关的记忆内容" shares 记/忆/内/容 with nothing meaningful here —
    // with the old single-char scorer it would have scored non-zero.
    const scored = new Set(hits.map((h) => h.id));
    expect(scored.has("unrelated")).toBe(false);
  });

  it("reports query terms with no corpus match", () => {
    const idx = buildBm25Index(docs);
    const hits = searchBm25(idx, "香港 量子计算");
    expect(hits[0].unmatched).toContain("量子");
  });

  it("lets a rare term outrank a common one", () => {
    const idx = buildBm25Index([
      { id: "common", text: "记忆 记忆 记忆 记忆" },
      { id: "rare", text: "记忆 小米打印机" },
    ]);
    const hits = searchBm25(idx, "记忆 小米打印机");
    expect(hits[0].id).toBe("rare");
  });

  it("normalizes length so a short exact match beats a long diluted one", () => {
    const idx = buildBm25Index([
      { id: "short", text: "hkexpress 机票" },
      { id: "long", text: `hkexpress ${"填充内容 ".repeat(40)}` },
    ]);
    const hits = searchBm25(idx, "hkexpress 机票");
    expect(hits[0].id).toBe("short");
  });

  it("returns an empty list for an empty index", () => {
    expect(searchBm25(buildBm25Index([]), "香港")).toEqual([]);
  });

  it("returns an empty list when the query has no terms", () => {
    const idx = buildBm25Index(docs);
    expect(searchBm25(idx, "---")).toEqual([]);
  });

  it("respects the limit", () => {
    const idx = buildBm25Index(docs);
    expect(searchBm25(idx, "记忆 内容 香港", { limit: 2 })).toHaveLength(2);
  });
});
