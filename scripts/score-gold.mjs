#!/usr/bin/env node
/**
 * Score local recall against the judged gold set.
 *
 * This is the measurement the shadow log could not provide. The shadow log asked
 * "did local reproduce mem0's ordering"; here each candidate carries a graded
 * relevance judgment produced without reference to any retriever, so a scorer is
 * credited for returning relevant memories and penalised for returning irrelevant
 * ones, whatever mem0 happened to do.
 *
 * METRICS
 *   nDCG@10  graded, position-weighted. The headline number: it rewards putting a
 *            grade-2 memory first and a grade-1 memory tenth.
 *   R@10     share of all grade>=1 memories that appear in the top 10.
 *   P@5      precision at 5 over grade>=1.
 *   MRR      reciprocal rank of the first grade>=1 hit.
 *   hit@10   did any relevant memory appear at all.
 * The split between nDCG and R@10 is the one that matters: R@10 says whether the
 * pool contained the answer, nDCG says whether the ranking surfaced it. A wide gap
 * between them is the reranker's justification.
 *
 * Usage:
 *   node scripts/score-gold.mjs                     # score every strategy
 *   node scripts/score-gold.mjs --strategy bm25     # one strategy
 *   node scripts/score-gold.mjs --by-shape          # break the table down by shape
 *   node scripts/score-gold.mjs --json /tmp/o.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};

const GOLD = flag("gold", join(process.cwd(), "gold.json"));
const ONLY = flag("strategy", undefined);
const BY_SHAPE = Boolean(flag("by-shape", false));
const JSON_OUT = flag("json", undefined);
const K = Number(flag("k", 10));

const gold = JSON.parse(readFileSync(GOLD, "utf8"));
const queries = gold.queries.filter((q) => q.grades && Object.keys(q.grades).length > 0);

// ---------------------------------------------------------------------------
// Retriever implementations, mirroring the plugin's channels so the numbers
// describe what ships. Duplication is deliberate: importing the TS source here
// would need a build step in the eval path.

function tokenizeBm25(text) {
  const out = [];
  const lower = text.toLowerCase();
  // Latin/number runs stay whole; CJK becomes overlapping bigrams with a unigram
  // fallback for single-character runs (the same rule as src/recall/bm25.ts).
  const re = /[a-z0-9_]+|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0];
    if (/^[a-z0-9_]+$/.test(tok)) {
      out.push(tok);
      continue;
    }
    if (tok.length === 1) {
      out.push(tok);
      continue;
    }
    for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
  }
  return out;
}

function buildBm25(docs, k1 = 1.2, b = 0.75) {
  const postings = new Map();
  const docLen = [];
  let total = 0;
  docs.forEach((d, i) => {
    const toks = tokenizeBm25(d.text);
    docLen[i] = toks.length;
    total += toks.length;
    const seen = new Map();
    for (const t of toks) seen.set(t, (seen.get(t) ?? 0) + 1);
    for (const [t, tf] of seen) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push({ doc: i, tf });
    }
  });
  const avg = docs.length ? total / docs.length : 0;
  return { docs, postings, docLen, avg, N: docs.length, k1, b };
}

function searchBm25(index, query, limit) {
  const { postings, docLen, avg, N, k1, b } = index;
  const scores = new Map();
  for (const term of new Set(tokenizeBm25(query))) {
    const list = postings.get(term);
    if (!list) continue;
    const df = list.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const { doc, tf } of list) {
      const norm = 1 - b + b * (docLen[doc] / (avg || 1));
      const s = idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      scores.set(doc, (scores.get(doc) ?? 0) + s);
    }
  }
  return [...scores.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, limit)
    .map(([i, score]) => ({ id: index.docs[i].id, score }));
}

/** The pre-BM25 scorer: split CJK per character, score by hit count. */
function searchLegacy(docs, query, limit) {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff\uff00-\uffef]/g) ?? [];
  if (tokens.length === 0) return [];
  return docs
    .map((d) => {
      const text = d.text.toLowerCase();
      let hits = 0;
      for (const t of tokens) if (text.includes(t)) hits++;
      return { id: d.id, score: hits };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function fuseRrf(lists, limit, k = 60) {
  const acc = new Map();
  for (const hits of lists) {
    for (let rank = 0; rank < hits.length; rank++) {
      const id = hits[rank].id;
      acc.set(id, (acc.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

// ---------------------------------------------------------------------------
// Metrics

const gain = (g) => (g >= 2 ? 3 : g === 1 ? 1 : 0);

function ndcg(rankedIds, grades, k) {
  const dcg = rankedIds
    .slice(0, k)
    .reduce((s, id, i) => s + gain(grades[id] ?? 0) / Math.log2(i + 2), 0);
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
  const hits = [];
  for (const { ranked, grades } of rows) {
    ndcgs.push(ndcg(ranked, grades, k));
    const rel = Object.entries(grades)
      .filter(([, g]) => g >= 1)
      .map(([id]) => id);
    const topK = ranked.slice(0, k);
    recall.push(rel.length === 0 ? null : topK.filter((id) => rel.includes(id)).length / rel.length);
    const top5 = ranked.slice(0, 5);
    prec.push(top5.filter((id) => (grades[id] ?? 0) >= 1).length / 5);
    const first = ranked.findIndex((id) => (grades[id] ?? 0) >= 1);
    rr.push(first === -1 ? 0 : 1 / (first + 1));
    hits.push(topK.some((id) => (grades[id] ?? 0) >= 1) ? 1 : 0);
  }
  return {
    n: rows.length,
    ndcg: mean(ndcgs),
    recall: mean(recall),
    prec5: mean(prec),
    mrr: mean(rr),
    hit10: mean(hits),
    // Queries whose pool holds no relevant memory at all: excluded from nDCG and
    // recall (no answer exists), so they are reported separately rather than
    // silently deflating the score.
    empty: rows.filter((r) => !Object.values(r.grades).some((g) => g >= 1)).length,
  };
}

// ---------------------------------------------------------------------------

/** Candidate texts per query, keyed for the retrievers. */
function docsOf(q) {
  return q.pool.map((c) => ({ id: c.id, text: String(c.text ?? "") }));
}

const strategies = {
  legacy: (q) => searchLegacy(docsOf(q), q.query, K),
  bm25: (q) => searchBm25(buildBm25(docsOf(q)), q.query, K),
  /** The pool's own recorded rankings are scored too: they show what the live
   *  channels produced on the real corpus at the time, which the local replay
   *  cannot reconstruct for the dense channel (that needs an API key). */
  remote: (q) => (q.rankings?.remote ?? []).map((id) => ({ id, score: 0 })),
  fusion_recorded: (q) => fuseRrf([[((q.rankings?.bm25 ?? []).map((id) => ({ id, score: 0 })))], [(q.rankings?.dense ?? []).map((id) => ({ id, score: 0 }))]].flat(), K),
};

const names = ONLY ? [ONLY] : Object.keys(strategies).filter((n) => n !== "empty");
const unknown = names.filter((n) => !strategies[n]);
if (unknown.length > 0) {
  console.error(`unknown strategy: ${unknown.join(", ")} (known: ${Object.keys(strategies).join(", ")})`);
  process.exit(1);
}

const rowsByStrategy = {};
for (const name of names) {
  const rows = queries
    .filter((q) => q.pool?.length > 0)
    .map((q) => {
      const ranked = strategies[name](q).map((h) => h.id);
      return { query: q.query, shape: q.shape, ranked, grades: q.grades };
    });
  rowsByStrategy[name] = rows;
}

const pad = (s, w) => String(s).padEnd(w);
console.log(`gold: ${GOLD}  (${queries.length} queries, k=${K})`);
const emptyTotal = rowsByStrategy[names[0]].filter((r) => !Object.values(r.grades).some((g) => g >= 1)).length;
console.log(`queries with no relevant memory in the pool: ${emptyTotal} (excluded from nDCG/recall)\n`);

console.log(`${pad("strategy", 18)} ${"nDCG@10".padStart(8)} ${"R@10".padStart(8)} ${"P@5".padStart(8)} ${"MRR".padStart(8)} ${"hit@10".padStart(8)}`);
console.log("-".repeat(66));
const summary = {};
for (const name of names) {
  const s = score(rowsByStrategy[name]);
  summary[name] = s;
  console.log(
    `${pad(name, 18)} ${s.ndcg.toFixed(3).padStart(8)} ${s.recall.toFixed(3).padStart(8)} ${s.prec5.toFixed(3).padStart(8)} ${s.mrr.toFixed(3).padStart(8)} ${s.hit10.toFixed(3).padStart(8)}`,
  );
}

if (BY_SHAPE) {
  const shapes = [...new Set(queries.map((q) => q.shape))].sort();
  console.log(`\nby shape:`);
  console.log(`${pad("strategy", 18)} ${pad("shape", 11)} ${"nDCG@10".padStart(8)} ${"R@10".padStart(8)} ${"MRR".padStart(8)}`);
  console.log("-".repeat(56));
  const byShape = {};
  for (const name of names) {
    for (const shape of shapes) {
      const rows = rowsByStrategy[name].filter((r) => r.shape === shape);
      if (rows.length === 0) continue;
      const s = score(rows);
      byShape[`${name}|${shape}`] = s;
      console.log(
        `${pad(name, 18)} ${pad(shape, 11)} ${s.ndcg.toFixed(3).padStart(8)} ${s.recall.toFixed(3).padStart(8)} ${s.mrr.toFixed(3).padStart(8)}`,
      );
    }
  }
  summary.byShape = byShape;
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ gold: GOLD, k: K, summary }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
