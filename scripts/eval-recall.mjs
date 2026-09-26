/**
 * Offline recall evaluation against the shadow log.
 *
 * The shadow log recorded, for every cache-missed search, the remote mem0
 * ranking (ground truth) next to the ranking the local scorer produced. Two
 * things make it reusable for evaluating a *different* local scorer:
 *
 *  - the log keeps `query` and the remote id list, so any scorer can be replayed
 *    against the same ground truth;
 *  - the mirror (`mem0-cache.json`) holds the memory text, so BM25 can be rebuilt.
 *
 * One caveat this script does not hide: the mirror today is the *post*-harvest
 * corpus, so it contains memories that arrived after some historical queries
 * ran. That biases every scorer optimistically, the old one included. The
 * comparison between scorers stays meaningful because both see the same corpus;
 * absolute numbers should be read as an upper bound.
 *
 * Usage:
 *   node scripts/eval-recall.mjs [--store PATH] [--shadow PATH] [--limit N]
 *                                [--json OUT] [--exclude-dirty]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const STORE = arg("store", join(homedir(), ".pi", "agent", "mem0-cache.json"));
const SHADOW = arg("shadow", join(homedir(), ".pi", "agent", "mem0-shadow.jsonl"));
const LIMIT = Number(arg("limit", "10"));
const JSON_OUT = arg("json", null);
const EXCLUDE_DIRTY = args.includes("--exclude-dirty");
/** Restrict to queries whose every ground-truth id still exists in the mirror.
 *  The mirror only grows, so older queries are missing candidates the scorers
 *  cannot retrieve; this keeps the comparison honest. */
const FAIR_ONLY = args.includes("--fair");

// ---------------------------------------------------------------------------
// Scorers (mirrors of src/recall/bm25.ts and the legacy scorer in src/index.ts)

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** Legacy scorer: single CJK characters, substring match, hit-count ranking. */
function tokenizeLegacy(text) {
  return text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff\uff00-\uffef]/g) ?? [];
}

