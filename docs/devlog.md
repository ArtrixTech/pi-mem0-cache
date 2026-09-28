# devlog

## fix(memory): make the quarantine append safe to repeat

`103c0f8` | 2026-09-28

- **Changes**: `appendQuarantine` replaces the exists-then-append pair with a read-merge-rename keyed by id. `src/memory.ts`. Two clamp tests added.
- **Reason**: The live sidecar held 28 lines for 5 ids. Two duplicates came from concurrent sessions clamping the same record: both read a file without the id, both appended the full original text. The old check compared a JSON substring, so it also depended on the exact serialization.
- **Process**: Found while auditing the sidecar that the review had flagged. The reviewer predicted growth on every load; that part was wrong, since the check did hold for repeated sequential loads. The real defect was narrower — a lost race, plus 23 lines of this session's test fixtures sitting in the live file.
- **Result**: 28 lines / 1.9 MB to 2 lines / 52 KB, holding the two real records (21,984 and 29,726 chars, truncated to the 4,000-char cap in the mirror). 248 tests.
- **Notes**: The quarantined originals are now the only copy, since the mirror keeps the clamped text.
  - A first test could not exercise the race at all: `clampMemory` writes synchronously, so `Promise.all` over it serializes regardless. Replaced with a test of what the function does guarantee — one entry per id across repeats, other ids preserved.
  - Cleanup script bug worth remembering: a `.filter` callback pushed ids while the loop pushed lines, so `JSON.parse` received a bare id. It threw before the write and left the file intact; content and line count were verified on both sides of it.

## fix(store): consume the wipe marker on the save that acts on it

`48dbefd` | 2026-09-28

- **Changes**: `mergeFromDisk` deletes `store.wipedAt` as part of the merge that honours it. `src/store.ts`. Two bm25/scope test comments reworded.
- **Reason**: The marker suppressed the disk basis for every later save, so a session that cleared twice discarded concurrent writes from other sessions.
- **Process**: Caught while reviewing the wipe fix I had just written, by asking what the second save of the same session does. The written file is the record of the wipe, so the marker has nothing left to say.
- **Result**: A second save in the wiping session stays cleared, and later sessions in other processes resume merging normally. 246 tests at the time.
- **Notes**: The clear site is single (`/mem0-cache clear-all`); `harvestMemories` merges by id rather than replacing the map, which is what makes the empty-map case unambiguous once the marker is consumed.

## fix(store,sync,writes): make the concurrent-session merge non-destructive

`98c02fd` | 2026-09-28

- **Changes**: Seven defects found by an independent adversarial review of the six-commit batch, each fixed with a regression test (`test/review-findings.test.ts`, 13 tests).
  - `Store.wipedAt` is set by `/mem0-cache clear-all`, and `mergeFromDisk` bases its result on the disk corpus only when no wipe was recorded. `src/store.ts`, `src/types.ts`, `src/index.ts`.
  - `loadStore` bumps `updated_at` when it clamps an oversized record, and `mergeFromDisk` prefers an in-memory `overflow` record on a timestamp tie. `src/store.ts`.
  - A retired op is removed from `store.ops`. `src/sync.ts`. The queue carries its `PendingOp` so retirement can find it.
  - `mergeFromDisk` unions `syncState.quarantined` and `syncState.failures`, takes the max for `backoffUntil`/`lastAttemptAt`/`readsBlockedUntil`, and takes the max of numeric `stats` counters. `src/store.ts`.
  - `isPermanentStatus` treats 401, 403 and 404 as transient. `src/sync.ts`.
  - `applyLocalWrite` drops a `*`-valued entity filter. `src/writes.ts`.
  - The delete branches bump `updated_at` on the tombstone. `src/writes.ts`.
  - `noUnusedLocals` enabled, and 21 unused imports/declarations removed across `src` and `test` that the module split left behind. `tsconfig.json`.
- **Reason**: Every one of these is reachable in ordinary use, and four reproduce the exact failure the merge was written to prevent. Full detail per finding in Notes.
- **Process**: Ran each finding as an executable probe before touching code (`/tmp/verify-findings.mts`), then wrote the 10 failures as tests against the unmodified tree and confirmed each one failed for the stated reason. One finding did not survive verification — see Notes.
- **Result**: 246 passed | 4 skipped, `tsc --noEmit` and `--noUnusedLocals` both clean, `madge --circular` clean, contrastive-rhetoric sweep empty. Live store round-trips losslessly at 4462 memories with syncState, stats and cache intact, and the one pending memory uploaded on the first attempt once the backoff was lifted.
- **Notes**:
  - Finding 2 was partly wrong: the reviewer predicted the quarantine sidecar grew once per load, and it does not — `appendQuarantine` already skipped a repeated id. The real defect was upstream of that, in the clamp never reaching the disk copy, so every later load re-clamped the same record. The persistence half was correct and is fixed; the sidecar half needed no change.
  - The clamp and the wipe are the same shape of bug. Both were a local decision that the merge could not distinguish from the absence of one: an empty map read as "not loaded yet", a clamped record read as "same as the disk copy". Each fix records the decision explicitly.
  - Classifying 401/403 as permanent means three sync runs against a rotated token retire every pending memory. The memory text survives locally, so the damage is a memory that never uploads, recoverable only by hand.
  - 404 belongs on the same side as the other non-payload failures: the add URL is endpoint-level, so a 404 signals a wrong origin or path, and a genuine server-side duplicate arrives as 200.
  - The op-retirement defect was invisible because `quarantine()` deleted the failure counter: the counter restarted every third run, so the log line read like a fresh retirement each time.
  - A retired op is dropped from the queue with no re-queue path. That is deliberate for `write-delete-all`, where a replay is destructive, and it means recovery is a manual edit of the store. Revisit if an op kind appears that is expensive to recreate and safe to replay.

