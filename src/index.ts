/**
 * pi-mem0-cache
 *
 * Wraps globalThis.fetch and intercepts calls to api.mem0.ai:
 * - Reads (search / getAll / get / history) are cached to disk with a 24h TTL.
 * - On API failure (quota exhausted, network down, 4xx/5xx), reads fall back
 *   to the stale cache entry, then to a local memory store.
 * - A 429 response arms a breaker (duration from retry-after): while armed,
 *   reads are answered locally without touching the API.
 * - A freshness gate limits remote reads to one per remoteReadIntervalMs
 *   (default 1h); /mem0-cache refresh resets it explicitly.
 * - Writes that fail against the API are applied to the local store.
 * - A shadow logger records local-vs-remote search agreement for every search
 *   miss (~/.pi/agent/mem0-shadow.jsonl). Purely observational.
 * - An embedding recall layer (Jina, OpenAI-compatible /v1/embeddings) ranks
 *   the local mirror semantically for gated/fallback reads and is shadow-logged
 *   next to the keyword ranking.
 *
 * Successful remote writes echo into the mirror (delete/update/delete-all
 * propagate; adds harvest from the response) and invalidate the read cache.
 * Writes that fall back locally are queued: adds replay on sync from their
 * original payload; update/delete/delete-all intents replay from an op log
 * in the order they were applied.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KEYCHAIN_SERVICES, readKeyFromKeychain, resolveProviderKey } from "./credentials.js";
import { LEXICAL_WEIGHT_DEFAULT } from "./recall/fusion.js";
import { createDefaultReranker } from "./recall/rerank.js";
import { parseStrategy, resolveStrategy } from "./recall/plan.js";
import { loadStore, makeSaver } from "./store.js";
import {
  DEFAULT_REMOTE_READ_INTERVAL_MS,
  DEFAULT_SHADOW_PATH,
  DEFAULT_STORE_PATH,
  DEFAULT_TTL_MS,
  DEFAULT_VECTORS_PATH,
  EMBED_PROVIDERS,
  WRAPPED,
} from "./types.js";
import type { LocalStrategy } from "./types.js";
import {
  createDefaultEmbedder,
  createEmbedHarness,
  loadVectorStore,
  makeVectorSaver,
} from "./embed.js";
import { createInterceptor } from "./interceptor.js";
import { appendShadowLog, readShadowEntries, summarizeShadow } from "./shadow.js";
import {
  authFromEnv,
  createSyncRunner,
  filtersFromCache,
  pullAllMemories,
} from "./sync.js";
import type { CapturedAuth } from "./interceptor.js";

// ---------------------------------------------------------------------------
// Local memory operations

// ---------------------------------------------------------------------------
// Extension entry

/** Parse a strategy name from env, ignoring unknown values. */
export function readStrategy(value: string | undefined): LocalStrategy | undefined {
  return parseStrategy(value) as LocalStrategy | undefined;
}

/** Fusion weight for the lexical channel, from MEM0_FUSION_BM25_WEIGHT.
 *  1 restores equal weighting; the default is the gold-set-derived value. */
export function readLexicalWeight(value: string | undefined): number {
  if (value === undefined || value === "") return LEXICAL_WEIGHT_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : LEXICAL_WEIGHT_DEFAULT;
}

