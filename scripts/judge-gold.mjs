#!/usr/bin/env node
/**
 * Judge stage-2: grade every candidate in the gold pool for relevance.
 *
 * Reads gold-candidates.json (from scripts/build-gold.mjs), grades each
 * (query, memory) pair, and writes gold.json with the grades folded in.
 *
 * WHY GRADES AND NOT RANKINGS
 * Stage 1 built a retriever-neutral pool; this stage assigns relevance from the
 * query text and the memory text alone. That is the whole point: the shadow log
 * measured "did we reproduce mem0's ordering", which scores a better retriever as
 * worse. Graded relevance answers "is this memory actually relevant", which is
 * the question the ship/no-ship decision needs.
 *
 * CONCURRENCY AND RESUMPTION
 * Judging costs one API call per query (all its candidates go in one call, which
 * keeps the model's view of the candidate set consistent). Calls run through a
 * bounded worker pool and every result is appended to the output file as it
 * lands, so an interrupted run resumes without re-paying for finished queries.
 *
 * USAGE
 *   node scripts/judge-gold.mjs                      # judge, resume if partial
 *   node scripts/judge-gold.mjs --dry-run             # show the prompt, call nothing
 *   node scripts/judge-gold.mjs --concurrency 6       # parallel calls
 *   node scripts/judge-gold.mjs --double 1            # judge twice for agreement
 *   node scripts/judge-gold.mjs --agreement           # report agreement only
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};

const IN = flag("in", join(process.cwd(), "gold-candidates.json"));
const OUT = flag("out", join(process.cwd(), "gold.json"));
const MODEL = flag("model", "glm-5.3-flash");
const BASE_URL = flag("base", "https://api.mind.artrix.tech/v1");
const CONCURRENCY = Number(flag("concurrency", 4));
const DRY_RUN = Boolean(flag("dry-run", false));
const AGREEMENT_ONLY = Boolean(flag("agreement", false));
const DOUBLE = Number(flag("double", 0));
const MAX_CANDIDATE_CHARS = Number(flag("max-chars", 1200));
const CALL_TIMEOUT_MS = Number(flag("timeout", 120_000));

/** The gateway ignores response_format, so the JSON contract lives in the prompt.
 *  Measured: a bare "return one grade per id" produced prose 3/3 times, while an
 *  explicit JSON skeleton with a worked example produced valid JSON 3/3. */
function buildPrompt(entry) {
  const scope = entry.scope
    ? Object.entries(entry.scope)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "(unscoped)";
  const lines = [
    "You are grading how relevant each stored memory is to a user query.",
    "",
    `Query: ${entry.query}`,
    `Scope: ${scope}`,
    "",
    "Grade every memory listed below:",
    "2 = directly answers the query",
    "1 = related and plausibly useful for the query",
    "0 = not relevant to the query",
    "",
    "Judge from the query text and the memory text alone. Ignore length, ordering,",
    "and how specific the wording is. A memory about the same project but a",
    "different topic is 1 at most. A memory from a different project or user is 0.",
    "",
    "Memories:",
  ];
  for (const c of entry.pool) {
    lines.push(`${c.id}: ${String(c.text).slice(0, MAX_CANDIDATE_CHARS).replace(/\s+/g, " ")}`);
  }
  lines.push(
    "",
    "Respond with JSON only, no prose, no code fence:",
    `{"grades":[{"id":"<id>","grade":<0|1|2>}]}`,
    `Include all ${entry.pool.length} ids exactly once, using the ids as given.`,
  );
  return lines.join("\n");
}

/** Pull the first balanced JSON object out of a reply. The gateway wraps JSON in
 *  prose often enough that a strict JSON.parse on the whole body is unreliable. */
function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Last-resort parse for a reply that ignored the JSON instruction entirely:
 *  lines of the form `id: grade`, which is what the bare prompt produced. */
function parseLineForm(text, validIds) {
  const grades = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*[:=]\s*([0-2])\s*$/);
    if (m && validIds.has(m[1])) grades[m[1]] = Number(m[2]);
  }
  return grades;
}

function normalizeGrades(parsed, validIds) {
  const grades = {};
  const list = Array.isArray(parsed?.grades) ? parsed.grades : Array.isArray(parsed) ? parsed : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : typeof item.memory_id === "string" ? item.memory_id : undefined;
    const raw = item.grade ?? item.score ?? item.relevance;
    if (!id || !validIds.has(id)) continue;
    const g = Number(raw);
    // Clamp: a 3 or a fractional score still carries a signal,
    // and dropping it would silently shrink the judged set.
    if (!Number.isFinite(g)) continue;
    grades[id] = g <= 0 ? 0 : g >= 2 ? 2 : g >= 1 ? 1 : 0;
  }
  return grades;
}

