# devlog

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