function searchLegacy(corpus, query, limit) {
  const tokens = tokenizeLegacy(query);
  if (tokens.length === 0) return corpus.slice(0, limit).map((m) => ({ id: m.id, score: 0 }));
  const scored = [];
  for (const m of corpus) {
    const text = m.memory.toLowerCase();
    let score = 0;
    for (const t of tokens) if (text.includes(t)) score++;
    if (score > 0) scored.push({ id: m.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function tokenizeBM25(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  let latin = "";
  let cjkRun = [];
  const flushLatin = () => {
    if (latin) {
      tokens.push(latin);
      latin = "";
    }
  };
  const flushCjk = () => {
    if (!cjkRun.length) return;
    if (cjkRun.length === 1) tokens.push(cjkRun[0]);
    else for (let i = 0; i < cjkRun.length - 1; i++) tokens.push(cjkRun[i] + cjkRun[i + 1]);
    cjkRun = [];
  };
  for (const ch of lower) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (/[a-z0-9_]/.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return tokens;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildBm25Index(docs) {
  const indexed = [];
  const df = new Map();
  let total = 0;
  for (const d of docs) {
    const tokens = tokenizeBM25(d.memory);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    indexed.push({ id: d.id, tf, length: tokens.length });
    total += tokens.length;
  }
  return { docs: indexed, df, avgLength: indexed.length ? total / indexed.length : 0 };
}

function searchBm25(index, query, limit) {
  const n = index.docs.length;
  const terms = [...new Set(tokenizeBM25(query))];
  if (!n || !terms.length) return [];
  const scores = new Map();
  for (const term of terms) {
    const df = index.df.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const doc of index.docs) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const norm = 1 - BM25_B + BM25_B * (index.avgLength === 0 ? 1 : doc.length / index.avgLength);
      scores.set(doc.id, (scores.get(doc.id) ?? 0) + (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Load data

const store = JSON.parse(readFileSync(STORE, "utf8"));
let corpus = Object.values(store.memories).filter((m) => !m.deleted);
if (EXCLUDE_DIRTY) corpus = corpus.filter((m) => m.memory.length <= 4000);
const corpusIds = new Set(corpus.map((m) => m.id));

const shadowAll = readFileSync(SHADOW, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((e) => e.mode === "remote" && Array.isArray(e.remote) && e.remote.length > 0);

const shadow = FAIR_ONLY ? shadowAll.filter((e) => e.remote.every((h) => corpusIds.has(h.id))) : shadowAll;

// ---------------------------------------------------------------------------
// Metrics

function overlapAt(local, remote, k) {
  const r = remote.slice(0, k).map((h) => h.id);
  const l = new Set(local.slice(0, k).map((h) => h.id));
  return r.filter((id) => l.has(id)).length;
}

function reciprocalRank(local, remote) {
  const top = remote[0]?.id;
  if (!top) return 0;
  const i = local.slice(0, 10).findIndex((h) => h.id === top);
  return i >= 0 ? 1 / (i + 1) : 0;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function evaluate(name, scorer) {
  const rows = [];
  for (const e of shadow) {
    const local = scorer(e.query);
    rows.push({
      query: e.query,
      overlap5: overlapAt(local, e.remote, 5),
      overlap10: overlapAt(local, e.remote, 10),
      mrr: reciprocalRank(local, e.remote),
      empty: local.length === 0,
      remoteEmpty: e.remote.length === 0,
      top1InLocal: local.slice(0, 10).some((h) => h.id === e.remote[0]?.id),
    });
  }
  const scored = rows.filter((r) => !r.remoteEmpty);
  return {
    name,
    n: scored.length,
    overlap5: mean(scored.map((r) => r.overlap5)),
    overlap10: mean(scored.map((r) => r.overlap10)),
    mrr: mean(scored.map((r) => r.mrr)),
    top1: scored.filter((r) => r.mrr === 1).length / (scored.length || 1),
    top1Anywhere: scored.filter((r) => r.top1InLocal).length / (scored.length || 1),
    zero: scored.filter((r) => r.overlap5 === 0).length / (scored.length || 1),
    empty: scored.filter((r) => r.empty).length / (scored.length || 1),
    rows,
  };
}

// ---------------------------------------------------------------------------

console.log(`store:  ${STORE}`);
console.log(`shadow: ${SHADOW}`);
console.log(`corpus: ${corpus.length} live memories${EXCLUDE_DIRTY ? " (dirty excluded)" : ""}`);
console.log(`queries: ${shadow.length} remote-mode comparisons${FAIR_ONLY ? " (100% ground-truth coverage only)" : ""}`);
console.log(`mean corpus length: ${mean(corpus.map((m) => m.memory.length)).toFixed(1)} chars\n`);

const index = buildBm25Index(corpus);

const results = [
  evaluate("legacy (single-char includes)", (q) => searchLegacy(corpus, q, LIMIT)),
  evaluate("bm25 + cjk bigram", (q) => searchBm25(index, q, LIMIT)),
];

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f = (x) => x.toFixed(3);

console.log("scorer                        overlap@5   overlap@10   MRR      top1     top1@10   zero@5   empty");
console.log("-".repeat(103));
for (const r of results) {
  console.log(
    `${r.name.padEnd(28)}  ${f(r.overlap5).padStart(8)}   ${f(r.overlap10).padStart(10)}   ${f(r.mrr).padStart(6)}   ${pct(r.top1).padStart(6)}   ${pct(r.top1Anywhere).padStart(7)}   ${pct(r.zero).padStart(6)}   ${pct(r.empty).padStart(5)}`,
  );
}
console.log("");

// Per-scorer wins, restricted to queries where the two disagree at all
const [legacy, bm25] = results;
const deltas = legacy.rows.map((r, i) => ({
  query: r.query,
  dOverlap5: bm25.rows[i].overlap5 - r.overlap5,
  dMrr: bm25.rows[i].mrr - r.mrr,
}));
const better = deltas.filter((d) => d.dOverlap5 > 0 || d.dMrr > 0).length;
const worse = deltas.filter((d) => d.dOverlap5 < 0 || d.dMrr < 0).length;
console.log(`queries where bm25 ranks better: ${better}`);
console.log(`queries where bm25 ranks worse:  ${worse}`);
console.log(`unchanged:                       ${deltas.length - better - worse}`);

// Worst remaining failures, to drive the next iteration
const worst = bm25.rows
  .map((r, i) => ({ ...r, legacyOverlap5: legacy.rows[i].overlap5 }))
  .filter((r) => r.overlap5 === 0)
  .slice(0, 12);
console.log(`\nbm25 still-zero queries (${bm25.rows.filter((r) => r.overlap5 === 0).length} total), first 12:`);
for (const r of worst) {
  console.log(`  [legacy=${r.legacyOverlap5} remoteTop=${r.remoteTop ?? ""}] ${r.query.slice(0, 90).replace(/\n/g, " ")}`);
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      { corpus: corpus.length, queries: shadow.length, results: results.map(({ rows, ...r }) => r) },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${JSON_OUT}`);
}
