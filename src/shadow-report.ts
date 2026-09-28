/**
 * Accuracy report over the shadow log.
 *
 * WHAT THIS ANSWERS
 * The shadow log records, for each live read, what the remote API returned next
 * to what every local strategy would have returned for the same query. This
 * module turns that history into the one number the serving decision rests on:
 * how close `dense+rerank` comes to the remote ranking, on real traffic, over
 * time.
 *
 * WHY A SEPARATE REPORT FROM `/mem0-cache shadow`
 * The command reports means over whatever the log currently holds. That answers
 * "how are we doing lately" and cannot answer "how have we done since version
 * X", because a mean carries no provenance. This module keeps the same
 * arithmetic and adds what a cumulative claim needs: a version filter, a date
 * filter, stratification, and a sample-size gate.
 *
 * THE GROUND-TRUTH CAVEAT
 * The remote ranking is the reference, which makes these figures agreement with
 * the API rather than absolute relevance. A strategy that beats the API on a
 * query scores lower here. The gold set answers the absolute question; this
 * answers the agreement question, and the two are read together.
 *
 * READS ONLY PERSISTED ENTRIES
 * Nothing here re-runs retrieval. A stored entry describes the corpus as it was
 * at write time, and re-running against today's corpus would produce a number
 * belonging to no real moment.
 */

import type { ShadowEntry } from "./shadow.js";

/** Ranked ids for one strategy on one entry, or undefined when that strategy
 *  did not run. `undefined` is excluded from the denominator, so a strategy that
 *  could not run is never scored as a zero. */
export interface StrategyRanking {
  ids: string[];
  /** Reciprocal rank of the remote top-1 within this ranking. */
  mrr: number;
}

export const STRATEGIES: { name: string; read: (e: ShadowEntry) => StrategyRanking | undefined }[] = [
  { name: "dense+rerank", read: (e) => ranked(e.localDenseRerank, e.mrrDenseRerank) },
  { name: "dense", read: (e) => ranked(e.localDense ?? e.localVec?.map((h) => h.id), e.mrrDense ?? e.mrrVec) },
  { name: "fusion", read: (e) => ranked(e.localFusion, e.mrrFusion) },
  { name: "bm25", read: (e) => ranked(e.localBm25?.map((h) => h.id), e.mrrBm25) },
  { name: "legacy", read: (e) => ranked(e.local.map((h) => h.id), e.mrr) },
  { name: "remote", read: (e) => ({ ids: e.remote.map((h) => h.id), mrr: e.remote.length > 0 ? 1 : 0 }) },
];

function ranked(ids: string[] | undefined, mrr: number | undefined): StrategyRanking | undefined {
  if (!ids || ids.length === 0 || mrr === undefined) return undefined;
  return { ids, mrr };
}

/** Graded gain for a rank position, matching the gold-set scorer so a live
 *  figure and a gold figure are on the same scale. */
const gain = (grade: number): number => (grade >= 2 ? 3 : grade === 1 ? 1 : 0);

/**
 * nDCG@k against the remote ranking as the relevance grades.
 *
 * The remote top-1 is treated as the most relevant result and the rest of its
 * top-k as less relevant, with the weight decaying by position. This is the
 * best available grading on live traffic: no human judged these queries, and a
 * downstream LLM judge cannot label every read in real time.
 */
