# devlog

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
