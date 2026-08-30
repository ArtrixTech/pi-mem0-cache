# devlog

## fix: normalize "*" entity filters — workaround for mem0ai/mem0#6168

`<pending>` | 2026-08-30

- **Changes**: `normalizeWildcardFilters` drops entity filters (`user_id`/`agent_id`/`app_id`/`run_id`) valued `"*"` from search/getAll request bodies before they hit the API; normalization precedes cache-key computation so variants share entries; v0.3.0.
- **Reason**: user reported (via another agent) previously-written memories unreachable, get_all empty. Root cause confirmed upstream: plugin's global scope writes `app_id: null` but reads filter `app_id: "*"`, and mem0's `*` excludes null-valued records (documented; upstream issue #6168).
- **Process**: verified against local store (`localWrites: 0` — extension never intercepted writes; two cached empty 200 responses were genuine API answers), probed cloud directly (429 quota), read plugin `scoping.ts` asymmetry, confirmed wildcard semantics in mem0 docs.
- **Result**: 29/29 tests pass (4 new), typecheck clean.
- **Notes**: project/session scopes are symmetric and unaffected; cross-project invisibility of project-scope memories is intended scoping, not a bug.

## docs: adopt artrix-skills AGENTS.md, add Architecture.md and publish metadata

`<pending>` | 2026-08-30

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