export function ndcgAgainstRemote(ranked: string[], remoteIds: string[], k: number): number | null {
  if (remoteIds.length === 0) return null;
  const grade = new Map<string, number>();
  remoteIds.slice(0, k).forEach((id, i) => grade.set(id, i === 0 ? 2 : 1));
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + gain(grade.get(id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...grade.values()].map(gain).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return idcg === 0 ? null : dcg / idcg;
}

export interface StrategyAccuracy {
  comparisons: number;
  meanNdcg10: number;
  meanOverlap10: number;
  meanMrr: number;
  /** Share of reads where the remote top-1 was also this strategy's top-1. */
  top1Rate: number;
  /** Share of reads returning nothing the remote returned in its top 10. */
  zero10Rate: number;
}

/** Below this many comparisons a mean is noise that reads as a finding. */
export const MIN_COMPARISONS = 30;

export interface Stratum {
  label: string;
  strategies: Record<string, StrategyAccuracy>;
}

export interface ShadowReport {
  entries: number;
  comparisons: number;
  fallbacks: number;
  /** Distinct code versions present, newest first. */
  versions: string[];
  /** Entries written before the fingerprint existed, so their code is unknown. */
  unfingerprinted: number;
  firstTs?: number;
  lastTs?: number;
  strategies: Record<string, StrategyAccuracy>;
  /** Accuracy split by whether the query's terms exist in the corpus at all.
   *  A vocabulary gap and a ranking error have different fixes, and one mean
   *  over both hides which is dominant. */
  byVocabulary: Stratum[];
  /** Accuracy by query length, because short conversational queries carry
   *  little lexical signal and behave differently from descriptive ones. */
  byQueryLength: Stratum[];
  /** Accuracy by the entity filters the read carried. */
  byScope: Stratum[];
}

export interface ReportOptions {
  /** Keep entries whose codeVersion equals this value. Unknown-version entries
   *  are excluded, since the caller is asking about a specific build. */
  version?: string;
  /** Keep entries whose ts is at or after this ISO date (YYYY-MM-DD). */
  since?: string;
}

function accuracy(rankings: StrategyRanking[], remoteIds: string[][]): StrategyAccuracy {
  const n = rankings.length;
  if (n === 0) {
    return { comparisons: 0, meanNdcg10: 0, meanOverlap10: 0, meanMrr: 0, top1Rate: 0, zero10Rate: 0 };
  }
  let ndcgSum = 0;
  let ndcgN = 0;
  let overlapSum = 0;
  let mrrSum = 0;
  let top1 = 0;
  let zero = 0;
  rankings.forEach((r, i) => {
    const remote = remoteIds[i];
    const nd = ndcgAgainstRemote(r.ids, remote, 10);
    if (nd !== null) {
      ndcgSum += nd;
      ndcgN++;
    }
    const remoteTop10 = new Set(remote.slice(0, 10));
    const localTop10 = r.ids.slice(0, 10);
    overlapSum += localTop10.filter((id) => remoteTop10.has(id)).length;
    mrrSum += r.mrr;
    if (localTop10[0] !== undefined && remote[0] !== undefined && localTop10[0] === remote[0]) top1++;
    if (localTop10.filter((id) => remoteTop10.has(id)).length === 0) zero++;
  });
  return {
    comparisons: n,
    meanNdcg10: ndcgN === 0 ? 0 : ndcgSum / ndcgN,
    meanOverlap10: overlapSum / n,
    meanMrr: mrrSum / n,
    top1Rate: top1 / n,
    zero10Rate: zero / n,
  };
}

function scoreGroup(entries: ShadowEntry[]): Record<string, StrategyAccuracy> {
  const remoteIds = entries.map((e) => e.remote.map((h) => h.id));
  const out: Record<string, StrategyAccuracy> = {};
  for (const { name, read } of STRATEGIES) {
    const rankings: StrategyRanking[] = [];
    const remotes: string[][] = [];
    entries.forEach((e, i) => {
      const r = read(e);
      if (!r) return;
      rankings.push(r);
      remotes.push(remoteIds[i]);
    });
    out[name] = accuracy(rankings, remotes);
  }
  return out;
}

function stratify(entries: ShadowEntry[], key: (e: ShadowEntry) => string, order?: string[]): Stratum[] {
  const groups = new Map<string, ShadowEntry[]>();
  for (const e of entries) {
    const label = key(e);
    const bucket = groups.get(label);
    if (bucket) bucket.push(e);
    else groups.set(label, [e]);
  }
  const labels = order ?? [...groups.keys()].sort();
  return labels
    .filter((label) => groups.has(label))
    .map((label) => ({ label, strategies: scoreGroup(groups.get(label) as ShadowEntry[]) }));
}

/** Query-length buckets. Chosen from the live distribution: 继续 / 好了没 style
 *  queries sit in the first bucket, descriptive ones in the third. */
export function lengthBucket(query: string): string {
  const n = query.trim().length;
  if (n === 0) return "empty";
  if (n <= 8) return "<=8";
  if (n <= 24) return "9-24";
  return ">24";
}

export function buildReport(entries: ShadowEntry[], opts: ReportOptions = {}): ShadowReport {
  const afterDate = opts.since === undefined ? entries : entries.filter((e) => dateOf(e) >= opts.since!);
  const scoped = opts.version === undefined ? afterDate : afterDate.filter((e) => e.codeVersion === opts.version);
  // Only a successful remote read supplies ground truth. A fallback entry has no
  // remote ranking, so there is nothing to agree or disagree with.
  const comparisons = scoped.filter((e) => e.mode === "remote" && e.remote.length > 0);
  const versions = [...new Set(scoped.map((e) => e.codeVersion).filter((v): v is string => typeof v === "string"))].sort().reverse();
  const ts = scoped.map((e) => e.ts);

  return {
    entries: scoped.length,
    comparisons: comparisons.length,
    fallbacks: scoped.filter((e) => e.mode === "fallback").length,
    versions,
    unfingerprinted: scoped.filter((e) => e.codeVersion === undefined).length,
    ...(ts.length > 0 ? { firstTs: Math.min(...ts), lastTs: Math.max(...ts) } : {}),
    strategies: scoreGroup(comparisons),
    byVocabulary: stratify(
      comparisons,
      (e) => ((e.unmatched?.length ?? 0) > 0 ? "terms absent from corpus" : "terms present"),
      ["terms present", "terms absent from corpus"],
    ),
    byQueryLength: stratify(comparisons, (e) => lengthBucket(e.query), ["<=8", "9-24", ">24", "empty"]),
    byScope: stratify(comparisons, (e) => {
      const s = e.scope ?? {};
      const keys = Object.keys(s).sort();
      return keys.length === 0 ? "unscoped" : keys.map((k) => `${k}=${s[k]}`).join(" ");
    }),
  };
}

/** The entry's calendar date in local time, as YYYY-MM-DD. Local time matches
 *  how a person reads "since yesterday" against their own log. */
function dateOf(e: ShadowEntry): string {
  const d = new Date(e.ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One table row per strategy, with the sample size beside every figure so a
 *  thin mean is visible as thin. */
export function formatAccuracyTable(
  strategies: Record<string, StrategyAccuracy>,
  opts: { minComparisons?: number } = {},
): string {
  const min = opts.minComparisons ?? MIN_COMPARISONS;
  const rows = Object.entries(strategies)
    .filter(([, v]) => v.comparisons > 0)
    .sort((a, b) => b[1].meanNdcg10 - a[1].meanNdcg10);
  if (rows.length === 0) return "  (no comparisons)";
  return rows
    .map(([name, v]) => {
      const thin = v.comparisons < min ? `  [n<${min}: indicative only]` : "";
      return `  ${name.padEnd(13)} n=${String(v.comparisons).padStart(4)}  nDCG@10 ${v.meanNdcg10.toFixed(3)}  o@10 ${v.meanOverlap10.toFixed(2)}  top1 ${(v.top1Rate * 100).toFixed(0).padStart(3)}%  zero@10 ${(v.zero10Rate * 100).toFixed(0).padStart(3)}%  MRR ${v.meanMrr.toFixed(3)}${thin}`;
    })
    .join("\n");
}

function formatStrata(strata: Stratum[]): string {
  return strata
    .map((s) => `  ${s.label}\n${formatAccuracyTable(s.strategies)}`)
    .join("\n");
}

/** The full report as text, for a command handler to print. */
export function formatReport(report: ShadowReport, opts: { minComparisons?: number } = {}): string {
  const lines: string[] = [];
  const span =
    report.firstTs !== undefined && report.lastTs !== undefined
      ? `${new Date(report.firstTs).toISOString().slice(0, 10)} .. ${new Date(report.lastTs).toISOString().slice(0, 10)}`
      : "no entries";
  lines.push(`mem0-cache shadow report — ${report.comparisons} comparisons over ${span}`);
  lines.push(
    `  entries ${report.entries}, fallbacks ${report.fallbacks}, versions ${report.versions.join(", ") || "none recorded"}` +
      (report.unfingerprinted > 0 ? `, pre-fingerprint ${report.unfingerprinted}` : ""),
  );
  lines.push("");
  lines.push("local strategy vs remote ranking (the remote API is the reference):");
  lines.push(formatAccuracyTable(report.strategies, opts));
  if (report.byVocabulary.length > 1) {
    lines.push("");
    lines.push("by vocabulary coverage:");
    lines.push(formatStrata(report.byVocabulary));
  }
  if (report.byQueryLength.length > 1) {
    lines.push("");
    lines.push("by query length (characters):");
    lines.push(formatStrata(report.byQueryLength));
  }
  if (report.byScope.length > 1) {
    lines.push("");
    lines.push("by scope:");
    lines.push(formatStrata(report.byScope));
  }
  return lines.join("\n");
}
