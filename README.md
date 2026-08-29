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
- On failure, the mutation is applied to the **local store** and a synthetic success response is returned, so no memory is lost while mem0 is unavailable.
- Local writes are **not replayed** to mem0 later (deliberate: they stay searchable through the local fallback forever). The local store *wins* over observed remote copies for the same memory id.

All memories seen in any API response are harvested into the local corpus, so the fallback search gets richer the longer you use it.

## Install

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:https://github.com/ArtrixTech/pi-mem0-cache"
  ]
}
```

Restart pi. No configuration needed — it works alongside `@mem0/pi-agent-plugin` (or any mem0 client using global `fetch`).

## Usage

```
/mem0-cache stats       # cache size, local memories, hit/miss/fallback counters
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
- **No write replay**: when the API is down, failed writes are stored locally and exposed through the fallback search. Replaying them into mem0 later is intentionally out of scope.

## Limitations

- Local fallback search is keyword overlap, not semantic. It's a degradation ladder, not a mem0 replacement.
- A failed non-read (e.g. `history`) with no cache and no local match returns the original API error.
- Single-process assumption: concurrent pi instances share the JSON store via last-writer-wins debounced writes.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
