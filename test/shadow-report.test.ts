import { describe, expect, it } from "vitest";
import { buildReport, formatReport, lengthBucket, MIN_COMPARISONS, ndcgAgainstRemote } from "../src/index.js";
import type { ShadowEntry } from "../src/index.js";

function entry(over: Partial<ShadowEntry>): ShadowEntry {
  return {
    ts: Date.parse("2026-09-20T10:00:00.000Z"),
    schemaVersion: 1,
    codeVersion: "0.8.0",
    mode: "remote",
    query: "a query",
    local: [],
    remote: [],
    overlap5: 0,
    overlap10: 0,
    mrr: 0,
    ...over,
  };
}

const ids = (n: number, prefix = "m"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const hits = (n: number): { id: string }[] => ids(n).map((id) => ({ id }));

describe("ndcgAgainstRemote", () => {
  it("scores a ranking that reproduces the remote order at 1", () => {
    expect(ndcgAgainstRemote(ids(10), ids(10), 10)).toBeCloseTo(1, 6);
  });

  it("scores an identical set in reverse order below the remote order", () => {
    const remote = ids(10);
    const reversed = [...remote].reverse();
    const score = ndcgAgainstRemote(reversed, remote, 10) ?? 0;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("penalises losing the remote top-1 harder than losing the tenth", () => {
    const remote = ids(10);
    const withoutTop1 = [...remote.slice(1), "other"];
    const withoutTenth = [...remote.slice(0, 9), "other"];
    expect(ndcgAgainstRemote(withoutTop1, remote, 10) ?? 0).toBeLessThan(ndcgAgainstRemote(withoutTenth, remote, 10) ?? 0);
  });

  it("returns null when the remote ranking is empty, so the read is excluded", () => {
    expect(ndcgAgainstRemote(ids(5), [], 10)).toBeNull();
  });
});

describe("lengthBucket", () => {
  it("separates short conversational queries from descriptive ones", () => {
    expect(lengthBucket("继续")).toBe("<=8");
    expect(lengthBucket("谢谢合作")).toBe("<=8");
    expect(lengthBucket("港科大 李晓原 研究方向")).toBe("9-24");
    expect(lengthBucket("User wants to investigate whether the local mem0 cache plugin can truly replace the remote reads")).toBe(">24");
  });
});

describe("buildReport", () => {
  it("counts only successful remote reads as comparisons", () => {
    // A fallback has no remote ranking, so there is nothing to agree with.
    const report = buildReport([
      entry({ remote: hits(10), mrr: 1, localDenseRerank: ids(10), mrrDenseRerank: 1 }),
      entry({ mode: "fallback", remote: [], localDenseRerank: ids(10), mrrDenseRerank: 1 }),
    ]);
    expect(report.entries).toBe(2);
    expect(report.comparisons).toBe(1);
    expect(report.fallbacks).toBe(1);
    expect(report.strategies["dense+rerank"].comparisons).toBe(1);
  });

  it("excludes a strategy that did not run from its own denominator", () => {
    // One entry carries no dense ranking. Counting it as a zero would make the
    // strategy look worse purely because the channel failed to run.
    const report = buildReport([
      entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1 }),
      entry({ remote: hits(10), mrr: 1 }),
    ]);
    expect(report.strategies.dense.comparisons).toBe(1);
    expect(report.strategies.dense.meanNdcg10).toBeCloseTo(1, 6);
    expect(report.strategies.dense.meanMrr).toBeCloseTo(1, 6);
  });

  it("reports the remote ranking as the calibrated 1.0 reference", () => {
    const report = buildReport([entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1 })]);
    expect(report.strategies.remote.meanNdcg10).toBeCloseTo(1, 6);
    expect(report.strategies.remote.top1Rate).toBe(1);
    expect(report.strategies.remote.zero10Rate).toBe(0);
  });

  it("filters by code version and counts unfingerprinted entries separately", () => {
    const report = buildReport(
      [
        entry({ codeVersion: "0.8.0", remote: hits(10), mrr: 1 }),
        entry({ codeVersion: "0.7.0", remote: hits(10), mrr: 1 }),
        entry({ codeVersion: undefined, remote: hits(10), mrr: 1 }),
      ],
      { version: "0.8.0" },
    );
    expect(report.entries).toBe(1);
    expect(report.comparisons).toBe(1);
    expect(report.versions).toEqual(["0.8.0"]);
    expect(report.unfingerprinted).toBe(0); // excluded by the version filter
  });

  it("lists every version present and counts pre-fingerprint entries", () => {
    const report = buildReport([
      entry({ codeVersion: "0.8.0", remote: hits(10), mrr: 1 }),
      entry({ codeVersion: "0.7.0", remote: hits(10), mrr: 1 }),
      entry({ codeVersion: undefined, remote: hits(10), mrr: 1 }),
    ]);
    expect(report.versions).toEqual(["0.8.0", "0.7.0"]);
    expect(report.unfingerprinted).toBe(1);
    expect(report.comparisons).toBe(3);
  });

  it("filters by date in local time, inclusive of the boundary day", () => {
    // Local time matches how a person reads "since yesterday" against their own
    // log, so a midday timestamp lands unambiguously inside its own local day.
    const report = buildReport(
      [
        entry({ ts: new Date(2026, 8, 19, 12, 0, 0).getTime(), remote: hits(10), mrr: 1 }),
        entry({ ts: new Date(2026, 8, 20, 12, 0, 0).getTime(), remote: hits(10), mrr: 1 }),
      ],
      { since: "2026-09-20" },
    );
    expect(report.comparisons).toBe(1);
    expect(report.strategies.remote.comparisons).toBe(1);
  });

  it("splits vocabulary gaps from ranking errors", () => {
    // The two have different fixes, and one mean over both hides which dominates.
    const report = buildReport([
      entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1, unmatched: [] }),
      entry({ remote: hits(10), mrr: 0, localDense: ["nope"], mrrDense: 0, unmatched: ["zzz"] }),
    ]);
    const present = report.byVocabulary.find((s) => s.label === "terms present");
    const absent = report.byVocabulary.find((s) => s.label === "terms absent from corpus");
    expect(present?.strategies.dense.meanNdcg10).toBeCloseTo(1, 6);
    expect(absent?.strategies.dense.meanNdcg10).toBeLessThan(0.5);
  });

  it("groups reads by the entity filters they carried", () => {
    const report = buildReport([
      entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1, scope: { user_id: "artrix", app_id: "reach" } }),
      entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1, scope: { user_id: "artrix", app_id: "other" } }),
      entry({ remote: hits(10), mrr: 1, localDense: ids(10), mrrDense: 1 }),
    ]);
    expect(report.byScope.map((s) => s.label)).toEqual([
      "app_id=other user_id=artrix",
      "app_id=reach user_id=artrix",
      "unscoped",
    ]);
  });

  it("carries the sample size beside every mean", () => {
    const report = buildReport(
      Array.from({ length: 4 }, () => entry({ remote: hits(10), mrr: 1, localDenseRerank: ids(10), mrrDenseRerank: 1 })),
    );
    const text = formatReport(report);
    expect(report.strategies["dense+rerank"].comparisons).toBe(4);
    expect(text).toContain(`[n<${MIN_COMPARISONS}: indicative only]`);
    expect(text).toContain("n=   4");
  });

  it("omits the thin-sample marker once the count is sufficient", () => {
    const report = buildReport(
      Array.from({ length: MIN_COMPARISONS }, () => entry({ remote: hits(10), mrr: 1, localDenseRerank: ids(10), mrrDenseRerank: 1 })),
    );
    const text = formatReport(report);
    expect(report.strategies["dense+rerank"].comparisons).toBe(MIN_COMPARISONS);
    expect(text).not.toContain("indicative only");
  });

  it("reports an empty log without dividing by zero", () => {
    const report = buildReport([]);
    expect(report.comparisons).toBe(0);
    expect(formatReport(report)).toContain("no entries");
  });
});
