# Architecture

## Components

### Types and the store

- **`src/types.ts`** — the root of the dependency graph; imports only node builtins. Owns the on-disk `Store` shape (memories, ops, cache, sync and net state, stats), the intercepted `ClassifiedRequest` shape, `LocalStrategy`, the tunable limits (`MAX_MEMORY_CHARS`, batch sizes, default paths), and `ENTITY_FILTER_KEYS`. Anything two modules both need lives here at the single shared site.
- **`src/store.ts`** — persistence. `loadStore` applies the memory size bound on the way in; `makeSaver` debounces writes, merges with the disk copy first so concurrent sessions do not overwrite each other, and flushes on process exit.

### Request handling

- **`src/request.ts`** — `classify` maps a fetch call to a mem0 operation (which endpoint, which scope, read or write). `cacheKey` builds the read-cache key.
- **`src/interceptor.ts`** — wraps `globalThis.fetch`: serves cached reads within TTL, gates remote reads, arms the 429 breaker, and degrades to stale-cache or local answers when the API fails.
- **`src/credentials.ts`** — resolves a provider key from the environment first, then the macOS Keychain. Shared by the embedder and the reranker so both report their source identically.

### The local mirror

- **`src/memory.ts`** — maintains the corpus: harvests memories out of response bodies, enforces the size bound (`clampMemory`, with the original appended to the quarantine sidecar), and provides the lexical ranking used as the availability floor.
- **`src/writes.ts`** — applies a write locally when the API is unavailable, echoes a confirmed remote write into the mirror, and reconciles queued ops. Reads write scope from both the body and the query string.
- **`src/sync.ts`** — replays queued work once the API answers: local adds from their captured payload, and update/delete/delete-all intents from the op log, in chronological order. Classifies each failure as permanent or transient, and retires an item after repeated permanent failures. Also owns pull-all.

### Retrieval

- **`src/rank.ts`** — resolves a recall plan against the capabilities actually present and ranks the scope-filtered corpus through it, reporting which pipeline served the read and what degraded.
- **`src/embed.ts`** — maintains the vector sidecar in bounded, resumable batches, ranks by cosine over unit-length vectors, and separates a transient query-embedding failure from a persistent corpus-level fault.
- **`src/recall/`** — provider-independent retrieval primitives: `plan.ts` (plan registry, preference ladders, resolution), `fusion.ts` (channels and weighted RRF), `bm25.ts` (tokenizer and scorer), `scope.ts` (scope extraction and corpus filtering), `rerank.ts` (cross-encoder reranking).
- **`src/shadow.ts`** — records every strategy's local ranking next to mem0's remote ranking on each search miss. Purely observational.

### Entry

- **`src/diagnostics.ts`** — routes persistence failures through the active extension's process-shared diagnostic reporter and supplies stderr delivery for standalone library callers.
- **`src/index.ts`** — the pi extension entry: wires the interceptor, sync runner, shadow logger, and `/mem0-cache` command, detects provider capabilities, and re-exports the public surface the tests import.

### Evaluation (`scripts/`)

- **`build-gold.mjs`** — samples queries from the shadow log and assembles a judging pool from the union of every recorded ranking.
- **`retrieve-full.mjs`** — runs every strategy against the real in-scope corpus, each returning its own top-K, so the pool bounds what gets judged, leaving each strategy free to retrieve from the whole corpus.
- **`judge-gold.mjs`** — grades each (query, memory) pair, with a grade pool shared across gold files.
- **`score-full.mjs`** — reports nDCG@10, R@10, P@5, MRR, hit@10 and zero@10 per strategy.

## Key Relationships

Dependencies point one way: `types` at the root; `store`, `memory` and `request` above it; `rank`, `writes`, `shadow` and `embed` above those; `interceptor` and `sync` above those; `index` at the top. Verified with `madge --circular`. Two placements were forced by that direction — `LocalStrategy` and `ENTITY_FILTER_KEYS` live in `types.ts` because `Store` and the write path reference them, and `credentials.ts` came out of the entry because both providers need key resolution.

`src/recall/` depends on nothing above it, which keeps ranking logic testable without a store.

The entry captures the *unwrapped* fetch for the sync runner and pull-all, so replayed writes and full-mirror reads never re-enter the interceptor.

Provider failure resolves around the request: `rankLocal` picks a plan the available capabilities can serve, and the embedding layer's failure is reported as a degradation.
