/**
 * End-to-end check of the resolved pipeline against the real store and the real
 * providers.
 *
 * Opt-in: it reads ~/.pi/agent/mem0-cache.json and calls OpenRouter, so it costs
 * money and depends on network state. Run it explicitly:
 *
 *   MEM0_LIVE=1 npx vitest run test/integration/pipeline.live.ts
 *
 * Without the flag every case is skipped, so `npm test` stays hermetic.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { rankLocal, createDefaultEmbedder, createEmbedHarness, loadVectorStore, makeVectorSaver, loadStore, resolveProviderKey, type LocalStrategy } from "../../src/index.js";
import { createDefaultReranker } from "../../src/recall/rerank.js";
import { resolveStrategy } from "../../src/recall/plan.js";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.MEM0_LIVE === "1";

describe.skipIf(!LIVE)("live pipeline", () => {
const storePath = join(homedir(), ".pi", "agent", "mem0-cache.json");
const vectorsPath = join(homedir(), ".pi", "agent", "mem0-vectors.json");

const store = loadStore(storePath);
const vecStore = loadVectorStore(vectorsPath);
const saveVectors = makeVectorSaver(vecStore, vectorsPath);
const embedder = createDefaultEmbedder();
const embed = embedder ? createEmbedHarness(store, saveVectors, vecStore, embedder) : undefined;
const reranker = createDefaultReranker(resolveProviderKey);

console.log(`store: ${Object.values(store.memories).filter((m) => !m.deleted).length} live memories`);
console.log(`embedder: ${embedder ? embedder.model : "none"}`);
console.log(`reranker: ${reranker ? "configured" : "none"}`);

beforeAll(async () => {
  if (embed) {
    console.log("ensuring vectors…");
    // Bounded by EMBED_MAX_BATCHES_PER_CALL, so this returns in about a minute
    // rather than running the whole backfill inside the hook.
    await embed.ensure();
    const s = embed.status();
    console.log(`  embed layer: ${s.vectors}/${s.corpus} vectors, enabled=${s.enabled}${s.lastError ? `, last error: ${s.lastError}` : ""}`);
  }
}, 180_000);

it("reports the resolution ladder for this machine", () => {
  const caps = { dense: embed !== undefined && embed.status().enabled, rerank: reranker !== undefined };
  console.log(`capabilities: ${JSON.stringify(caps)}`);
  for (const requested of ["auto", "dense+rerank", "dense", "bm25", "fusion"] as LocalStrategy[]) {
    const r = resolveStrategy(requested, caps);
    console.log(`  ${requested.padEnd(13)} -> ${r.plan.strategy.padEnd(13)} ${r.degraded ?? ""}`);
    // Resolution is total: a plan always comes back, and it is always servable.
    expect(r.plan).toBeDefined();
  }
});

// Queries chosen to exercise the channels differently: a CJK topic, an identifier
// shaped Latin string, and a short conversational one with no lexical overlap.
const queries = [
  "报告信息量太低 无法从头串起来",
  "sync-github.sh security design token storage",
  "继续",
];

const scope = { user_id: "artrix", app_id: "hbrw-control" };

it("runs every strategy against the live store", async () => {
for (const q of queries) {
  console.log(`\n${"=".repeat(70)}\nquery: ${q}`);
  for (const strategy of ["bm25", "dense", "dense+rerank", "fusion", "legacy"] as LocalStrategy[]) {
    const t0 = Date.now();
    let reported: string | undefined;
    let degraded: string | undefined;
    const hits = await rankLocal(
      store,
      q,
      {
        embed,
        reranker,
        localStrategy: strategy,
        scope,
        onStrategy: (info) => {
          reported = info.strategy;
          degraded = info.degraded;
        },
      },
      5,
    );
    const ms = Date.now() - t0;
    console.log(`\n  [${strategy}] -> served as ${reported} in ${ms}ms${degraded ? `\n     degraded: ${degraded}` : ""}`);
    for (const h of hits.slice(0, 3)) {
      console.log(`     ${h.id.slice(0, 20)}  ${h.memory.slice(0, 80).replace(/\n/g, " ")}`);
    }
    if (hits.length === 0) console.log("     (no hits)");
  }
}
}, 120_000);

// Confirm the scope filter still applies through the new pipeline: a scope that
// matches nothing must produce no hits, so another app's memories never leak.
it("backfills the whole corpus without losing progress", async () => {
  if (!embed) throw new Error("no embedder configured");
  // The regression this guards: the previous batch-of-256 shape exceeded the
  // request timeout, and the all-or-nothing write discarded every run, so a
  // 4386-memory corpus reported 0 vectors forever. A second regression: one
  // unbounded call ran the whole backfill inside a single await, which blocked
  // the session (and the test hook) for ten minutes. Coverage must now advance in
  // bounded steps and persist each one.
  let previous = -1;
  let stalls = 0;
  for (let round = 1; round <= 40; round++) {
    await embed.ensure();
    const s = embed.status();
    const p = s.lastProgress;
    console.log(
      `  round ${round}: ${s.vectors}/${s.corpus} vectors` +
        (p ? ` (+${p.embedded}, remaining ${p.remaining}, ${p.failedBatches} failed)` : "") +
        `${s.lastError ? ` err=${s.lastError}` : ""}`,
    );
    if (p && p.remaining === 0) break;
    // Two rounds with no progress means the backfill is not going to converge.
    stalls = s.vectors === previous ? stalls + 1 : 0;
    if (stalls >= 2) break;
    previous = s.vectors;
  }
  const final = embed.status();
  console.log(`final coverage: ${final.vectors}/${final.corpus}`);
  expect(final.vectors).toBeGreaterThan(0);
  expect(final.vectors / Math.max(1, final.corpus)).toBeGreaterThan(0.9);
}, 900_000);

it("isolates scope through the new pipeline", async () => {
  const alien = await rankLocal(
    store,
    "报告",
    { embed, reranker, localStrategy: "dense+rerank", scope: { user_id: "nobody", app_id: "no-such-app" } },
    5,
  );
  console.log(`scope isolation: ${alien.length} hits for a scope that owns nothing (expected 0)`);
  expect(alien).toHaveLength(0);
});
});
