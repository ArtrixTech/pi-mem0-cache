# pi-mem0-cache

A [pi](https://github.com/badlogic/pi-coding-agent) extension that adds a **read cache and offline fallback** for [mem0](https://mem0.ai) — built for the moment your mem0 quota runs out mid-month and `mem0_memory` starts returning `Usage quota exceeded` on every call.

## What it does

The extension wraps `globalThis.fetch` inside the pi process and transparently intercepts traffic to `api.mem0.ai`:

**Reads** (`search`, `get_all`, `get`, `history`)

- Successful responses are cached to disk with a **24h TTL**. Identical requests within the TTL never touch the network — this alone cuts most repeat-query quota burn, since agents re-run similar memory searches constantly.
- If the API fails (quota exhausted, 4xx/5xx, network down):
  1. A **stale cache entry** is served if one exists, otherwise
  2. A **local memory store** answers the query (keyword-overlap search over every memory ever observed plus all local writes).

**Writes** (`add`, `update`, `delete`, `delete_all`)

- Tried against the real API first. On success, behavior is unchanged.
- On failure, the mutation is applied to the **local store** (with the original request payload, scope params included) and a synthetic success response is returned, so no memory is lost while mem0 is unavailable.

**Auto-sync**

- The moment *any* mem0 API call succeeds again (quota refilled, network back), all pending local memories are uploaded in the background via `/v3/memories/add/` — replayed with their **original scope payload** (`user_id`, `app_id`, …), so they land in the right scope.
- Uploaded memories are marked `observed`; local copies that were deleted before ever syncing are purged.
- Auth headers are captured transparently from the mem0 client's own requests — no configuration needed.
- On failure mid-sync, the runner backs off for 1h before retrying. Force an immediate attempt with `/mem0-cache sync`.

All memories seen in any API response are harvested into the local corpus, so the fallback search gets richer the longer you use it.

**Upstream bug workaround** ([mem0ai/mem0#6168](https://github.com/mem0ai/mem0/issues/6168))

The pi mem0 plugin's `global` scope is asymmetric: writes store `app_id: null`, reads filter `app_id: "*"`, and mem0's `*` wildcard matches only non-null values — so global memories are permanently unreachable. This extension normalizes read requests before they hit the API: entity filters (`user_id`/`agent_id`/`app_id`/`run_id`) whose value is `"*"` are dropped, restoring the intended "unconstrained" semantics. Normalization happens before cache-key computation, so wildcard and non-wildcard variants of the same read share one cache entry.

## Install

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-mem0-cache"
  ]
}
```

or from the git source directly: `"git:https://github.com/ArtrixTech/pi-mem0-cache"`. Then restart pi — no configuration needed. It works alongside `@mem0/pi-agent-plugin` (or any mem0 client using global `fetch`).

## Usage

```
/mem0-cache stats       # cache size, pending local memories, counters, last sync result
/mem0-cache sync        # force-upload pending local memories to mem0 now
/mem0-cache clear       # wipe the read cache (keep local memories)
/mem0-cache clear-all   # wipe everything
/mem0-cache path        # show store location
```

## Storage

Everything lives in one JSON file: `~/.pi/agent/mem0-cache.json` (override with `MEM0_CACHE_PATH`). Human-readable; safe to inspect or hand-edit while pi is stopped.

TTL defaults to 24h; override with `MEM0_CACHE_TTL_MS`.

## Design notes

- **Interception layer**: pi's `tool_call` hook can only block or mutate tool arguments — it cannot inject a synthetic successful result. The mem0 SDK resolves global `fetch` at call time, so wrapping `fetch` is the cleanest transparent seam: no patching `node_modules`, no local proxy process, survives plugin upgrades.
- **TTL over write-invalidation**: mem0 search is semantic; results drift as memories are added. A 24h TTL is a simple, predictable freshness bound.
- **Auto-sync on first success**: the trigger for uploading pending local memories is any successful mem0 response — the earliest possible proof that quota/connectivity is back. Replays use the original add payload so scoping is preserved. Sync calls go through the *unwrapped* fetch, never re-entering the interceptor.

## Limitations

- Local fallback search is keyword overlap, not semantic. It's a degradation ladder, not a mem0 replacement.
- A failed non-read (e.g. `history`) with no cache and no local match returns the original API error.
- Single-process assumption: concurrent pi instances share the JSON store via last-writer-wins debounced writes.
- Sync uploads are plain `add`s — if a memory was *also* added to mem0 by another client during the outage, a duplicate may result.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