function apiKey() {
  const fromEnv = process.env.MEM0_JUDGE_API_KEY ?? process.env.NEWAPI_API_KEY;
  if (fromEnv) return fromEnv;
  const keyFile = process.env.NEWAPI_KEY_FILE ?? join(HOME, ".pi/secrets/hbrw-newapi-pi.key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  const credsFile = `${HOME}/.pi/agent/auth.json`;
  if (existsSync(credsFile)) {
    try {
      const a = JSON.parse(readFileSync(credsFile, "utf8"));
      const k = a?.newapi?.apiKey ?? a?.newapi?.key;
      if (typeof k === "string" && k) return k;
    } catch {
      /* fall through */
    }
  }
  throw new Error(`no judge API key: set NEWAPI_API_KEY or provide ${keyFile}`);
}

async function judgeOnce(key, entry) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: buildPrompt(entry) }],
    // Reasoning must be off: at this model's default the hidden reasoning
    // consumed the entire budget and the visible content came back empty.
    reasoning_effort: "none",
    max_tokens: 4000,
    temperature: 0,
  };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const content = String(json?.choices?.[0]?.message?.content ?? "");
  const validIds = new Set(entry.pool.map((c) => c.id));
  let grades = normalizeGrades(extractJson(content), validIds);
  if (Object.keys(grades).length === 0) grades = parseLineForm(content, validIds);
  return { grades, content, usage: json?.usage };
}

/** Bounded worker pool: keeps the gateway happy and makes progress visible. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
      done++;
      if (done % 10 === 0 || done === total) process.stderr.write(`  ${done}/${total} judged\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// ---------------------------------------------------------------------------

const data = JSON.parse(readFileSync(IN, "utf8"));
let queries = data.queries;

if (DRY_RUN) {
  const q = queries[0];
  console.log(`prompt for the first of ${queries.length} queries (${q.pool.length} candidates):\n`);
  console.log(buildPrompt(q));
  process.exit(0);
}

if (AGREEMENT_ONLY) {
  if (!existsSync(OUT)) throw new Error(`${OUT} not found — run judging first`);
  const graded = JSON.parse(readFileSync(OUT, "utf8"));
  reportAgreement(graded);
  process.exit(0);
}

// Resume: keep anything already graded so an interrupted run does not re-pay.
// Partial coverage counts too — the first full-corpus run reused 24% of its
// candidates from an earlier gold set, so requiring a complete pool would
// re-pay for 373 judgments that already exist.
let existing = null;
if (existsSync(OUT)) {
  try {
    existing = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    /* corrupt partial write: start over */
  }
}
const doneQueries = new Map();
if (existing?.queries) {
  for (const q of existing.queries) {
    if (q.grades && Object.keys(q.grades).length > 0) doneQueries.set(q.query, q);
  }
}

// Grade pool seeded from sibling gold files: the same (query, memory) pair keeps
// its label across rebuilds, so widening the candidate pool costs only the new
// candidates. Without this, every retrieval re-run re-pays for every judgment.
const PRIOR_FILES = ["gold.json", "gold-full.json", "gold-full2.json"].map((f) => join(process.cwd(), f));
const gradePool = new Map();
for (const q of doneQueries.values()) {
  for (const [id, g] of Object.entries(q.grades ?? {})) gradePool.set(`${q.query}\u0000${id}`, g);
}
for (const file of PRIOR_FILES) {
  if (!existsSync(file)) continue;
  try {
    const prior = JSON.parse(readFileSync(file, "utf8"));
    for (const q of prior.queries ?? []) {
      for (const [id, g] of Object.entries(q.grades ?? {})) {
        const key = `${q.query}\u0000${id}`;
        if (!gradePool.has(key)) gradePool.set(key, g);
      }
    }
  } catch {
    /* unreadable sibling: skip it */
  }
}
console.log(`  grade pool: ${gradePool.size} reusable labels from sibling gold files`);

/** ids still lacking a grade for this query. */
function missingIds(q) {
  return q.pool.map((c) => c.id).filter((id) => gradePool.get(`${q.query}\u0000${id}`) === undefined);
}

const todo = queries
  .map((q) => ({ ...q, missing: missingIds(q) }))
  .filter((q) => q.missing.length > 0)
  // Judge only the ids that lack a grade: sending the whole pool would re-pay for
  // the reused candidates and would also drop their existing labels on merge.
  .map((q) => ({ ...q, pool: q.pool.filter((c) => q.missing.includes(c.id)) }));