export default function piMem0Cache(pi: ExtensionAPI): void {
  const storePath = process.env.MEM0_CACHE_PATH ?? DEFAULT_STORE_PATH;
  const ttlMs = Number(process.env.MEM0_CACHE_TTL_MS) > 0 ? Number(process.env.MEM0_CACHE_TTL_MS) : DEFAULT_TTL_MS;
  const remoteReadIntervalMs =
    Number(process.env.MEM0_CACHE_REMOTE_READ_INTERVAL_MS) > 0
      ? Number(process.env.MEM0_CACHE_REMOTE_READ_INTERVAL_MS)
      : DEFAULT_REMOTE_READ_INTERVAL_MS;
  const store = loadStore(storePath);
  const save = makeSaver(store, storePath);
  const shadowEnabled = process.env.MEM0_CACHE_SHADOW !== "0";
  const shadowPath = process.env.MEM0_CACHE_SHADOW_PATH ?? DEFAULT_SHADOW_PATH;
  const vectorsPath = process.env.MEM0_VECTORS_PATH ?? DEFAULT_VECTORS_PATH;
  const vecStore = loadVectorStore(vectorsPath);
  const saveVectors = makeVectorSaver(vecStore, vectorsPath);
  const embedder = createDefaultEmbedder();
  const embed = embedder ? createEmbedHarness(store, saveVectors, vecStore, embedder) : undefined;
  // A missing reranker is a supported state: the fusion strategy still answers,
  // and only "fusion+rerank" reports a degradation.
  const reranker = createDefaultReranker(resolveProviderKey);

  // -- Test mode ------------------------------------------------------------
  // MEM0_RECALL_STRATEGY picks what answers local reads; MEM0_RECALL_TEST=1
  // (or simply setting a strategy) switches the shadow logger into comparison
  // mode, where every read records what each strategy would have answered
  // against the same remote ground truth. Test mode changes what is measured,
  // never what the agent receives.
  const localStrategy = readStrategy(process.env.MEM0_RECALL_STRATEGY);
  const lexicalWeight = readLexicalWeight(process.env.MEM0_FUSION_BM25_WEIGHT);
  const testMode = process.env.MEM0_RECALL_TEST === "1" || localStrategy !== undefined;

  const g = globalThis as { fetch?: typeof fetch & { [WRAPPED]?: boolean } };
  const authRef: { current?: CapturedAuth } = {};
  const filtersRef: { current?: Record<string, unknown> } = {};
  // Capture the original fetch BEFORE wrapping so the sync runner's replayed
  // adds go straight to the network, bypassing the interceptor.
  const realFetch = g.fetch;
  const syncer = createSyncRunner({
    store,
    save,
    fetchImpl: (...args: Parameters<typeof fetch>) => {
      if (!realFetch) throw new Error("fetch unavailable");
      return realFetch(...args);
    },
    getAuth: () => authRef.current,
    onEvent: (msg) => console.warn(`[pi-mem0-cache] ${msg}`),
  });

  if (typeof g.fetch === "function" && !g.fetch[WRAPPED]) {
    const wrapped = createInterceptor(g.fetch, {
      store,
      save,
      ttlMs,
      remoteReadIntervalMs,
      authRef,
      shadowLog: shadowEnabled ? (entry) => appendShadowLog(shadowPath, entry) : undefined,
      embed,
      filtersRef,
      localStrategy,
      reranker,
      lexicalWeight,
      testMode,
      onFallback: (reason) => console.warn(`[pi-mem0-cache] ${reason}`),
      onPassthroughSuccess: () => {
        void syncer.maybeSync();
        void embed?.ensure();
      },
    }) as typeof fetch & { [WRAPPED]?: boolean };
    wrapped[WRAPPED] = true;
    g.fetch = wrapped;
  }

  // Warm the vector sidecar at session start: covers mirror drift accumulated
  // before any search traffic has flowed through the interceptor.
  void embed?.ensure();

  pi.registerCommand("mem0-cache", {
    description:
      "mem0 read cache: /mem0-cache [stats|provider|sync|refresh|clear|clear-all|path|shadow|embed|embed refresh|pull-all]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim() || "stats";
      switch (sub) {
        case "stats": {
          const s = store.stats;
          const localCount = syncer.pendingCount();
          const opCount = syncer.pendingOps();
          const sync = store.syncState.lastResult ? ` | last sync: ${store.syncState.lastResult}` : "";
          const blocked = store.netState.readsBlockedUntil;
          const gate =
            blocked !== undefined && Date.now() < blocked
              ? ` | reads blocked until ${new Date(blocked).toISOString()}`
              : store.netState.lastRemoteReadAt !== undefined
                ? ` | last remote read ${Math.round((Date.now() - store.netState.lastRemoteReadAt) / 60000)}min ago`
                : "";
          ctx.ui.notify(
            `mem0-cache: ${Object.keys(store.cache).length} cached reads, ` +
              `${localCount} pending local memories${opCount > 0 ? `, ${opCount} pending ops` : ""} | hits ${s.hits}, misses ${s.misses}, ` +
              `passthroughs ${s.passthroughs}, stale ${s.staleServed}, fallbacks ${s.fallbacks}, ` +
              `localWrites ${s.localWrites}, gated ${s.gated}${sync}${gate}`,
            "info",
          );
          break;
        }
        case "refresh": {
          delete store.netState.lastRemoteReadAt;
          delete store.netState.readsBlockedUntil;
          save();
          ctx.ui.notify("mem0-cache: gates cleared — the next read hits the mem0 API", "info");
          break;
        }
        case "sync": {
          const r = await syncer.sync(true);
          ctx.ui.notify(
            r.skipped
              ? `mem0-cache sync: nothing to do (${r.pending} pending, ${authRef.current ? "backoff active or " : ""}${authRef.current ? "" : "no mem0 auth captured yet"})`
              : `mem0-cache sync: uploaded ${r.uploaded}, failed ${r.failed}, pending ${r.pending}`,
            "info",
          );
          break;
        }
        case "shadow": {
          const entries = readShadowEntries(shadowPath);
          const s = summarizeShadow(entries);
          // Strategy comparison table, best-first on MRR. Every column is scored
          // against the same remote ground truth, so they are directly comparable.
          // Rows come from the summary map, so adding a strategy to STRATEGY_ROWS
          // is enough to make it appear here.
          const rows = Object.entries(s.strategies)
            .filter(([, v]) => v.comparisons > 0)
            .map(([name, v]) => ({
              name,
              n: v.comparisons,
              o5: v.meanOverlap5,
              o10: v.meanOverlap10,
              mrr: v.meanMrr,
              top1: v.top1Rate,
            }));
          const table = rows
            .sort((a, b) => b.mrr - a.mrr)
            .map(
              (r) =>
                `${r.name.padEnd(13)} n=${String(r.n).padStart(4)}  o@5 ${r.o5.toFixed(2)}  o@10 ${r.o10.toFixed(2)}  MRR ${r.mrr.toFixed(3)}  top1 ${(r.top1 * 100).toFixed(0)}%`,
            )
            .join("\n");
          let msg = `mem0-cache shadow: ${s.comparisons} comparisons (${s.fallbacks} fallback)\n${table}`;
          // Per-channel failures are the thing that silently degrades output, so
          // each strategy gets its own line, keeping them separately readable.
          const errs = new Map<string, number>();
          for (const e of entries) {
            for (const [k, v] of Object.entries(e.channelErrors ?? {})) {
              errs.set(`${k}: ${v.slice(0, 60)}`, (errs.get(`${k}: ${v.slice(0, 60)}`) ?? 0) + 1);
            }
          }
          if (errs.size > 0) {
            msg +=
              "\nchannel errors:\n" +
              [...errs.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([k, n]) => `  ${n}x ${k}`)
                .join("\n");
          }
          ctx.ui.notify(msg, "info");
          break;
        }
        case "provider": {
          // Credential and health report. Never prints a key value — only the
          // source it came from and the last error the provider returned.
          const lines: string[] = [];
          for (const [name, preset] of Object.entries(EMBED_PROVIDERS)) {
            const envSet = Boolean(process.env[preset.keyEnv]);
            const keychain = readKeyFromKeychain(KEYCHAIN_SERVICES[name] ?? "");
            const source = envSet ? `env ${preset.keyEnv}` : keychain ? `keychain (${KEYCHAIN_SERVICES[name]})` : "none";
            lines.push(
              `${name.padEnd(11)} ${source.padEnd(38)} default model ${preset.model}`,
            );
          }
          const active = embedder ? `${embedder.model}` : "none (local reads use BM25 only)";
          lines.push(``, `active embedder: ${active}`);

          // Show the resolution, not just the request: the operator's question is
          // "what is answering my reads", and the answer is a plan plus whatever
          // was skipped to reach it.
          const caps = {
            dense: embed !== undefined && embed.status().enabled,
            rerank: reranker !== undefined,
          };
          const res = resolveStrategy(localStrategy ?? "auto", caps);
          const ndcg = res.plan.measuredNdcg === null ? "unmeasured" : `nDCG@10 ${res.plan.measuredNdcg.toFixed(3)}`;
          lines.push(`requested strategy: ${localStrategy ?? "auto (default)"}`);
          lines.push(`serving strategy:   ${res.plan.strategy}  (${res.plan.summary}; ${ndcg})`);
          for (const s of res.skipped) {
            lines.push(`  skipped ${s.strategy.padEnd(14)} ${s.reason}`);
          }
          lines.push(
            `capabilities:       embed ${caps.dense ? "ok" : "off"} | rerank ${caps.rerank ? "ok" : "off"}`,
          );
          lines.push(
            `providers:          openrouter ${resolveProviderKey("openrouter") ? "key present" : "no key"}`,
          );
          lines.push(`test mode: ${testMode ? "on" : "off"}`);
          if (embed) {
            const s = embed.status();
            lines.push(
              `embed layer: ${s.vectors}/${s.corpus} vectors` +
                `${s.lastError ? ` | last error: ${s.lastError}` : ""}` +
                `${s.cooldownUntil ? ` | cooling down` : ""}`,
            );
          }
          lines.push(``, `add a key:  ./scripts/setup-key.sh ${Object.keys(EMBED_PROVIDERS).join("|")}`);
          ctx.ui.notify(`mem0-cache provider:\n${lines.join("\n")}`, embedder ? "info" : "warning");
          break;
        }
        case "embed": {
          if (!embed) {
            ctx.ui.notify(
              "mem0-cache embed: disabled — set JINA_API_KEY or mem0-config.json jinaApiKey (MEM0_EMBED=0 forces off)",
              "warning",
            );
            break;
          }
          await embed.ensure(); // self-heal sidecar drift before reporting
          const s = embed.status();
          ctx.ui.notify(
            `mem0-cache embed: ${s.vectors}/${s.corpus} vectors | model ${s.model}` +
              `${s.lastError ? ` | last error: ${s.lastError}` : ""}` +
              `${s.cooldownUntil ? ` | cooling down until ${new Date(s.cooldownUntil).toISOString()}` : ""}`,
            "info",
          );
          break;
        }
        case "embed refresh": {
          if (!embed) {
            ctx.ui.notify("mem0-cache embed: disabled — set JINA_API_KEY or mem0-config.json jinaApiKey", "warning");
            break;
          }
          const msg = await embed.refresh();
          ctx.ui.notify(`mem0-cache embed refresh: ${msg}`, "info");
          break;
        }
        case "pull-all": {
          try {
            const r = await pullAllMemories({
              store,
              fetchImpl: (...args) => {
                if (!realFetch) throw new Error("fetch unavailable");
                return realFetch(...args);
              },
              getAuth: () => authRef.current ?? authFromEnv(),
              getFilters: () => filtersRef.current ?? filtersFromCache(store),
            });
            save();
            ctx.ui.notify(
              `mem0-cache pull-all: ${r.pages} pages, ${r.fetched} fetched, ${r.newHarvested} new ` +
                `(mirror ${Object.keys(store.memories).length}${r.total ? `/${r.total}` : ""})`,
              "info",
            );
            if (embed) {
              await embed.ensure();
              const s = embed.status();
              ctx.ui.notify(`mem0-cache pull-all: vectors ${s.vectors}/${s.corpus}`, "info");
            }
          } catch (err) {
            ctx.ui.notify(
              `mem0-cache pull-all failed: ${err instanceof Error ? err.message : String(err)}`,
              "warning",
            );
          }
          break;
        }
        case "clear":
          store.cache = {};
          save();
          ctx.ui.notify("mem0-cache: read cache cleared (local memories kept)", "info");
          break;
        case "clear-all":
          store.cache = {};
          store.memories = {};
          // Mark the wipe so the save merge treats an empty corpus as this
          // session's decision and does not restore what the disk still holds.
          store.wipedAt = Date.now();
          save();
          ctx.ui.notify("mem0-cache: cache and local memories cleared", "info");
          break;
        case "path":
          ctx.ui.notify(`mem0-cache store: ${storePath}`, "info");
          break;
        default:
          ctx.ui.notify("usage: /mem0-cache [stats|sync|refresh|clear|clear-all|path|shadow|embed|pull-all]", "warning");
      }
    },
  });
}

