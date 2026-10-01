# pi-mem0-cache

A [pi](https://github.com/badlogic/pi-coding-agent) extension that adds a **read cache and offline fallback** for [mem0](https://mem0.ai) — built for the moment your mem0 quota runs out mid-month and `mem0_memory` starts returning `Usage quota exceeded` on every call.

## What it does

The extension wraps `globalThis.fetch` inside the pi process and transparently intercepts traffic to `api.mem0.ai`:

**Reads** (`search`, `get_all`, `get`, `history`)

- Successful responses are cached to disk with a **24h TTL**. Identical requests within the TTL never touch the network — this alone cuts most repeat-query quota burn, since agents re-run similar memory searches constantly.
- A **freshness gate** caps remote reads at **one per hour** (`MEM0_CACHE_REMOTE_READ_INTERVAL_MS`, default 1h). Within the window, searches and listings are answered from the cache/local store. `/mem0-cache refresh` clears the gate explicitly.
- A **429 breaker**: when mem0 answers `429 Usage quota exceeded`, the `retry-after` hint arms a breaker; while armed, reads skip the network entirely. The error body (which names the exhausted quota, e.g. `SEARCH`) is included in the fallback toast.
- If the API fails (quota exhausted, 4xx/5xx, network down):
  1. A **stale cache entry** is served if one exists, otherwise
  2. A **local memory store** answers the query (keyword-overlap search over every memory ever observed plus all local writes).

**Writes** (`add`, `update`, `delete`, `delete_all`)

- Tried against the real API first. On success the write **echoes into the mirror** (adds harvest from the response; update/delete/delete-all propagate directly) and the read cache is invalidated, so gated/fallback reads never serve pre-write state.
- On failure, the mutation is applied to the **local store** (with the original request payload, scope params included) and a synthetic success response is returned, so no memory is lost while mem0 is unavailable.

**Auto-sync**

- The moment *any* mem0 API call succeeds again (quota refilled, network back), pending writes replay in the background **in the order they happened**: offline `add`s upload via `/v3/memories/add/` with their **original scope payload** (`user_id`, `app_id`, …); offline `update`/`delete`/`delete_all` intents replay verbatim from an op log (PUT/DELETE to the original target, delete-all keeps its original query string).
- A confirmed-remote write supersedes queued ops for the same target; replay 404s count as applied and the mirror converges to server state (server-gone entries are dropped).
- Uploaded memories are marked `observed`; local copies that were deleted before ever syncing are purged, as are tombstones whose delete op has replayed.
- Each sync's result (`uploaded X, ops applied Y, failed Z, pending W`) renders as a persistent **footer status line**. Anomalies and persistence failures from the memory store, vectors, quarantine and shadow log surface as **notification toasts** on the next input, turn-end or session event. Duplicate diagnostics coalesce in bounded queues. Headless runs deliver diagnostics through stderr.
- Session shutdown flushes pending store and vector writes, closes background embedding continuation, releases process listeners and restores the extension's owned fetch wrapper. Late background diagnostics are retained in `~/.pi/agent/logs/mem0-cache-diagnostics.jsonl` (`MEM0_CACHE_DIAGNOSTICS_PATH` selects another path). Restart existing pi processes after upgrading the earlier UI-routing build.
- Auth headers are captured transparently from the mem0 client's own requests — no configuration needed.
- On failure mid-sync, the runner backs off for 1h before retrying. Force an immediate attempt with `/mem0-cache sync`.

All memories seen in any API response are harvested into the local corpus, so the fallback search gets richer the longer you use it.

**Retrieval pipeline (dense + rerank)**

The local answer is produced by a staged pipeline: **retrieve broadly, then reorder carefully**.

| Stage | What it does | Provider needed |
|---|---|---|
| **Dense** | Embeds the query and ranks the mirror by cosine similarity — finds paraphrases, cross-language matches, and topics that share no words with the query | yes (embeddings) |
| **Rerank** | A cross-encoder reads the query and each top candidate *together* and reorders them | yes (rerank) |
| **BM25** | CJK-bigram + BM25 keyword ranking over the mirror | no — pure local arithmetic |

Embeddings run through an OpenAI-compatible endpoint. Default provider is OpenRouter with `qwen/qwen3-embedding-8b`; Jina is the secondary. Reranking defaults to `voyageai/rerank-2.5-lite` via OpenRouter (`MEM0_RERANK_MODEL`). Vectors are hash-tracked in a sidecar at `~/.pi/agent/mem0-vectors.json` and refreshed incrementally.

**Strategy resolution.** `MEM0_RECALL_STRATEGY` selects the pipeline, defaulting to `auto`, which resolves against what is actually available:

```
dense+rerank   ← embeddings and reranker both working   (nDCG@10 0.821)
     ↓         embeddings working, no reranker          (nDCG@10 0.677)
   dense
     ↓         no provider at all — the availability floor (nDCG@10 0.346)
   bm25
```

Every step down is recorded in the shadow log. An explicit strategy (`dense`, `fusion`, `dense+rerank`, `bm25`, `legacy`) pins the pipeline and disables the ladder, which is what makes A/B runs meaningful. `/mem0-cache provider` prints the resolved plan, what was skipped and why, and each provider's credential source.

**Why BM25 is not in the serving path.** It was measured, and it lost: scoring 57 judged queries over a mean 2570 in-scope memories, `fusion` reached nDCG@10 0.633 against `dense`'s 0.677, and `fusion+rerank` tied `dense+rerank` at 0.821 while running one extra channel. With a reranker already reordering the pool, lexical candidates consume slots that have to be reordered past. BM25 keeps the role it is actually good at — the local floor that answers when every provider is gone, and precise matching on identifiers, file names, and error strings. `MEM0_FUSION_BM25_WEIGHT` (default 0.4) controls its weight when a fusion strategy is explicitly requested.

Providers are optional by construction. A dead embedding key degrades to BM25; a dead reranker key degrades to dense; a failed rerank call mid-session degrades to the fused order for that read. Recall never depends on a single provider answering, and no degradation is silent.

**Shadow logger**

Every `search` that misses the cache also records a comparison entry to `~/.pi/agent/mem0-shadow.jsonl` (override with `MEM0_CACHE_SHADOW_PATH`; disable with `MEM0_CACHE_SHADOW=0`): the ranking the freshness gate would have served locally, next to the remote mem0 ranking, with `overlap@5`/`overlap@10`, the reciprocal rank of the remote top-1 in the local list (MRR), and a `mode` (`remote` = answered by the API, `fallback` = API failed and the mirror answered). On the success path the comparison runs *before* the response is harvested, so the local ranking reflects the true pre-fetch corpus state.

In test mode (`MEM0_RECALL_TEST=1`, or any explicit `MEM0_RECALL_STRATEGY`) each entry records **every** strategy's ranking as ids — `legacy`, `bm25`, `dense`, `fusion`, `dense+rerank` — plus vocabulary-gap and per-channel failure fields, all scored against the same remote ground truth. `/mem0-cache shadow` prints the comparison table sorted by MRR plus a channel-error tally. Test mode changes what is measured, never what the agent receives.

**Offline evaluation**

The shadow log measures *agreement with mem0*, which cannot tell "local found the better answer" from "local failed to imitate mem0". `scripts/` carries a second, independent harness:

```bash
node scripts/build-gold.mjs --sample 80 --per-bucket 30   # sample queries from the shadow log
node scripts/retrieve-full.mjs --k 10                      # run every strategy over the FULL corpus
node scripts/judge-gold.mjs --concurrency 6                # grade each (query, memory) pair via LLM
node scripts/score-full.mjs --by-shape                     # nDCG@10 / R@10 / MRR per strategy
```

`retrieve-full.mjs` is deliberately not a re-ranker of a pre-built pool: each strategy runs against every in-scope memory (mean 2570) and returns its own top-K, and the judged pool is the *union* of those top-Ks. A pool built from one retriever's output can only ever contain that retriever's answers, which would penalise the others for finding things it missed. `judge-gold.mjs` reuses grades across gold files, so widening the candidate pool costs only the new candidates.

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
/mem0-cache provider    # credentials, resolved serving strategy, capabilities, skipped plans
/mem0-cache shadow      # local-vs-remote search agreement stats from the shadow log
/mem0-cache embed       # embedding layer status (vectors/corpus, model, last error)
/mem0-cache embed refresh # force a full re-embed of the corpus
/mem0-cache pull-all    # fetch every cloud memory into the local mirror + incremental embed
```

## Storage

Everything lives in one JSON file: `~/.pi/agent/mem0-cache.json` (override with `MEM0_CACHE_PATH`). Human-readable; safe to inspect or hand-edit while pi is stopped.

TTL defaults to 24h; override with `MEM0_CACHE_TTL_MS`. The freshness gate defaults to 1h; override with `MEM0_CACHE_REMOTE_READ_INTERVAL_MS`. The shadow log is a separate JSONL sidecar at `~/.pi/agent/mem0-shadow.jsonl`; it rotates to the most recent 2000 lines once it exceeds 4MB. Embedding vectors live in `~/.pi/agent/mem0-vectors.json` (override with `MEM0_VECTORS_PATH`).

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `MEM0_RECALL_STRATEGY` | `auto` | Pin a pipeline: `auto`, `dense+rerank`, `dense`, `fusion+rerank`, `fusion`, `bm25`, `legacy` |
| `MEM0_RECALL_TEST` | off | `1` enables per-strategy shadow comparison without changing answers |
| `MEM0_EMBED_PROVIDER` | `openrouter` then `jina` | Which embeddings provider to use |
| `MEM0_EMBED_MODEL` | per provider | Override the embedding model |
| `MEM0_RERANK_MODEL` | `voyageai/rerank-2.5-lite` | Reranker model |
| `MEM0_RERANK` | on | `0` disables reranking entirely |
| `MEM0_FUSION_BM25_WEIGHT` | `0.4` | Lexical channel weight when a fusion strategy is requested |
| `MEM0_EMBED` | on | `0` forces the embedding layer off |
| `MEM0_MAX_MEMORY_CHARS` | `4000` | Harvest cap; oversized memories are truncated and quarantined |

### Credentials

Keys are read from the environment first, then from the macOS Keychain. Nothing writes a key to disk in plaintext:

```bash
./scripts/setup-key.sh openrouter   # hidden prompt, stored in Keychain
./scripts/setup-key.sh --list       # show which services hold a key
./scripts/setup-key.sh --verify openrouter
```

## Design notes

- **Interception layer**: pi's `tool_call` hook can only block or mutate tool arguments — it cannot inject a synthetic successful result. The mem0 SDK resolves global `fetch` at call time, so wrapping `fetch` is the cleanest transparent seam: no patching `node_modules`, no local proxy process, survives plugin upgrades.
- **Write-through consistency**: any write — remote-confirmed or locally applied — invalidates the read cache and echoes into the mirror, so the 24h TTL never serves pre-write state.
- **Global freshness gate over per-query caching alone**: measured hit rate of exact-match query caching on real agent traffic was ~9% (queries rarely repeat verbatim); the 1h gate is what actually bounds retrieval-quota burn.
- **Auto-sync on first success**: the trigger for uploading pending local memories is any successful mem0 response — the earliest possible proof that quota/connectivity is back. Replays use the original add payload so scoping is preserved. Sync calls go through the *unwrapped* fetch, never re-entering the interceptor.

## Limitations

- A provider is required for the best pipeline. Without an embeddings key the local answer is BM25 keyword ranking, which is a real fallback and measurably weaker (nDCG@10 0.346 against 0.821).
- The freshness gate and 429 breaker cover only locally-synthesizable reads (`search`, `get_all`, `get`); `history` and unknown reads stay on the network path.
- A failed non-read (e.g. `history`) with no cache and no local match returns the original API error.
- Single-process assumption: concurrent pi instances share the JSON store via last-writer-wins debounced writes.
- Sync uploads are plain `add`s — if a memory was *also* added to mem0 by another client during the outage, a duplicate may result.
- The gold set is 57 queries frozen to one corpus snapshot. It is large enough to rank strategies and too small to resolve differences under ~0.03 nDCG.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
