# Architecture

## Components

### Recall pipeline (`src/recall/`)

- **Plan registry and resolver** (`src/recall/plan.ts` → `PLANS`, `PREFERENCE`, `resolveStrategy`): maps a requested strategy name to a concrete pipeline (which channels run, whether the reranker runs) and resolves it against the capabilities actually present. Every preference ladder terminates in a plan that needs no provider, so resolution is total — it always returns something servable. Each plan carries the nDCG@10 it measured, so the shipped default traces to a number.
- **Fusion and channels** (`src/recall/fusion.ts` → `RecallChannel`, `LexicalChannel`, `DenseChannel`, `fuseRrf`, `recall`): runs every configured channel, drops the ones that throw, fuses the survivors with weighted Reciprocal Rank Fusion, and optionally hands the pool to a reranker. A channel failure removes that channel's contribution and leaves the rest of the answer intact.
- **Cross-encoder reranking** (`src/recall/rerank.ts` → `createReranker`, `createDefaultReranker`): reorders a fused pool by reading the query and each candidate together. Provider-agnostic over the OpenAI-compatible rerank shape; absent configuration is a supported state.
- **Scope filtering** (`src/recall/scope.ts` → `extractScope`, `matchesScope`, `filterByScope`): reads `user_id`/`agent_id`/`app_id`/`run_id` from both carriers a mem0 client uses (body for writes, query string for single-item reads) and filters the corpus *before* any channel runs, so an out-of-scope memory never reaches a candidate pool, the reranker, or the shadow log.

### Interception and storage (`src/index.ts`)

- **Fetch interceptor** (`classify`, `normalizeWildcardFilters`, `createInterceptor`): wraps `globalThis.fetch`, classifies mem0 API requests, normalizes `"*"` entity filters (mem0ai/mem0#6168 workaround), serves cached reads within TTL, gates remote reads (429 breaker armed from `retry-after`, hourly freshness window), and degrades to stale-cache or local answers when the API fails.
- **Local ranking entry** (`rankLocal`): resolves a plan, builds the plan's channels over the scope-filtered corpus, runs the pipeline, and reports which pipeline actually served the read together with any degradation.
- **Persistent store** (`loadStore`, `makeSaver`, `harvestMemories`, `clampMemory`, `searchLocal`): owns the on-disk JSON state at `~/.pi/agent/mem0-cache.json` — read cache, memory corpus, pending ops, sync state, network-gate state, stats — and enforces the memory size bound on both entry paths (harvest and local write).
- **Embedding layer** (`createOpenAiCompatEmbedder`, `createEmbedHarness`, `ensureEmbeddings`, `searchLocalVector`): maintains the vector sidecar at `~/.pi/agent/mem0-vectors.json` in bounded, resumable batches; serves cosine ranking over unit-length vectors; and separates a transient query-embedding failure from a persistent corpus-level fault.
- **Pull-all** (`pullAllMemories`): full-mirror harvest via paginated getAll with the client's captured auth and filters, bypassing the interceptor, closing the gap between the query-driven mirror and the cloud corpus.
- **Sync runner** (`createSyncRunner`): uploads pending local memories with their original scope payload once any API call succeeds, with a 1h backoff on failure.
- **Shadow logger** (`recordShadow`, `appendShadowLog`, `summarizeShadow`): appends one JSONL entry per search miss, recording every strategy's ranking against the same remote ground truth. Purely observational.
- **Extension entry** (default export): wires the interceptor, sync runner, and `/mem0-cache` command into pi, and owns capability detection (which providers resolved, so the plan resolver knows what is available).

### Evaluation (`scripts/`)

- **Candidate build** (`build-gold.mjs`): samples queries from the shadow log and assembles a judging pool from the union of every recorded ranking.
- **Full-corpus retrieval** (`retrieve-full.mjs`): runs every strategy against the real in-scope corpus independently and records each strategy's own top-K, so the pool bounds what gets *judged* rather than what a strategy may *retrieve*.
- **Judging** (`judge-gold.mjs`): grades each (query, memory) pair by relevance from the query and memory text alone, with a grade pool shared across gold files so widening the pool costs only new candidates.
- **Scoring** (`score-full.mjs`): reports nDCG@10, R@10, P@5, MRR, hit@10 and zero@10 per strategy, optionally split by query shape.

## Key Relationships

The extension entry captures the *unwrapped* fetch for the sync runner and pull-all, so replayed writes and full-mirror reads never re-enter the interceptor.

Recall depends on the store for the corpus and on `src/recall/` for ranking; `src/recall/` depends on nothing above it, which is what keeps the ranking logic testable without a store. The embedding layer is consulted for capability but its failure never propagates as a request failure — `rankLocal` resolves around a dead provider rather than raising.

Provider credentials resolve through one path (`resolveProviderKey`, env then macOS Keychain) shared by the embedder and the reranker, so both report their source the same way and neither can silently hold an empty value.