const alreadyCount = queries.length - todo.length;
console.log(
  `judge: ${queries.length} queries, ${alreadyCount} fully graded, ${todo.length} to run` +
    ` (${todo.reduce((s, q) => s + q.missing.length, 0)} judgments outstanding)` +
    ` (model ${MODEL}, concurrency ${CONCURRENCY})`,
);

const key = apiKey();
const passes = Math.max(1, DOUBLE + 1);

const results = await pool(todo, CONCURRENCY, async (entry) => {
  const passesOut = [];
  for (let p = 0; p < passes; p++) {
    try {
      const r = await judgeOnce(key, entry);
      passesOut.push({ grades: r.grades, tokens: r.usage?.total_tokens ?? 0 });
    } catch (err) {
      passesOut.push({ grades: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { entry, passes: passesOut };
});

// Fold results in, preserving the input order.
const gradedByQuery = new Map();
for (const [query, q] of doneQueries) gradedByQuery.set(query, q);
let ungraded = 0;
let totalTokens = 0;
for (const r of results) {
  const first = r.passes[0] ?? { grades: {} };
  totalTokens += r.passes.reduce((a, p) => a + (p.tokens ?? 0), 0);
  const missing = r.entry.pool.filter((c) => !(c.id in first.grades)).map((c) => c.id);
  if (missing.length > 0) ungraded += missing.length;
  const priorEntry = doneQueries.get(r.entry.query);
  // Union, not replacement: prior labels came from an earlier gold set and are
  // still valid for the ids this run did not resubmit.
  const merged = {};
  for (const c of priorEntry?.pool ?? r.entry.pool) {
    const g = gradePool.get(`${r.entry.query}\u0000${c.id}`);
    if (g !== undefined) merged[c.id] = g;
  }
  Object.assign(merged, first.grades);
  // The full pool lives in the input file; this run received only the subset, so
  // take the widest pool available.
  const fullPool = (priorEntry?.pool?.length ?? 0) >= (r.entry.pool?.length ?? 0) ? priorEntry.pool : r.entry.pool;
  gradedByQuery.set(r.entry.query, {
    query: r.entry.query,
    shape: r.entry.shape,
    scope: r.entry.scope,
    // Carry the pool and the recorded rankings through: the eval script needs the
    // candidate texts to score, and the rankings for a "who found it first" pass.
    pool: fullPool,
    rankings: r.entry.rankings ?? priorEntry?.rankings,
    corpusSize: r.entry.corpusSize ?? priorEntry?.corpusSize,
    grades: merged,
    ...(missing.length > 0 ? { incomplete: missing } : {}),
    ...(r.passes.length > 1 ? { grades_pass2: r.passes[1]?.grades ?? {} } : {}),
    ...(first.error ? { error: first.error } : {}),
  });
}

const graded = queries.map((q) => {
  const g = gradedByQuery.get(q.query);
  if (!g) return { ...q, grades: {}, error: "not judged" };
  return { ...q, ...g };
});

const out = {
  generated_at: new Date().toISOString(),
  source: IN,
  model: MODEL,
  judge_protocol: data.judge_protocol,
  totals: {
    queries: graded.length,
    judgments: graded.reduce((a, q) => a + Object.keys(q.grades).length, 0),
    incomplete_ids: ungraded,
    tokens: totalTokens,
  },
  queries: graded,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`\nwrote ${OUT}`);
console.log(`  queries     ${out.totals.queries}`);
console.log(`  judgments   ${out.totals.judgments}`);
console.log(`  incomplete  ${ungraded} (ids the model skipped)`);
console.log(`  tokens      ${totalTokens}`);
if (out.totals.incomplete_ids > 0) {
  console.log(`\n${out.totals.incomplete_ids} ids were skipped; re-run to retry them (resume skips only fully-graded queries).`);
}
if (DOUBLE > 0) reportAgreement(graded);

function reportAgreement(doc) {
  const qs = doc.queries ?? doc;
  let compared = 0;
  let agree = 0;
  const confusion = {};
  for (const q of qs) {
    const a = q.grades ?? {};
    const b = q.grades_pass2 ?? {};
    for (const id of Object.keys(a)) {
      if (!(id in b)) continue;
      compared++;
      if (a[id] === b[id]) agree++;
      else confusion[`${a[id]}->${b[id]}`] = (confusion[`${a[id]}->${b[id]}`] ?? 0) + 1;
    }
  }
  console.log(`\nsecond-pass agreement: ${agree}/${compared} (${compared ? ((agree / compared) * 100).toFixed(1) : "n/a"}%)`);
  const dis = Object.entries(confusion).sort((x, y) => y[1] - x[1]);
  if (dis.length > 0) console.log("  disagreements:", dis.map(([k, v]) => `${k}=${v}`).join("  "));
}
