# pi-mem0-cache

A [pi](https://github.com/badlogic/pi-coding-agent) extension that adds a **read cache and offline fallback** for [mem0](https://mem0.ai) — built for the moment your mem0 quota runs out mid-month and `mem0_memory` starts returning `Usage quota exceeded` on every call.

## What it does

The extension wraps `globalThis.fetch` inside the pi process and transparently intercepts traffic to `api.mem0.ai`:

**Reads** (`search`, `get_all`, `get`, `history`)

- Successful responses are cached to disk with a **24h TTL**. Identical requests within the TTL never touch the network — this alone cuts most repeat-query quota burn, since agents re-run similar memory searches constantly.
- A **freshness gate** caps remote reads at **one per hour** (`MEM0_CACHE_REMOTE_READ_INTERVAL_MS`, default 1h). Within the window, searches and listings are answered from the cache/local store. `/mem0-cache refresh` clears the gate explicitly.
- A **429 breaker**: when mem0 answers `429 Usage quota exceeded`, the `retry-after` hint arms a breaker; while armed, reads skip the network entirely. The error body (which names the exhausted quota, e.g. `SEARCH`) is included in the fallback log line.
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

**Embedding recall (Jina)**

When `JINA_API_KEY` is set, corpus memories are embedded incrementally (hash-tracked, one batch call; sidecar at `~/.pi/agent/mem0-vectors.json`) and gated/fallback `search` reads are ranked by **cosine similarity** against the query embedding — semantic recall over the mirror, replacing the keyword-overlap ranking whenever the vectors cover the corpus. Provider failures (HTTP errors, timeouts) trigger a 1-minute cooldown and instant degradation to the keyword ranking; answers never break because of the embedding layer. Model default: `jina-embeddings-v5-text-nano` (768 dims, OpenAI-compatible `api.jina.ai/v1/embeddings`); override with `MEM0_EMBED_MODEL`. `MEM0_EMBED=0` forces the layer off; vectors live in a separate sidecar (`MEM0_VECTORS_PATH`). `/mem0-cache embed` shows corpus coverage; `/mem0-cache embed refresh` forces a full re-embed.

Shadow entries carry an optional vector side (`localVec`, `overlapVec5/10`, `mrrVec`) next to the keyword ranking, so both recall strategies are measured against the remote answer in `/mem0-cache shadow`.

**Full mirror (`pull-all`)**

The mirror is a query-driven partial cache by default — it only ever sees memories that flow back in API responses. `/mem0-cache pull-all` closes the gap: it fetches **every** memory for the user via paginated getAll (`POST /v3/memories/?page=N&page_size=M`, auth headers and entity filters captured transparently from the client's own reads), bypassing the interceptor's gates and cache with the unwrapped fetch, and harvests all pages into the local corpus. App-scoping filters (`app_id`/`agent_id`/`run_id`) are stripped, so the mirror covers every app of the user. Afterwards the new entries are embedded incrementally (256-input chunks, ~9K tokens per 1K memories). Requires at least one mem0 read in the session first (to capture auth); re-running is idempotent.

**Shadow logger**

Every `search` that misses the cache also records a comparison entry to `~/.pi/agent/mem0-shadow.jsonl` (override with `MEM0_CACHE_SHADOW_PATH`; disable with `MEM0_CACHE_SHADOW=0`): the keyword-overlap ranking the freshness gate would have served locally, next to the remote mem0 ranking, with `overlap@5`/`overlap@10`, the reciprocal rank of the remote top-1 in the local list (MRR), and a `mode` (`remote` = answered by the API, `fallback` = API failed and the mirror answered). On the success path the comparison runs *before* the response is harvested into the mirror, so the local ranking reflects the true pre-fetch corpus state. The logger changes nothing about answers — it builds the dataset for deciding whether local search is good enough to serve gated reads permanently. `/mem0-cache shadow` prints the aggregate agreement stats.

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
/mem0-cache refresh     # clear the freshness gate + 429 breaker; next read hits the API
/mem0-cache clear       # wipe the read cache (keep local memories)
/mem0-cache clear-all   # wipe everything
/mem0-cache path        # show store location
/mem0-cache shadow      # local-vs-remote search agreement stats from the shadow log
/mem0-cache embed       # embedding layer status (vectors/corpus, model, last error)
/mem0-cache embed refresh # force a full re-embed of the corpus
/mem0-cache pull-all    # fetch every cloud memory into the local mirror + incremental embed
```

## Storage

Everything lives in one JSON file: `~/.pi/agent/mem0-cache.json` (override with `MEM0_CACHE_PATH`). Human-readable; safe to inspect or hand-edit while pi is stopped.

TTL defaults to 24h; override with `MEM0_CACHE_TTL_MS`. The freshness gate defaults to 1h; override with `MEM0_CACHE_REMOTE_READ_INTERVAL_MS`. The shadow log is a separate JSONL sidecar at `~/.pi/agent/mem0-shadow.jsonl`; it rotates to the most recent 2000 lines once it exceeds 4MB. Embedding vectors live in `~/.pi/agent/mem0-vectors.json` (override with `MEM0_VECTORS_PATH`); the layer activates when `JINA_API_KEY` is present and can be forced off with `MEM0_EMBED=0`.

## Design notes

- **Interception layer**: pi's `tool_call` hook can only block or mutate tool arguments — it cannot inject a synthetic successful result. The mem0 SDK resolves global `fetch` at call time, so wrapping `fetch` is the cleanest transparent seam: no patching `node_modules`, no local proxy process, survives plugin upgrades.
- **TTL over write-invalidation**: mem0 search is semantic; results drift as memories are added. A 24h TTL is a simple, predictable freshness bound.
- **Global freshness gate over per-query caching alone**: measured hit rate of exact-match query caching on real agent traffic was ~9% (queries rarely repeat verbatim); the 1h gate is what actually bounds retrieval-quota burn.
- **Auto-sync on first success**: the trigger for uploading pending local memories is any successful mem0 response — the earliest possible proof that quota/connectivity is back. Replays use the original add payload so scoping is preserved. Sync calls go through the *unwrapped* fetch, never re-entering the interceptor.

## Limitations

- Local fallback search is keyword overlap, not semantic. It's a degradation ladder, not a mem0 replacement.
- The freshness gate and 429 breaker cover only locally-synthesizable reads (`search`, `get_all`, `get`); `history` and unknown reads stay on the network path.
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
