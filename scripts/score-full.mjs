#!/usr/bin/env node
/**
 * Score every local strategy against the judged gold set, on the full corpus.
 *
 * THE MEASUREMENT
 * Each scorer ran against every in-scope memory (mean 2567) and returned its own
 * top-K. The judged pool is the union of those top-Ks, so it bounds what got a
 * grade; it never bounded what a scorer could retrieve. A scorer's rank is read
 * from `rankings.<strategy>`, and the metrics consider only its own returned ids.
 * That is the serving-time task.
 *
 * WHY NOT THE FIRST GOLD SET
 * gold.json scored each scorer over a ~19-candidate pool built from recorded
 * top-10s. Every relevant memory was already inside that pool, so it measured
 * reordering rather than retrieval, and it was biased toward whichever retriever
 * contributed the most candidates. gold-full.json removes both problems.
 *
 * METRICS
 *   nDCG@10  graded, position-weighted — the headline. A grade-2 memory in first
 *            place scores 3/log2(2); the same memory tenth scores far less.
 *   R@10     share of all relevant (grade>=1) memories that made the top 10.
 *   P@5      precision over grade>=1 in the top 5.
 *   MRR      reciprocal rank of the first relevant hit.
 *   hit@10   any relevant memory returned at all.
 *   zero@10  returned nothing relevant.
 *
 * nDCG against R@10 is the diagnostic pair: R@10 answers "was the answer
 * reachable", nDCG answers "was it surfaced". A wide gap says the bottleneck is
 * ranking, which is the reranker's job.
 *
 * Usage:
 *   node scripts/score-full.mjs
 *   node scripts/score-full.mjs --by-shape
 *   node scripts/score-full.mjs --json /tmp/scores.json
 *   node scripts/score-full.mjs --compare gold.json    # before/after, same queries
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const has = (name) => argv.includes(`--${name}`);

const GOLD = flag("gold", join(process.cwd(), "gold-full.json"));
const K = Number(flag("k", 10));
const BY_SHAPE = has("by-shape");
const JSON_OUT = flag("json", undefined);
const COMPARE = flag("compare", undefined);

const gold = JSON.parse(readFileSync(GOLD, "utf8"));
// Queries with no grades yet are skipped: the judge runs in the background and a
// partial file must still produce a usable table.
const queries = gold.queries.filter((q) => q.grades && Object.keys(q.grades).length > 0);
const ungraded = gold.queries.length - queries.length;

const gain = (g) => (g >= 2 ? 3 : g === 1 ? 1 : 0);

function ndcg(ranked, grades, k) {
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + gain(grades[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(grades).map(gain).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return idcg === 0 ? null : dcg / idcg;
}

const mean = (xs) => {
  const v = xs.filter((x) => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

function score(rows, k = K) {
  const ndcgs = [];
  const recall = [];
  const prec = [];
  const rr = [];
  const hit = [];
  const zero = [];
  for (const { ranked, grades } of rows) {
    ndcgs.push(ndcg(ranked, grades, k));
    const rel = Object.entries(grades)
      .filter(([, g]) => g >= 1)
      .map(([id]) => id);
    const topK = ranked.slice(0, k);
    recall.push(rel.length === 0 ? null : topK.filter((id) => rel.includes(id)).length / rel.length);
    prec.push(topK.slice(0, 5).filter((id) => (grades[id] ?? 0) >= 1).length / 5);
    const first = ranked.findIndex((id) => (grades[id] ?? 0) >= 1);
    rr.push(first === -1 ? 0 : 1 / (first + 1));
    hit.push(topK.some((id) => (grades[id] ?? 0) >= 1) ? 1 : 0);
    zero.push(topK.some((id) => (grades[id] ?? 0) >= 1) ? 0 : 1);
  }
  return {
    n: rows.length,
    ndcg: mean(ndcgs),
    recall: mean(recall),
    prec5: mean(prec),
    mrr: mean(rr),
    hit10: mean(hit),
    zero10: mean(zero),
    // Rows whose judged pool holds no relevant memory have no answer to find, so
    // they are excluded from nDCG/recall and counted here.
    noAnswer: rows.filter((r) => !Object.values(r.grades).some((g) => g >= 1)).length,
  };
}

// Strategy names come from the recorded rankings, which is what actually ran.
const strategies = [...new Set(queries.flatMap((q) => Object.keys(q.rankings ?? {})))].sort();

const rowsFor = (name, qs) =>
  qs
    .filter((q) => Array.isArray(q.rankings?.[name]))
    .map((q) => ({ query: q.query, shape: q.shape, ranked: q.rankings[name], grades: q.grades }));

const pad = (s, w) => String(s).padEnd(w);
const corpusMean = Math.round(queries.reduce((s, q) => s + (q.corpusSize ?? 0), 0) / (queries.length || 1));

console.log(`gold: ${GOLD}`);
console.log(`${queries.length} queries scored${ungraded ? `, ${ungraded} ungraded (judge still running)` : ""}, k=${K}`);
console.log(`corpus per query: mean ${corpusMean} in-scope memories; judged pool mean ${(queries.reduce((s, q) => s + q.pool.length, 0) / queries.length).toFixed(1)}\n`);

const head = `${pad("strategy", 16)} ${"nDCG@10".padStart(8)} ${"R@10".padStart(8)} ${"P@5".padStart(8)} ${"MRR".padStart(8)} ${"hit@10".padStart(8)} ${"zero@10".padStart(8)} ${"n".padStart(4)}`;
console.log(head);
console.log("-".repeat(head.length));

const summary = {};
for (const name of strategies) {
  const s = score(rowsFor(name, queries));
  summary[name] = s;
  console.log(
    `${pad(name, 16)} ${s.ndcg.toFixed(3).padStart(8)} ${s.recall.toFixed(3).padStart(8)} ${s.prec5.toFixed(3).padStart(8)} ${s.mrr.toFixed(3).padStart(8)} ${s.hit10.toFixed(3).padStart(8)} ${s.zero10.toFixed(3).padStart(8)} ${String(s.n).padStart(4)}`,
  );
}

if (BY_SHAPE) {
  const shapes = [...new Set(queries.map((q) => q.shape))].sort();
  console.log(`\nby shape (nDCG@10 / R@10 / MRR):`);
  console.log(`${pad("strategy", 16)} ${pad("shape", 11)} ${"nDCG".padStart(7)} ${"R@10".padStart(7)} ${"MRR".padStart(7)} ${"n".padStart(4)}`);
  console.log("-".repeat(58));
  const byShape = {};
  for (const name of strategies) {
    for (const shape of shapes) {
      const rows = rowsFor(name, queries).filter((r) => r.shape === shape);
      if (rows.length === 0) continue;
      const s = score(rows);
      byShape[`${name}|${shape}`] = s;
      console.log(
        `${pad(name, 16)} ${pad(shape, 11)} ${s.ndcg.toFixed(3).padStart(7)} ${s.recall.toFixed(3).padStart(7)} ${s.mrr.toFixed(3).padStart(7)} ${String(s.n).padStart(4)}`,
      );
    }
  }
  summary.byShape = byShape;
}

// Same-query before/after against the earlier pool-based gold set. Restricted to
// the queries present in both, since the sets differ in size.
if (COMPARE) {
  const other = JSON.parse(readFileSync(COMPARE, "utf8"));
  const shared = new Set(other.queries.map((q) => q.query));
  const onShared = queries.filter((q) => shared.has(q.query));
  console.log(`\nvs ${COMPARE} on the ${onShared.length} shared queries:`);
  console.log(`${pad("strategy", 16)} ${"full-corpus".padStart(12)} ${"pool-based".padStart(12)} ${"delta".padStart(8)}`);
  console.log("-".repeat(52));
  for (const name of strategies) {
    const full = score(rowsFor(name, onShared));
    // The old file has no per-query rankings for every strategy, so its rows are
    // read from `pool` order where available.
    const oldRows = onShared
      .filter((q) => other.queries.find((o) => o.query === q.query)?.rankings?.[name])
      .map((q) => ({
        ranked: other.queries.find((o) => o.query === q.query).rankings[name],
        grades: other.queries.find((o) => o.query === q.query).grades ?? {},
      }));
    if (oldRows.length === 0) continue;
    const old = score(oldRows);
    const delta = full.ndcg - old.ndcg;
    console.log(
      `${pad(name, 16)} ${full.ndcg.toFixed(3).padStart(12)} ${old.ndcg.toFixed(3).padStart(12)} ${(delta >= 0 ? "+" : "") + delta.toFixed(3)}`.padStart(52),
    );
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ gold: GOLD, k: K, corpusMean, summary }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