export { EMBED_PROVIDERS, MAX_MEMORY_CHARS } from "./types.js";
export type {
  CachedResponse,
  ClassifiedRequest,
  FetchInput,
  LocalMemory,
  LocalStrategy,
  MemoryOverflow,
  NetState,
  PendingOp,
  Store,
  SyncState,
} from "./types.js";
export { emptyStore, loadStore, makeSaver } from "./store.js";
export { classify, isMem0Host } from "./request.js";
export { clampMemory, harvestMemories, searchLocal, searchLocalScored, tokenize } from "./memory.js";

export {
  rankLocal,
} from "./rank.js";
export type {
  Reranker,
} from "./rank.js";
export {
  applyRemoteWriteEcho,
  reconcileOps,
} from "./writes.js";
export {
  appendShadowLog,
  compareShadow,
  readShadowEntries,
  shadowSegments,
  summarizeShadow,
} from "./shadow.js";
export type {
  ShadowEntry,
  ShadowLocalHit,
  ShadowRemoteHit,
  ShadowStrategyRanking,
  ShadowSummary,
  StrategySummary,
} from "./shadow.js";
export {
  cosine,
  createDefaultEmbedder,
  createEmbedHarness,
  createJinaEmbedder,
  createOpenAiCompatEmbedder,
  emptyVectorStore,
  ensureEmbeddings,
  loadVectorStore,
  makeVectorSaver,
  normalizeVec,
  readJinaKeyFromConfig,
  searchLocalVector,
} from "./embed.js";
export type {
  EmbedHarness,
  Embedder,
  EnsureProgress,
  OpenAiCompatEmbedderOptions,
  VectorRecord,
  VectorStore,
} from "./embed.js";
export {
  createInterceptor,
  extractHeaders,
  normalizeWildcardFilters,
} from "./interceptor.js";
export type {
  CapturedAuth,
  InterceptorOptions,
} from "./interceptor.js";
export {
  DEFAULT_SYNC_BACKOFF_MS,
  MAX_SYNC_FAILURES,
  authFromEnv,
  createSyncRunner,
  filtersFromCache,
  pullAllMemories,
} from "./sync.js";
export type {
  PullAllOptions,
  PullAllResult,
  ReplayOutcome,
  SyncResult,
  SyncRunnerOptions,
} from "./sync.js";
export { KEYCHAIN_SERVICES, readKeyFromKeychain, resolveProviderKey } from "./credentials.js";
export { applyLocalWrite, stripInternal } from "./writes.js";