## fix(sync): touch updated_at when a local memory uploads

`da64021` | 2026-09-28

- **Changes**: `replayAdd` marks the record `observed` and now also sets `updated_at`. One line.
- **Reason**: sync reported success while the record stayed queued. The merge guard resolves a shared id by `updated_at`, and the disk copy carried the same timestamp as the in-memory one, so the merge took the disk side and discarded the `observed` transition — a memory that had uploaded was re-uploaded every run.
- **Process**: observed the live store immediately after a sync that reported `uploaded 1, pending 0`: the file still read `source: local`. Traced into the merge, then confirmed the in-memory state itself was correct and only the persisted copy was stale.
- **Result**: sync drains to `pending 0` and the store agrees. 226 tests, typecheck clean.
- **Notes**: my first theory — millisecond precision loss in `Date.parse` — was wrong; a round-trip through `toISOString()` is exact. The real cause was a write that never bumped the field the merge reads. Worth remembering when a merge silently prefers one side.

## fix(write,sync): capture write scope, and repair a memory stored without one

`80eceab` | 2026-09-28

- **Changes**: `applyLocalWrite` reads entity keys from the request query string, with body keys merged over them. `sync` repairs a payload that has no entity id from the corpus scope. `ENTITY_FILTER_KEYS` moved to `types.ts`.
- **Reason**: a locally-stored memory could never sync. Probing the wire showed the payload carried no entity id and mem0 refuses that outright: HTTP 400 "At least one entity ID is required (user_id, agent_id, app_id, or run_id)". The same payload plus a scope returned 200.
- **Process**: reproduced both outcomes against the live API before changing code. Then synced a scratch copy of the real store, which showed `uploaded 1, failed 0, pending 0`. Two existing sync tests failed on the first attempt at the repair — my "skip when no scope exists" rule short-circuited them — and the frozen behaviour (attempt as captured, let the server decide) is the one that kept the suite green.
- **Result**: verified end to end on the live store; the record is now `observed`. 226 tests, typecheck clean, no circular dependencies.
- **Notes**: the SDK sends v3 add scope through the query string, so any code reading only the body captures an empty payload. `ENTITY_FILTER_KEYS` had to leave `interceptor.ts` because importing it from there put `writes.ts` in a cycle.

## refactor: split src/index.ts into cohesive modules

`64a4f4f` | 2026-09-28

- **Changes**: 2685 lines of `index.ts` became 500 lines of extension wiring plus ten modules: `types` (176), `store` (147), `request` (77), `memory` (107), `rank` (179), `writes` (134), `shadow` (397), `embed` (571), `interceptor` (324), `sync` (333), `credentials` (54). Every moved symbol is re-exported, so no test import path changed.
- **Reason**: eight unrelated responsibilities in one file, against the repo's own architecture rule that each component maps to a predictable location.
- **Process**: two scripted extraction passes. The first died on a brace counter that mis-fired on regex literals and strings containing braces; the reliable path was measuring each block's first and last line, verifying them by printing, and cutting explicit ranges. Import rewiring was computed last, after every body was known, which keeps cross-module references correct regardless of extraction order. Verified with `madge`: no cycles.
- **Result**: dependencies point one way — types, then store/memory/request, then rank/writes/shadow/embed, then interceptor/sync, then index. 226 tests, typecheck clean.
- **Notes**: two moves were forced by the direction. `LocalStrategy` lives in `types.ts` because the `Store` shape references it, and `credentials.ts` came out of the entry because both the embedder and the reranker resolve keys. This commit also rewrote 29 comments that used contrastive framing.

## fix(sync,store): drain the queue past a poison pill, clamp on load, survive exits

`120713e` | 2026-09-28

- **Changes**: sync classifies replay failures (permanent 4xx vs transient 5xx/408/429), retires an item after three permanent failures, and continues past a failure. `loadStore` clamps oversized memories. `makeSaver` flushes on `exit`/`SIGINT`/`SIGTERM` and merges with the disk copy before writing. `SyncState` gained `failures` and `quarantined`.
- **Reason**: one 250,819-char memory held the queue closed for over a week and the same record kept returning to the corpus after deletion. Four defects sat behind that.
- **Process**: the loop `break`ed on the first failure, and the poisoned memory sorted first by `created_at`, so four ordinary memories behind it never uploaded. The load path had no size check, so a record already on disk outlived both its deletion and the harvest guard. `makeSaver` debounced 300ms and returned, so a process exiting inside that window lost its write — observed directly, a save followed by immediate exit never changed the file's mtime. And 15 pi sessions share one store file, each writing the whole thing back, so a session holding an older copy restored records another had deleted.
- **Result**: live store 4.58MB -> 4.34MB, largest memory 250,820 -> 4,000 chars, unuploadable record retired with its original text preserved in the quarantine sidecar. 225 tests, typecheck clean.
- **Notes**: the multi-process overwrite is the mechanism by which the poison record returned a second time, and it is why the fix had to be installed before it held — running sessions with the old code kept clobbering the repair.


## perf(embed): cache query vectors, separate transient failures from layer faults

`d8e457c` | 2026-09-27

