#!/usr/bin/env node
/**
 * Retrieve candidates over the FULL scoped corpus, per scorer.
 *
 * WHY THIS EXISTS
 * The first gold set was scored on a ~19-candidate pool assembled from the union
 * of recorded top-10s, then each scorer reordered that pool. That measures the
 * wrong task: at serving time a scorer picks 10 out of ~2600 in-scope memories,
 * so scoring it on 19 pre-selected candidates inflates it (every relevant item is
 * already inside the pool) and biases it toward whichever retriever contributed
 * most of the pool. The pool must decide which candidates get JUDGED, never which
 * candidates a scorer may RETRIEVE.
 *
 * THIS SCRIPT
 * Runs every scorer against the real corpus, independently:
 *   legacy        the pre-BM25 single-character scorer
 *   bm25          BM25 with CJK bigrams
 *   dense         embedding cosine (OpenRouter, cached on disk)
 *   fusion        RRF over bm25 + dense
 *   fusion+rerank fusion, then a cross-encoder reorder (OpenRouter)
 * Collects the UNION of every scorer's top-K as the judging pool, reuses any
 * grade already in gold.json, and writes gold-full.json with the per-scorer
 * rankings attached so the scorer can be re-run later without re-retrieving.
 *
 * Usage:
 *   node scripts/retrieve-full.mjs --dry-run
 *   node scripts/retrieve-full.mjs --k 10 --strategies legacy,bm25,dense,fusion,fusion+rerank
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};

const K = Number(flag("k", 10));
const PER_CHANNEL = Number(flag("per-channel", 50));
const DRY = has("dry-run");
const STRATEGIES = String(flag("strategies", "legacy,bm25,dense,fusion,fusion+rerank,dense+rerank")).split(",");
// Fusion weight for the lexical channel, mirroring LEXICAL_WEIGHT_DEFAULT.
const LEXICAL_WEIGHT = Number(flag("lexical-weight", 0.4));
const GOLD_IN = flag("gold", join(process.cwd(), "gold.json"));
const OUT = flag("out", join(process.cwd(), "gold-full.json"));
const STORE_PATH = flag("store", join(process.env.HOME, ".pi/agent/mem0-cache.json"));
const CACHE = flag("cache", join(process.cwd(), ".embed-cache.json"));
const EMBED_MODEL = flag("embed-model", "qwen/qwen3-embedding-8b");
const RERANK_MODEL = flag("rerank-model", "voyageai/rerank-2.5-lite");
const CONCURRENCY = Number(flag("concurrency", 6));

const RRF_K = 60;
const MAX_DOC_CHARS = 4000;

// ---------------------------------------------------------------------------
// Credentials

function resolveKey(provider) {
  const envName = { openrouter: "OPENROUTER_API_KEY", jina: "JINA_API_KEY" }[provider];
  if (envName && process.env[envName]) return process.env[envName];
  try {
    return execFileSync("security", ["find-generic-password", "-s", `pi-mem0-cache.${provider}`, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
}

const API_KEY = process.env.MEM0_EVAL_API_KEY ?? resolveKey("openrouter");
if (!API_KEY && !DRY) {
  console.error("no OpenRouter key: set OPENROUTER_API_KEY or run ./scripts/setup-key.sh openrouter");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Retrievers (mirroring src/recall/*)

function tokenizeBm25(text) {
  const out = [];
  const re = /[a-z0-9_]+|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
  let m;
  while ((m = re.exec(text.toLowerCase())) !== null) {
    const tok = m[0];
    if (/^[a-z0-9_]+$/.test(tok) || tok.length === 1) out.push(tok);
    else for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
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
  return { docs, postings, docLen, avg: docs.length ? total / docs.length : 0, N: docs.length, k1, b };
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
      scores.set(doc, (scores.get(doc) ?? 0) + idf * ((tf * (k1 + 1)) / (tf + k1 * norm)));
    }
  }
  return [...scores.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, limit)
    .map(([i, s]) => ({ id: index.docs[i].id, score: s }));
}

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

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function fuseRrf(lists, limit, k = RRF_K) {
  // Each list carries its own weight: equal weighting let a broad keyword match
  // displace a semantically correct answer (see src/recall/fusion.ts).
  const acc = new Map();
  for (const { hits, weight = 1 } of lists) {
    for (let rank = 0; rank < hits.length; rank++) {
      const id = hits[rank].id;
      acc.set(id, (acc.get(id) ?? 0) + weight / (k + rank + 1));
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}

// ---------------------------------------------------------------------------
// Embedding with a disk cache: the corpus is re-embedded on every run otherwise,
// and a cache makes iteration on the scoring logic free.

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function loadCache() {
  if (!existsSync(CACHE)) return { model: EMBED_MODEL, vectors: {} };
  const c = JSON.parse(readFileSync(CACHE, "utf8"));
  if (c.model !== EMBED_MODEL) {
    console.error(`embed cache model mismatch (${c.model} vs ${EMBED_MODEL}); ignoring cache`);
    return { model: EMBED_MODEL, vectors: {} };
  }
  return c;
}

async function embedBatch(texts, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, MAX_DOC_CHARS)) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const j = await res.json();
      return { vectors: j.data.map((d) => d.embedding), cost: j.usage?.cost ?? 0 };
    }
    const detail = await res.text().catch(() => "");
    if (attempt === 3) throw new Error(`embed ${res.status} (${label}): ${detail.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error("unreachable");
}

async function ensureVectors(texts, cacheState) {
  const missing = [];
  const seen = new Set();
  for (const t of texts) {
    const h = sha(t);
    if (!cacheState.vectors[h] && !seen.has(h)) {
      seen.add(h);
      missing.push(t);
    }
  }
  if (missing.length === 0) return { embedded: 0, cost: 0 };

  console.log(`  embedding ${missing.length} new texts (~${Math.round(missing.reduce((s, t) => s + t.length, 0) / 3.5 / 1000)}K tokens)`);
  const BATCH = 64;
  let cost = 0;
  let done = 0;
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(group.map((b, gi) => embedBatch(b, `batch ${i + gi + 1}`)));
    for (let gi = 0; gi < group.length; gi++) {
      const batch = group[gi];
      const { vectors, cost: c } = results[gi];
      cost += c;
      batch.forEach((t, j) => {
        cacheState.vectors[sha(t)] = vectors[j];
      });
      done += batch.length;
    }
    console.log(`    ${done}/${missing.length}`);
  }
  return { embedded: missing.length, cost };
}

async function rerankDocs(query, docs) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: docs.map((d) => d.slice(0, MAX_DOC_CHARS)),
        top_n: docs.length,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const j = await res.json();
      return { results: j.results ?? j.data ?? [], cost: j.usage?.cost ?? 0 };
    }
    const detail = await res.text().catch(() => "");
    if (attempt === 3) throw new Error(`rerank ${res.status}: ${detail.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Scope filtering, mirroring src/recall/scope.ts

const SCOPE_KEYS = ["user_id", "agent_id", "app_id", "run_id"];

function matchesScope(memory, scope) {
  if (!scope) return true;
  for (const [key, want] of Object.entries(scope)) {
    if (!SCOPE_KEYS.includes(key)) continue;
    if (want === undefined || want === null || want === "*") continue;
    const have = memory[key];
    if (have !== want) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

const store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
const live = Object.values(store.memories).filter((m) => !m.deleted);
console.log(`corpus: ${live.length} live memories, ${live.reduce((s, m) => s + m.memory.length, 0).toLocaleString()} chars`);

const gold = JSON.parse(readFileSync(GOLD_IN, "utf8"));
const queries = gold.queries;
console.log(`gold in: ${queries.length} queries`);

// Every prior grade, so a re-judged candidate reuses its label.
const priorGrades = new Map();
for (const q of queries) for (const [id, g] of Object.entries(q.grades ?? {})) priorGrades.set(`${q.query}\u0000${id}`, g);

const cacheState = loadCache();
let totalEmbedCost = 0;
let totalRerankCost = 0;

// The corpus text per query: scope-filtered, and the texts needing vectors.
const perQuery = queries.map((q) => {
  const scoped = live.filter((m) => matchesScope(m, q.scope));
  return { q, scoped, docs: scoped.map((m) => ({ id: m.id, text: m.memory })) };
});

if (DRY) {
  const counts = perQuery.map((p) => p.scoped.length);
  console.log(`\n[dry-run] scope-filtered corpus sizes: min ${Math.min(...counts)}, max ${Math.max(...counts)}, mean ${Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)}`);
  const allTexts = new Set();
  for (const p of perQuery) for (const d of p.docs) allTexts.add(d.text);
  const uncached = [...allTexts].filter((t) => !cacheState.vectors[sha(t)]);
  console.log(`[dry-run] unique corpus texts: ${allTexts.size}, uncached: ${uncached.length}`);
  console.log(`[dry-run] embed cost if cold: $${(uncached.reduce((s, t) => s + t.length, 0) / 3.5 / 1e6 * 0.01).toFixed(5)}`);
  console.log(`[dry-run] query embeddings: ${queries.length}`);
  const rerankStrategies = ["fusion+rerank", "dense+rerank"].filter((s) => STRATEGIES.includes(s));
  console.log(`[dry-run] rerank calls: ${rerankStrategies.length * queries.length} (${rerankStrategies.join(" + ") || "none"}, 1 per query each)`);
  console.log(`[dry-run] strategies: ${STRATEGIES.join(", ")}`);
  process.exit(0);
}

// Embed the corpus once (deduped across queries) and the queries themselves.
const corpusTexts = [...new Set(perQuery.flatMap((p) => p.docs.map((d) => d.text)))];
console.log(`\ncorpus vectors: ${corpusTexts.length} unique texts`);
const corpusEmbed = await ensureVectors(corpusTexts, cacheState);
totalEmbedCost += corpusEmbed.cost;
console.log(`queries to embed: ${queries.length}`);
const queryEmbed = await ensureVectors(queries.map((q) => q.query), cacheState);
totalEmbedCost += queryEmbed.cost;
writeFileSync(CACHE, JSON.stringify(cacheState));
console.log(`embed cache written (${Object.keys(cacheState.vectors).length} vectors)`);

// ---------------------------------------------------------------------------
// Retrieve per query, per strategy.

const result = [];

for (let qi = 0; qi < perQuery.length; qi++) {
  const { q, docs } = perQuery[qi];
  const qvec = cacheState.vectors[sha(q.query)];
  const rankings = {};

  const bm25Index = STRATEGIES.some((s) => ["bm25", "fusion", "fusion+rerank"].includes(s))
    ? buildBm25(docs)
    : null;

  if (STRATEGIES.includes("legacy")) {
    rankings.legacy = searchLegacy(docs, q.query, PER_CHANNEL).map((h) => h.id);
  }
  if (bm25Index) {
    rankings.bm25 = searchBm25(bm25Index, q.query, PER_CHANNEL).map((h) => h.id);
  }
  const NEEDS_DENSE = ["dense", "fusion", "fusion+rerank", "dense+rerank"];
  let denseRanked = null;
  if (STRATEGIES.some((s) => NEEDS_DENSE.includes(s))) {
    const scored = [];
    for (let i = 0; i < docs.length; i++) {
      const v = cacheState.vectors[sha(docs[i].text)];
      if (v) scored.push({ id: docs[i].id, score: cosine(qvec, v) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    denseRanked = scored.slice(0, PER_CHANNEL);
    if (STRATEGIES.includes("dense")) rankings.dense = denseRanked.map((h) => h.id);
    if (STRATEGIES.includes("fusion") || STRATEGIES.includes("fusion+rerank")) {
      const bm25 = searchBm25(bm25Index, q.query, PER_CHANNEL);
      rankings.fusion = fuseRrf(
        [
          { hits: bm25, weight: LEXICAL_WEIGHT },
          { hits: denseRanked, weight: 1 },
        ],
        PER_CHANNEL,
      ).map((h) => h.id);
    }
  }

  const textOf = new Map(docs.map((d) => [d.id, d.text]));

  // Reranking runs on whichever pool the strategy produced. Each strategy gets
  // its own rerank call, so the two are compared on their real pools.
  for (const [name, poolIds] of [
    ["fusion+rerank", rankings.fusion],
    ["dense+rerank", rankings.dense],
  ]) {
    if (!STRATEGIES.includes(name) || !poolIds) continue;
    const pool = poolIds.slice(0, PER_CHANNEL);
    const texts = pool.map((id) => textOf.get(id) ?? "");
    const { results, cost } = await rerankDocs(q.query, texts);
    totalRerankCost += cost;
    const order = results.map((r, i) => ({ id: pool[r.index ?? i], score: r.relevance_score ?? r.score ?? 0 }));
    rankings[name] = order.filter((r) => r.id).map((r) => r.id);
  }

  // Judging pool: the union of every scorer's top-K. The pool bounds what gets
  // judged; each scorer is scored only on its own returned ids.
  const poolIds = [...new Set(STRATEGIES.flatMap((s) => (rankings[s] ?? []).slice(0, K)))];
  const reused = poolIds.filter((id) => priorGrades.has(`${q.query}\u0000${id}`)).length;

  result.push({
    query: q.query,
    shape: q.shape,
    scope: q.scope,
    corpusSize: docs.length,
    pool: poolIds.map((id) => ({ id, text: (textOf.get(id) ?? "").slice(0, 1200) })),
    rankings: Object.fromEntries(Object.entries(rankings).map(([k, v]) => [k, v.slice(0, K)])),
    grades: Object.fromEntries(
      poolIds.filter((id) => priorGrades.has(`${q.query}\u0000${id}`)).map((id) => [id, priorGrades.get(`${q.query}\u0000${id}`)]),
    ),
    reused,
  });

  if ((qi + 1) % 10 === 0 || qi === perQuery.length - 1) {
    console.log(`  retrieved ${qi + 1}/${perQuery.length}`);
  }
}

writeFileSync(CACHE, JSON.stringify(cacheState));
writeFileSync(OUT, JSON.stringify({ generatedAt: null, k: K, perChannel: PER_CHANNEL, strategies: STRATEGIES, queries: result }, null, 2));

const totalPool = result.reduce((s, r) => s + r.pool.length, 0);
const totalReused = result.reduce((s, r) => s + r.reused, 0);
console.log(`\nwrote ${OUT}`);
console.log(`  queries      ${result.length}`);
console.log(`  pool size    ${totalPool} (mean ${(totalPool / result.length).toFixed(1)} per query)`);
console.log(`  grades reused ${totalReused} (${((100 * totalReused) / totalPool).toFixed(0)}%)`);
console.log(`  to judge     ${totalPool - totalReused}`);
console.log(`  embed cost   $${totalEmbedCost.toFixed(5)}`);
console.log(`  rerank cost  $${totalRerankCost.toFixed(5)}`);
console.log(`  total cost   $${(totalEmbedCost + totalRerankCost).toFixed(5)}`);
