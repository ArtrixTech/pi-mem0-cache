# Architecture

## Components

- **Fetch interceptor** (`src/index.ts` → `classify`, `normalizeWildcardFilters`, `createInterceptor`): wraps `globalThis.fetch`, classifies mem0 API requests, normalizes `"*"` entity filters (mem0ai/mem0#6168 workaround), serves cached reads within TTL, gates remote reads (429 breaker armed from `retry-after`, hourly freshness window), and degrades to stale-cache/local-store answers or locally-applied writes when the API fails.
- **Persistent store** (`src/index.ts` → `loadStore`, `makeSaver`, `harvestMemories`, `searchLocal`): owns the on-disk JSON state (`~/.pi/agent/mem0-cache.json`) — read cache, memory corpus, sync state, network-gate state, stats — plus the keyword-overlap local search.
- **Sync runner** (`src/index.ts` → `createSyncRunner`): uploads pending local memories to mem0 with their original scope payload once any API call succeeds, with 1h backoff on failure.
- **Extension entry** (`src/index.ts` → default export): wires the interceptor and sync runner into pi, owns the `/mem0-cache` command.

## Key Relationships

All logic lives in the single dependency-free module `src/index.ts`; the extension entry captures the *unwrapped* fetch for the sync runner so replayed writes never re-enter the interceptor. Tests in `test/interceptor.test.ts` exercise everything below the entry point.