- **Changes**: query embeddings cached in a bounded 256-entry map keyed by query text. `search` no longer routes a query-embedding failure into `fail()`; a new `errorKind` distinguishes transient (this query's embedding) from persistent (corpus backfill) faults, and only the persistent kind sets the 60s cooldown or reports `enabled: false`. `ensureEmbeddings` now returns `batches` alongside `failedBatches`, and the harness calls `fail()` when every attempted batch failed.
- **Reason**: live measurement of a dense read showed 1.3-5.0s in the query embedding round trip against 39ms of local work (filter 4396 memories, intersect with vectors, score and sort 4096-dim vectors, 37ms). Two defects followed from one failure policy: a single query timeout disabled dense retrieval for a full minute (observed — a dense+rerank read timed out and the next three reads all degraded to bm25), and repeated identical queries re-paid the round trip.
- **Process**: instrumented the live provider to separate query-embed latency (1.3s/4.9s/4.1s across three identical calls) from the local scan (37ms), which located the bottleneck outside the code. Traced why the cooldown never cleared: `ensureEmbeddings` catches per batch, so a run where all batches failed returned normally and `fail()` was never reached. TDD — 4 cases in test/embed.test.ts rewritten or added first; the existing "falls back to null on failure" case was itself mislabelled (it exercised the query path while asserting the corpus path).
- **Result**: live suite 4/4 with zero degradation; file duration 74.6s -> 13.4s. dense 2196-3696ms, dense+rerank 1024-1786ms, fusion 28-42ms, bm25 7-14ms. 214 tests, typecheck clean.
- **Notes**: `fusion` at 28ms reflects the query cache hitting on a repeat; a cold fusion read is bounded by one query embedding. The local scan is 37ms and is now the floor for a warm read.

## feat(recall): weighted RRF, and document the measured pipeline

`80231b0` | 2026-09-27

- **Changes**: `fuseRrf` scales each channel by `weight/(K+rank)`; `LEXICAL_WEIGHT_DEFAULT = 0.4` (env `MEM0_FUSION_BM25_WEIGHT`, 1 restores equal weights). `fusion+rerank` degrades to `dense`. README rewritten around the staged pipeline, the resolution ladder with measured numbers, why BM25 left the serving path, the full-corpus eval commands, and an env/credentials table.
- **Reason**: equal channel weighting assumes comparable information value, and on this corpus they are not comparable. A query about the term "waveterminal" produced ten BM25 candidates that all graded 0 while dense ranked a grade-2 memory first; the ten collected RRF points, three outscored the correct answer, and a correct top-1 became rank 5.
- **Process**: traced the failure query rank-by-rank through the RRF accumulation (`bm25:4 dense:5` on three grade-0 memories above `dense:1` on a grade-2). Ran a weight sweep on the gold set: equal 0.564/0.590, x0.5 0.667, x0.3 0.666, adaptive 0.673, dense-only 0.694 — every weight beat equal, none reached single-channel dense, which is why BM25 left the serving path entirely.
- **Result**: fusion nDCG@10 0.590 -> 0.633. 212 tests, typecheck clean.
- **Notes**: the sweep is reproducible via `scripts/score-full.mjs`; the weight is a corpus property, and a future corpus with different lexical characteristics deserves re-running the comparison.

## feat(eval): full-corpus retrieval harness, gold-set scoring, reliable key entry

`1752d04` | 2026-09-27

- **Changes**: `scripts/retrieve-full.mjs` runs every strategy against the real in-scope corpus and returns each strategy's own top-K; the judged pool is the union of those top-Ks. `scripts/score-full.mjs` reports nDCG@10/R@10/P@5/MRR/hit@10/zero@10, optionally by query shape. `judge-gold.mjs` keeps a grade pool across gold files. `setup-key.sh` now delegates to `scripts/ask-secret.mjs`.
- **Reason**: the first gold set scored each strategy over a ~19-candidate pool assembled from recorded top-10s, then had each strategy reorder that pool. That measures reordering, not retrieval, and it biased the result toward whichever retriever contributed the most candidates — measured 342 candidates appearing only in the remote list, 557 only in the local lists, 63 shared.
- **Process**: probed the pool's source composition before trusting the numbers, which is what exposed the bias. Ran the full-corpus harness over 57 queries (mean 2570 in-scope memories) at $0.009, then judged 1576 pairs. Also reproduced the key-entry failure: `read -s -p ... </dev/tty` returned a single stray byte under the user's terminal wrapper and stored it silently, leaving a one-character key that failed every request.
- **Result**: 57 queries / 1576 judgments. dense+rerank 0.821, fusion+rerank 0.821, dense 0.677, fusion 0.633, bm25 0.346, legacy 0.241. Grade pool reused 2247 labels, cutting 173 outstanding judgments to 16. 209 tests, typecheck clean.
- **Notes**: `nDCG` against `R@10` is the diagnostic pair — R@10 says whether the answer was reachable, nDCG whether it was surfaced. The reranker equalises the fusion and dense pools (both 0.821), which is what justified dropping fusion from the serving path.

## fix(embed): bound the backfill, persist per batch, cap inputs

`7ccbf8f` | 2026-09-27

- **Changes**: batches are 64 inputs or 16K chars (env `MEM0_EMBED_BATCH_SIZE`); each successful batch persists the sidecar immediately; a failed batch is recorded and skipped; calls are capped at 8 batches (env `MEM0_EMBED_MAX_BATCHES`) with the next call resuming from the sidecar. Local writes enforce the harvest size bound via a shared `clampMemory`. The embedder caps each input at 8000 chars. Vectors are stored unit-length (normalised once at write) with a `normalized` flag migrating older sidecars.
- **Reason**: the layer never converged — 4386 memories reported 0 vectors on every call, so `auto` resolved to BM25 forever. Three defects compounded: 256 memories per request exceeded the timeout; the all-or-nothing write discarded the whole pass on any failure; and one unbounded call ran the entire ~10-minute backfill inside a single await.
- **Process**: measured the provider directly — 64 inputs 9.4s, 256 inputs 16.1s against a 15s ceiling, which pinned the batch size as the cause. Verified convergence live: coverage advanced 768 -> 1726 -> 2199 -> 2711 -> 3223 -> 3735 -> 4140 -> 4395 across bounded rounds, surviving a timeout in round 1 and a provider 400 in round 6. The single permanently-failing memory was the same 250,819-char record quarantined earlier, re-entered through the unguarded `write-add` path with `delivery: failed, Upload rejected (HTTP 400)`. Benchmarked the normalisation change on the live sidecar: 5656ms -> 49ms, 115x, identical top-10.
- **Result**: 4395/4396 coverage, then 4396/4396 after removing the poison pill (quarantined with sha256). 207 tests, typecheck clean.
- **Notes**: an unclamped 250,819-char memory produced HTTP 400 for its entire batch, so one bad record could stall the layer permanently — the input cap is what makes that a per-memory degradation. The local write path lacked the guard the harvest path had; both now share `clampMemory`.

## feat(recall): strategy registry, auto resolution, and cross-encoder reranking

`ef0b71a` | 2026-09-27

- **Changes**: `src/recall/plan.ts` — plan registry, preference ladders, `resolveStrategy` returning the chosen plan plus every skip and its reason. `src/recall/rerank.ts` — OpenRouter cross-encoder over the fused pool, default `voyageai/rerank-2.5-lite`. Default strategy becomes `auto`. `RankLocal` resolves a plan; reranking receives a text resolver.
- **Reason**: the strategy was a string compared against literal lists across `rankLocal`, and the default was fusion — which the gold set showed costs more than it adds once a reranker is present.
- **Process**: verified both OpenRouter endpoints before wiring (embeddings 4096 dims at $0.00000015 for 15 tokens; rerank ordering correctly at $0.0000006 for 30 tokens). Noted that `FusedHit` carries only ids, so the reranker had no documents to score — the text resolver closes that gap. Added 12 rerank tests and 21 plan tests, including an invariant that every ladder terminates in a plan needing no capability, which makes resolution total.
- **Result**: ladder `dense+rerank -> dense -> bm25`, every step reported with its reason. 209 tests, typecheck clean.
- **Notes**: a plan is chosen from measured NDCG, and each plan carries its number so the shipped default is traceable. Fusion stays registered and reachable so the comparison remains reproducible.

## feat(eval): candidate-pool and sampling stage for a gold set

`a27e828` | 2026-09-27

- **Changes**: `scripts/build-gold.mjs` — credential-free; reads the store and shadow log, filters noise, dedupes queries, builds a per-query candidate pool as the union of every recorded ranking intersected with ids the mirror still holds, stratifies by query shape, samples deterministically (mulberry32, seed default 20260927), and writes `gold-candidates.json` with the judging protocol embedded.
- **Reason**: the shadow log scores local recall against mem0's own top-10, which measures imitation. A local retriever that answers better than mem0 scores worse under that metric, and mem0's misses are inherited as truth.
- **Process**: added a pool-domination statistic specifically to detect the bias the union design guards against — measured dense 46.9%, remote 44.7%, local 40.6%, so the pool is retriever-neutral in practice. Tightened noise filtering across three passes after inspecting the samples (quoted paths, bracketed diagnostics, `Task:` subagent dispatches, scratch probes).
- **Result**: 448 shadow entries -> 314 eligible queries -> 57 sampled (terse-cjk 11, cjk-only 20, mixed 20, latin 6).
- **Notes**: a pool built from one retriever can never contain another's correct answer, which is the whole reason for the union. `gold.json` and `gold-candidates.json` are gitignored build artifacts keyed to a corpus snapshot.

## docs: rewrite contrastive comments as direct statements

`3942995` | 2026-09-27

- **Changes**: swept `src/index.ts`, `src/recall/*.ts`, and every test file for contrastive patterns and rewrote each hit as an additive statement. No behaviour change.
- **Reason**: house writing rule — no contrastive or negation-pivot rhetoric in any medium, code comments and test names included.
- **Process**: grep sweep across the banned Chinese and English forms; the sweep now returns empty.
- **Result**: 158 tests still pass; typecheck clean.
- **Notes**: comments state what the code does and why, without framing it against what it replaced.

## fix(scope): isolate local reads by request scope, classify v3 paths

`d7ba14e` | 2026-09-27

- **Changes**: `src/recall/scope.ts` — scope key extraction from both carriers (body and query string), matching, and corpus filtering before ranking. `rankLocal` takes a scope and filters before any channel sees the corpus; the embed harness intersects its results with the scoped id set. `read-getall` previously answered with every memory of every app. `classify()` widened from `/v1/memories/<id>` to `/v[13]/`.
- **Reason**: local reads honoured no client filter, which was invisible while local recall was too weak to serve answers and became a correctness defect the moment fusion made it usable.
- **Process**: TDD — 14 unit cases plus 6 end-to-end cases through a mounted entry. Verified against the live store that harvest preserves scope (all 4368 live memories carried `user_id` and `app_id`), so no backfill was needed.
- **Result**: 158 tests, typecheck clean.
- **Notes**: the largest finding was incidental — mem0ai 3.1.5 mixes API versions by operation (`/v3/` for search and add, `/v1/` for single-item get/update/delete/history), so every v3 single-item read had been silently bypassing the local path.


## fix(consistency): echo writes into mirror, invalidate read cache, replay write ops on sync

`54b4992` | 2026-09-05

- **Changes**: confirmed-remote writes now echo into the mirror (applyRemoteWriteEcho: delete→tombstone, update→text, delete-all→all tombstoned) and clear the read cache; locally-applied writes clear it too. Offline update/delete/delete-all now queue a PendingOp log (verbatim body/query) replayed by sync in chronological order merged with pending adds; offline updates keep source=observed (no more duplicate-add replay); replay treats 404 as applied and converges the mirror; confirmed-remote writes supersede queued ops for the same target; /mem0-cache stats shows pending ops; README updated; v0.8.0.
- **Reason**: review found dream-style consolidation silently undone — remote prunes never reached the additive-only mirror, cached reads served pre-write snapshots up to 24h, and sync replayed adds only.
- **Process**: TDD — 15 red tests in test/write-consistency.test.ts first, then implementation; one existing test updated (offline update now keeps source=observed + queues op).
- **Result**: 87/87 tests pass, typecheck clean.
- **Notes**: multi-process store contention and scope-blind local getAll synthesis remain known minor gaps.

## fix(embed): keep vector sidecar in lockstep with the mirror

`5db37cb` | 2026-09-05

- **Changes**: vector auto-sync — add responses are harvested on write success (v3 add returns the created memory, same as sync replays); `ensure()` fires at session start (warm the sidecar) and after every passthrough success; `/mem0-cache embed` self-heals sidecar drift before reporting; `ensure()` dedupes concurrent runs (in-flight guard); v0.7.2.
- **Reason**: user report — embed showed ~124 vectors in fresh sessions and only reached 315 after a manual pull-all; the mirror grows via turn-end auto-capture adds, and nothing triggered re-embedding between searches.
- **Process**: node repro isolated the failure to a test-wiring gap (the passthrough→ensure hook is entry responsibility), which exposed the real gap — direct adds were never harvested; entry-level test now covers the full chain (add → harvest → auto-embed → status 3/3).
- **Result**: typecheck clean, 72/72 tests.
- **Notes**: ensure() in-flight guard prevents duplicate concurrent embeds; /mem0-cache embed is now self-healing by design (drift visible for at most one display cycle). Entry recovered from the installed copy's uncommitted devlog.

## fix(embed): jinaApiKey from mem0-config.json + first-run pull-all fallbacks

`ed64bcf` | 2026-09-05

- **Changes**: pull-all now falls back to Token-scheme auth from `MEM0_API_KEY` and to filters parsed from cached request keys (key format `METHOD <path> <body-json>`, body may contain spaces) when nothing has been captured from live traffic; `createDefaultEmbedder` falls back to a `jinaApiKey` field in `mem0-config.json` when `JINA_API_KEY` is absent/empty (empty-string env values treated as absent — `??` regression caught by test); v0.7.1.
- **Reason**: user hit two real-world first-run failures — pull-all as the first command after a restart had no captured auth ("run any mem0 read first"), and the embedding layer showed "disabled" because the restarted pi process never sourced the zshrc line containing JINA_API_KEY.
- **Result**: 71/71 tests; commits `7bdea13`/`8a3616c`/`ed64bcf`; jinaApiKey written to mem0-config.json (local disk, same exposure as the mem0 key already there).
- **Notes**: pipeline `npm test | tail` masked the failing-test exit code once — committed red, fixed in the next commit; use `npm test && git commit` chaining in future.

## feat(pull-all): full-mirror harvest via paginated getAll

`fa37ca1` | 2026-09-05

- **Changes**: `/mem0-cache pull-all` — paginated getAll (`POST /v3/memories/?page=N&page_size=M`) with the client's captured auth (`Token` scheme) and read filters (app_id/agent_id/run_id stripped → all apps of the user), run through the unwrapped fetch (bypasses gates/cache), every page harvested into the mirror; follows with incremental embed; `ensureEmbeddings` now chunks embed requests at 256 inputs/call (full-corpus rebuilds stay under timeout); interceptor captures latest read filters into a shared filtersRef; v0.7.0.
- **Reason**: user found cloud holds 4,069 memories while the local mirror had 124 — the mirror is a query-driven partial cache (only search-result harvests + local writes), so 97% of the corpus was invisible to gated reads; pull-all makes it a full replica (one-time ~270K tokens embed ≈ 2.7% of the Jina grant).
- **Process**: read mem0ai platform client source for the contract (`?page&page_size` query params, caller-driven pagination, `Authorization: Token` scheme, `{results, count}` response); 66/66 tests incl. pagination stop-on-short-page, Token-scheme header, filter stripping, idempotent re-harvest, 256-chunk split ([256,256,88]), filters capture.
- **Result**: typecheck clean, 66/66 tests (5 new); committed `fa37ca1` (feat + release bump 0.7.0).
- **Notes**: pull-all requires ≥1 mem0 read in the session first (auth/filters capture); re-runs are idempotent (harvest dedupes by id); vector sidecar grows to ~23MB at 4K memories — acceptable, lazy-load is a later optimization; run from a fresh pi session to avoid stale-store clobber from pre-upgrade sessions.

## feat(embed): jina-backed vector recall for gated reads and shadow

`2bdb080` | 2026-09-05

- **Changes**: embedding recall layer — when `JINA_API_KEY` is set, corpus memories are embedded incrementally (sha1-hash-tracked, one batch call, sidecar `~/.pi/agent/mem0-vectors.json`, model-tagged with wipe-on-mismatch) and gated/fallback search reads are ranked by cosine similarity via `api.jina.ai/v1/embeddings` (default `jina-embeddings-v5-text-nano`); provider failure → 1-minute cooldown + keyword-ranking degradation (answers never break); shadow entries gain optional vector side (`localVec`, `overlapVec5/10`, `mrrVec`) so keyword and vector recall are both measured against remote; `/mem0-cache embed` status + `/mem0-cache embed refresh` force re-embed; v0.6.0.
- **Reason**: user decision — start Jina vector recall now (step toward similarity-threshold reuse); free tier 100 RPM/100K TPM is orders of magnitude above need; OpenAI-compatible endpoint keeps the provider seam ready for a local Ollama backend later.
- **Process**: verified `jina-embeddings-v5-text-nano` id + dims (768) from jina.ai/models; 2 test-fix rounds — cosine of [1,0.05] vs [0,1] is ≈0.05, orthogonality needs query [1,0]; incremental-embed mock records texts, ids assertion replaced. Entry-level tests cover the full wiring (seeded gate + jina mock → vector-ordered gated read, embed status, refresh, and keyword-only degradation without key).
- **Result**: typecheck clean, 61/61 tests (13 new across embed unit + entry); committed `2bdb080` (feat + release bump 0.6.0).
- **Notes**: vectors normalize client-side before cosine (safe regardless of server normalization); harness never throws and answers null on cooldown; shadow vec side records rounded 4-dp cosine scores; gated reads trigger ensure() lazily so corpus embeds on first gated search after any mirror change.

## feat(shadow): log local-vs-remote search agreement on every miss

`73eecd6` | 2026-09-05

- **Changes**: shadow logger on the read-search miss path — one JSONL entry per miss to `~/.pi/agent/mem0-shadow.jsonl` (local keyword-overlap ranking vs remote mem0 ranking, overlap@5/@10, MRR of the remote top-1, mode `remote`/`fallback`); comparison runs before harvest so the local side is the true pre-fetch mirror state; `/mem0-cache shadow` aggregate command; `MEM0_CACHE_SHADOW=0` disables, `MEM0_CACHE_SHADOW_PATH` overrides sidecar; rotation to 2000 lines past 4MB; `searchLocal` refactored into `searchLocalScored` (scores exposed, ranking unchanged); v0.5.0.
- **Reason**: step 2 of the quota plan — quantify whether local recall is good enough to serve freshness-gated reads permanently (prerequisite for similarity-threshold reuse); pure logging, zero behavior change by design.
- **Process**: 2 test iterations — CJK tokenization counts 备/份 as separate tokens (score 3→4); rotation moved to append-then-compact so the file stays ≤ keepLines (check-before-append left a keepLines+1 tail). Entry-level smoke test pins the default-export wiring and `/mem0-cache shadow` output.
- **Result**: typecheck clean, 48/48 tests (16 new across shadow unit + interceptor + entry); committed 73eecd6 (feat + release bump 0.5.0).
- **Notes**: gated reads are intentionally not logged (no remote ground truth exists for them); fallback-mode entries carry empty `remote` arrays; malformed JSONL lines are skipped on read.

## fix: normalize "*" entity filters — workaround for mem0ai/mem0#6168

`462f379` | 2026-08-30

- **Changes**: `normalizeWildcardFilters` drops entity filters (`user_id`/`agent_id`/`app_id`/`run_id`) valued `"*"` from search/getAll request bodies before they hit the API; normalization precedes cache-key computation so variants share entries; v0.3.0.
- **Reason**: user reported (via another agent) previously-written memories unreachable, get_all empty. Root cause confirmed upstream: plugin's global scope writes `app_id: null` but reads filter `app_id: "*"`, and mem0's `*` excludes null-valued records (documented; upstream issue #6168).
- **Process**: verified against local store (`localWrites: 0` — extension never intercepted writes; two cached empty 200 responses were genuine API answers), probed cloud directly (429 quota), read plugin `scoping.ts` asymmetry, confirmed wildcard semantics in mem0 docs.
- **Result**: 29/29 tests pass (4 new), typecheck clean.
- **Notes**: project/session scopes are symmetric and unaffected; cross-project invisibility of project-scope memories is intended scoping, not a bug.

## docs: adopt artrix-skills AGENTS.md, add Architecture.md and publish metadata

`ac012ad` | 2026-08-30

- **Changes**: copied AGENTS.md verbatim from artrix-skills (Meta section removed per its self-reference notice); added Architecture.md; added repository/homepage/bugs/publishConfig/prepublishOnly to package.json; README install section now shows npm source.
- **Reason**: repo conventions + preparation for npm publish → pi package gallery (`pi-package` keyword).
- **Result**: typecheck clean, 25/25 tests pass.

## feat(sync): auto-upload local memories when mem0 API recovers

`02aff35` | 2026-08-30

- **Changes**: sync runner replays pending local memories via `/v3/memories/add/` with original scope payload + captured auth; 1h backoff on failure; `/mem0-cache sync`; README updated (auto-sync replaces "no replay"); v0.2.0.
- **Reason**: user requirement — local fallback writes must reach mem0 cloud automatically once quota/API recovers; trigger = any successful mem0 response.
- **Process**: caught and fixed a design bug before commit — sync must use the *unwrapped* fetch, otherwise replayed adds re-enter the interceptor and duplicate into the local store.
- **Result**: 25/25 tests (incl. end-to-end outage→recovery auto-upload); pushed to GitHub.

## feat: mem0 read cache with local offline fallback

`45690d6` | 2026-08-30

- **Changes**: initial extension — fetch-wrapping interceptor with 24h TTL read cache, stale-cache then local-store degradation, local write fallback, `/mem0-cache` command; repo created and published public on GitHub (MIT).
- **Reason**: mem0 quota exhausted (1000/1000 until 2026-09-01); user wanted read caching to prevent recurrence, plus local fallback so memory keeps working during outages.
- **Process**: design settled via grilling — key finding: pi's `tool_call` hook can only block/mutate, so interception happens at the `globalThis.fetch` layer (mem0ai SDK resolves global fetch per call).
- **Result**: 18/18 tests; installed into `~/.pi/agent/settings.json` packages via git source.
- **Notes**: Q3 chose TTL(24h) over write-invalidation; local copies win over observed remote for the same id.

## fix(recall): BM25 + CJK bigram replaces the single-char keyword scorer

`PENDING` | 2026-09-27

- **Changes**: new `src/recall/bm25.ts` — CJK overlapping-bigram tokenizer (latin runs kept whole, lone CJK char falls back to a unigram), BM25 ranking with saturated IDF and length normalization (k1=1.2, b=0.75), and an `unmatched` list reporting query terms absent from the corpus. `harvestMemories` now truncates past `MAX_MEMORY_CHARS` (4000, env `MEM0_MAX_MEMORY_CHARS`), records an `overflow` marker, counts `stats.harvestDropped`, and writes the full original to a quarantine sidecar (`~/.pi/agent/mem0-quarantine.jsonl`, env `MEM0_HARVEST_QUARANTINE_PATH`). New `scripts/eval-recall.mjs` replays any scorer against the shadow log's remote ground truth.
- **Reason**: measured recall was unusable — 424 shadow queries gave mean overlap@5 0.269/5, MRR 0.073, top-1 5.0%, zero-hit 83.3%. Root cause was the scorer, not corpus coverage: single-character CJK matching with `String.includes` and hit-count ranking gives every memory containing 的/项/目 a non-zero score, so ordering was near-random. A single 250K-char terminal paste made up 23% of the corpus and compounded it; that entry was removed from the mirror (quarantined to `/tmp/mem0-dirty-quarantine.jsonl` with a sha256, pre-change store backed up) and the guard now prevents recurrence.
- **Process**: TDD — 5 red tests for the harvest guard, 14 for the tokenizer/scorer. Offline A/B via `scripts/eval-recall.mjs` over the shadow log, in three views: full corpus (426 queries), dirty-excluded, and a fair subset (259 queries whose every ground-truth id still exists in the mirror). The fair subset was necessary because the mirror only grows: 25% of all logged ground-truth ids are now absent, which depresses replay scores for *both* scorers (offline legacy replayed at overlap@5 0.108 vs the 0.273 it actually scored at query time). Only the legacy-vs-bm25 delta from a replay is trustworthy; absolute replay numbers are a floor, not a measurement.
- **Result**: fair subset (259 queries) — overlap@5 0.108 → **0.456** (4.2×), overlap@10 0.220 → **1.116** (5.1×), MRR 0.021 → **0.111** (5.2×), top-1 0.8% → **6.2%** (7.8×), top-1-in-top-10 6.2% → **26.3%**, zero-hit 94.6% → 74.1%. BM25 ranks better on 79 queries, worse on 6, unchanged on 174. Also fixed a stale `embed-entry` assertion that never blanked the real `JINA_API_KEY`, so the "disabled" expectation could not hold on a machine with the key exported. 106/106 tests pass, typecheck clean.
- **Notes**: 74.1% of queries still score zero. Inspecting them shows two distinct causes: very short conversational queries (继续 / 好了没 / 有采样吗) that carry no lexical signal at all, and paraphrases whose words never appear in the target memory. Both are semantic gaps that no lexical scorer can close — this is the measured case for the dense + rerank channels. Also confirmed: the Jina key is dead (HTTP 403 `AUTHZ_INSUFFICIENT_BALANCE`), and the embedding layer has been silently degraded since 2026-09-17 — the `fail()` path records `lastError` but never surfaces it.

## feat(recall): fusion layer, provider abstraction, and per-strategy test mode

`PENDING` | 2026-09-27

- **Changes**: new `src/recall/fusion.ts` — `RecallChannel` interface, `LexicalChannel` (BM25), `DenseChannel` (cosine), `fuseRrf` (Reciprocal Rank Fusion, K=60), and `recall()` which runs every channel, drops the ones that throw, fuses the survivors, then optionally reranks. `rankLocal()` in the entry resolves a `LocalStrategy` (`legacy` | `bm25` | `dense` | `fusion` | `fusion+rerank`) per call; every strategy degrades to an answerable one (`dense` → `bm25`, `fusion+rerank` → `fusion`). Embedding provider is now configuration: `EMBED_PROVIDERS` maps `jina`/`openrouter` to an endpoint + key env + default model, and `createOpenAiCompatEmbedder` handles the wire shape both share. Provider errors now carry the response body (a bare status code is what let the Jina 403 sit unnoticed). **Test mode**: `MEM0_RECALL_STRATEGY` picks the serving strategy, `MEM0_RECALL_TEST=1` switches the shadow logger into comparison mode, where one entry records *every* strategy's ranking against the same remote ground truth (`localBm25`/`overlapBm25_*`/`mrrBm25`, `localFusion`/`mrrFusion`, `unmatched` vocabulary gaps, `channelErrors`). `/mem0-cache shadow` now prints a strategy comparison table sorted by MRR plus a channel-error tally. `scripts/eval-recall.mjs` gained a four-way head-to-head on the same denominator.
- **Reason**: the measured recall gap had two distinct causes — lexical scoring (fixed in the previous commit) and the complete absence of a fusion stage, with dense and keyword replacing each other. The old code was a ternary (`vecRanked ? dense : keyword`), which cannot express "both, merged, each degradable".
- **Process**: TDD — 20 tests for the fusion layer before wiring. Wiring exposed three real regressions, all handled deliberately, with assertions tightened to pin the new contracts: (1) provider errors changed shape (improvement, tests updated to assert the body is included); (2) the default strategy became `fusion`, which changed gated-read ordering in the embed tests — those were pinned to `dense` since they test the dense channel, not the fusion policy; (3) `/mem0-cache shadow` output format changed, and the new format immediately surfaced `dense: embedding layer unavailable` on live data.
- **Result**: fair subset, same-subset head-to-head (n=163, the queries carrying a recorded dense ranking): legacy overlap@5 0.313 / MRR 0.064 / top-1 3.7% → dense 0.656 / 0.147 / 9.2% → **fusion 0.656 / 0.175 / 11.0%**. Fusion matches dense on recall and beats it on ordering, which is exactly what RRF should do. Against legacy over the fair subset fusion is overlap@5 0.097 → 0.656 (6.8×), MRR 0.018 → 0.175 (9.7×), top-1 0.4% → 11.0% (27×), zero-hit 95.0% → 53.4%. 126/126 tests pass, typecheck clean.
- **Notes**: this is a before/after on **legacy + dense**, not the new provider — the recorded dense side is Jina v5 nano, which is now dead (403). So the fusion numbers are a **floor**: swapping to a stronger embedder plus adding a reranker should raise them. Rerank remains unmeasured (no reranker configured yet). The 53.4% zero-hit remainder is dominated by short conversational queries (继续 / 好了没 / 检查同步进度) with no lexical overlap at all — visible in the `unmatched` field.

## fix(scope): isolate local reads by request scope, and classify v3 single-item paths

`PENDING` | 2026-09-27

- **Changes**: new `src/recall/scope.ts` — `SCOPE_KEYS` (user_id / agent_id / app_id / run_id), `extractScope(bodyText, search)`, `matchesScope`, `filterByScope`. `rankLocal()` gained a `scope` option and now filters the corpus **before** ranking, so out-of-scope memories never enter a channel candidate pool (the reranker and the shadow log would otherwise see data the request is not entitled to). `EmbedHarnessChannel` takes an allow-list and intersects its results with it, because the harness ranks the whole mirror and predates scope filtering. `serveLocalRead` applies scope to `read-search`, `read-getall`, and `read-get`. `recordShadow` logs under the request's own scope. `classify()` now matches `/v[13]/memories/…` for single-item operations and captures `url.search` on every classified request.
- **Reason**: the mirror holds every project on the account, but the local read path ignored the client's `filters` and answered `getAll` with `Object.values(store.memories)` — every memory of every app. That stayed invisible while local recall was too weak to serve answers; once the fusion work made it usable, it became a correctness defect: a project-scoped read would return another project's memories.
- **Process**: TDD — 14 unit tests on the scope helpers, then 6 end-to-end tests through the extension entry. Three findings worth recording. (1) `"*"` needed a decision: mem0's wildcard matches only non-null values, which is the asymmetry behind mem0ai/mem0#6168, so treating it as "unconstrained" keeps the local path consistent with the already-patched remote path. (2) A memory with **no** `app_id` must fail an app-scoped request (missing field = unknown provenance), which is what keeps global-scope writes visible to user-only reads while hiding them from app reads — the two tests pin both directions. (3) The largest finding was outside the task: `classify()` only matched `/v1/memories/<id>`, so **every v3 single-item get/update/delete was silently sent to the network path**, never served locally. Reading the SDK (mem0ai 3.1.5) showed it mixes versions by operation — `/v3/` for search + add, `/v1/` for single-item calls. Single-item GETs also scope through the **query string** (`/v1/memories/${id}/?${params}`), because a GET cannot carry a body under the fetch standard, so `extractScope` takes both carriers.
- **Result**: 158/158 tests pass, typecheck clean. Verified against the live store that harvest already preserves scope (`...m` spread): all 4368 live memories carry `user_id` and `app_id`, so the filter has real data to work with and no backfill is needed.
- **Notes**: `filterByScope` returns the input array when scope is undefined, so an unscoped read costs nothing. The "not available locally" branch now returns 404 for an out-of-scope id — deliberate: existence of another project's memory should not be disclosed. `legacy` strategy is also scope-filtered, so the old scorer inherits the fix.

## feat(eval): candidate-pool and sampling stage for an independent gold set

`PENDING` | 2026-09-27

- **Changes**: new `scripts/build-gold.mjs`. Stage 1 runs with no credentials: it reads the store and the shadow log, filters noise, dedupes queries, builds a candidate pool per query, stratifies by query shape, and writes `gold-candidates.json` with the judging protocol embedded and an empty `grades` map per query. `--report` prints pool statistics without writing.
- **Reason**: the shadow log scores local recall against **mem0's own top-10**, which measures imitation. A local retriever that answers *better* than mem0 scores *worse* under that metric, and mem0's misses are inherited as truth. Every ship/no-ship decision about the local path needs relevance judged on the query and the memory text alone.
- **Process**: the pool is the **union** of every ranking recorded in the shadow log (remote, legacy, dense, BM25, fusion), intersected with ids the mirror still holds. The union is what makes the gold set fair: a pool built from one retriever's output can never contain another retriever's correct answer, so a scorer would be penalised for being right where the pool builder was wrong. Judged ids absent from the corpus are dropped — they can never be retrieved, so counting them lowers every scorer equally and adds noise without signal. Sampling is stratified by query shape (terse-cjk / mixed / cjk-only / latin) because the channels fail on different shapes: BM25 has nothing to match on a bare 「继续」, dense bridges a paraphrase, and neither helps when the query names nothing the memory mentions. Deterministic `mulberry32` seeding makes a gold set reproducible for a later ablation. I added a **pool-domination** statistic (what share of each pool came from each retriever's own list) specifically to detect the bias this design is guarding against — measured at 40-47% per retriever, so no channel owns the pool.
- **Result**: 448 shadow entries → 314 eligible queries (noise and duplicate-query rows removed) → 62 sampled across four shapes. Median pool 19 candidates (min 2, max 30), 1072 judgments outstanding. Pool domination: dense 46.9%, remote 44.7%, local 40.6% — comparable, so the pool is retriever-neutral in practice and not just by construction.
- **Notes**: stage 2 (LLM judging) needs a key and is not written yet. `--per-bucket` caps each shape's contribution; the default of 12 held the sample to 46, so 30 is the working value for a 62-query set. `gold-candidates.json` is deliberately not committed — it is a build artifact keyed to the corpus snapshot.
