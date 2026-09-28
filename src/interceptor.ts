/**
 * Fetch interceptor: classify mem0 requests, serve cached and local answers,
 * and gate remote reads.
 */

import { recordShadow } from "./shadow.js";
import { applyLocalWrite, stripInternal } from "./writes.js";
import { LEXICAL_WEIGHT_DEFAULT, recall } from "./recall/fusion.js";
import { extractScope, matchesScope } from "./recall/scope.js";
import { harvestMemories } from "./memory.js";
import { cacheKey, classify } from "./request.js";
import { DEFAULT_429_BLOCK_MS } from "./types.js";
import type {
  CachedResponse,
  ClassifiedRequest,
  FetchInput,
  LocalMemory,
  LocalStrategy,
  Store,
} from "./types.js";
import { rankLocal } from "./rank.js";
import { applyRemoteWriteEcho, reconcileOps } from "./writes.js";
import type { EmbedHarness } from "./embed.js";
import type { Reranker } from "./rank.js";
import type { ShadowEntry } from "./shadow.js";

// ---------------------------------------------------------------------------
// Fetch interceptor

export const ENTITY_FILTER_KEYS = new Set(["user_id", "agent_id", "app_id", "run_id"]);

/**
 * Workaround for mem0ai/mem0#6168: mem0's "*" wildcard matches only non-null
 * values, so the pi mem0 plugin's global-scope reads (filters.app_id = "*")
 * can never see global-scope writes (stored with app_id = null). Dropping the
 * "*" entity filter restores the intended "unconstrained" semantics.
 */
export function normalizeWildcardFilters(bodyText: string | undefined): string | undefined {
  if (!bodyText) return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (typeof parsed !== "object" || parsed === null) return bodyText;
  const body = parsed as Record<string, unknown>;
  const filters = body.filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return bodyText;
  const f = filters as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(f)) {
    if (ENTITY_FILTER_KEYS.has(key) && f[key] === "*") {
      delete f[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(body) : bodyText;
}

export interface CapturedAuth {
  origin: string;
  headers: Record<string, string>;
}

export function extractHeaders(input: FetchInput, init?: RequestInit): Record<string, string> | undefined {
  const raw = init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined);
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  try {
    new Headers(raw as HeadersInit).forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    return undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface InterceptorOptions {
  store: Store;
  save: () => void;
  ttlMs: number;
  onFallback?: (reason: string) => void;
  /** Shared cell the interceptor fills with the last seen mem0 auth headers. */
  authRef?: { current?: CapturedAuth };
  /** Called after any successful mem0 API response (read or write). */
  onPassthroughSuccess?: () => void;
  /** Freshness window: synthesizable reads (search / getAll / get) issued
   *  within this interval since the last successful remote read are answered
   *  locally without touching the network. 0 disables the gate. */
  remoteReadIntervalMs?: number;
  /** Receives one ShadowEntry per read-search miss (remote or fallback-served). */
  shadowLog?: (entry: ShadowEntry) => void;
  /** Embedding harness: semantic ranking of the mirror for gated/fallback
   *  reads; null results degrade to the keyword ranking. */
  embed?: EmbedHarness;
  /** Shared cell capturing the client's most recent read filters (user_id, …) —
   *  pull-all reuses them minus entity-scoping keys. */
  filtersRef?: { current?: Record<string, unknown> };
  /** Test mode: when set, local reads are served by the named strategy, in place
   *  of the default fusion, and every served read is written to the shadow log
   *  with the strategy that produced it — so strategies can be compared on real
   *  traffic without changing what the agent sees mid-session. */
  localStrategy?: LocalStrategy;
  /** Cross-encoder reranking of the fused pool. Enabled with the
   *  "fusion+rerank" and "dense+rerank" strategies; absent means those degrade. */
  reranker?: Reranker;
  /** Fusion weight for the lexical channel; see LEXICAL_WEIGHT_DEFAULT. */
  lexicalWeight?: number;
  /** Enable per-strategy shadow comparison on every read-search miss. */
  testMode?: boolean;
}

/** How a local (non-network) search read is answered. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createInterceptor(
  fetchImpl: typeof fetch,
  opts: InterceptorOptions,
): typeof fetch {
  const { store, save, ttlMs, onFallback, remoteReadIntervalMs = 0 } = opts;
  /** Answer a read without the network: stale cache first, then the local
   *  store. Null for reads that can't be synthesized (history, unknown). */
  const serveLocalRead = async (req: ClassifiedRequest, cached?: CachedResponse): Promise<Response | null> => {
    if (cached) return jsonResponse(JSON.parse(cached.body), cached.status);
    if (req.kind === "read-search") {
      const ranked: LocalMemory[] = await rankLocal(
        store,
        req.query ?? "",
        {
          embed: opts.embed,
          localStrategy: opts.localStrategy,
          reranker: opts.reranker,
          lexicalWeight: opts.lexicalWeight,
          scope: extractScope(req.bodyText, req.search),
          onStrategy: (info) => {
            store.stats.lastStrategy = info.strategy;
            if (info.degraded) {
              store.stats.lastStrategyDegraded = info.degraded;
              onFallback?.(
                `local read strategy "${opts.localStrategy ?? "fusion"}" degraded to "${info.strategy}": ${info.degraded}`,
              );
            }
            const failed = info.channels.filter((c) => !c.ok);
            for (const c of failed) onFallback?.(`recall channel ${c.name} failed: ${c.error ?? "unknown"}`);
          },
        },
      );
      return jsonResponse({ results: ranked.map(stripInternal) });
    }
    if (req.kind === "read-getall") {
      // Scope-filtered: a project-scoped getAll must not return another
      // project's memories. See src/recall/scope.ts for the filtering rule.
      const scope = extractScope(req.bodyText, req.search);
      const all = Object.values(store.memories)
        .filter((m) => !m.deleted && matchesScope(m, scope))
        .map(stripInternal);
      return jsonResponse({ results: all, count: all.length });
    }
    if (req.kind === "read-get" && req.memoryId) {
      const scope = extractScope(req.bodyText, req.search);
      const m = store.memories[req.memoryId];
      if (m && !m.deleted && matchesScope(m, scope)) return jsonResponse(stripInternal(m));
    }
    return null;
  };

  const interceptor = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    let req = classify(input, init);
    if (!req || req.kind === "other") {
      return fetchImpl(input as string | URL | Request, init);
    }

    if (opts.authRef) {
      const headers = extractHeaders(input, init);
      if (headers?.authorization) {
        opts.authRef.current = { origin: req.url.origin, headers };
      }
    }

    if (req.kind === "read-search" || req.kind === "read-getall") {
      const normalized = normalizeWildcardFilters(req.bodyText);
      if (normalized !== undefined && normalized !== req.bodyText) {
        req = { ...req, bodyText: normalized };
        init = { ...init, body: normalized };
      }
      if (opts.filtersRef && req.bodyText) {
        try {
          const parsed = JSON.parse(req.bodyText) as { filters?: Record<string, unknown> };
          if (typeof parsed.filters === "object" && parsed.filters !== null && Object.keys(parsed.filters).length > 0) {
            opts.filtersRef.current = parsed.filters;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // -- Writes ---------------------------------------------------------------
    if (req.kind.startsWith("write-")) {
      if (req.kind === "write-other") return fetchImpl(input as string | URL | Request, init);
      try {
        const res = await fetchImpl(input as string | URL | Request, init);
        if (res.ok) {
          // Harvest the write response (v3 add returns the created memory) so
          // the mirror tracks newly written memories organically.
          const body = await res.clone().text().catch(() => "");
          if (body) harvestMemories(store, body);
          applyRemoteWriteEcho(store, req);
          reconcileOps(store, req);
          // Every cached read predates this mutation.
          store.cache = {};
          store.stats.passthroughs++;
          opts.onPassthroughSuccess?.();
          save();
          return res;
        }
        store.stats.fallbacks++;
        store.stats.localWrites++;
        const writeErrBody = await res.clone().text().catch(() => "");
        onFallback?.(
          `write ${req.kind} fell back to local store (HTTP ${res.status})${writeErrBody ? `: ${writeErrBody.slice(0, 200)}` : ""}`,
        );
      } catch (err) {
        store.stats.fallbacks++;
        store.stats.localWrites++;
        onFallback?.(`write ${req.kind} fell back to local store (${err instanceof Error ? err.message : String(err)})`);
      }
      // The mirror just changed — cached reads predate the mutation.
      store.cache = {};
      const result = applyLocalWrite(store, req);
      save();
      return jsonResponse(result);
    }

    // -- Reads ----------------------------------------------------------------
    const key = cacheKey(req);
    const cached = store.cache[key];
    const fresh = cached !== undefined && Date.now() - cached.savedAt < ttlMs;

    if (cached && fresh) {
      store.stats.hits++;
      return jsonResponse(JSON.parse(cached.body), cached.status);
    }

    // -- Network gates -------------------------------------------------------
    // 429 breaker (armed from retry-after) and the freshness window both answer
    // reads locally without touching the API. Only reads we can synthesize are
    // gated; history / unknown reads stay on the network path.
    const gateable = req.kind === "read-search" || req.kind === "read-getall" || req.kind === "read-get";
    const breakerArmed =
      store.netState.readsBlockedUntil !== undefined && Date.now() < store.netState.readsBlockedUntil;
    const freshnessActive =
      remoteReadIntervalMs > 0 &&
      store.netState.lastRemoteReadAt !== undefined &&
      Date.now() - store.netState.lastRemoteReadAt < remoteReadIntervalMs;
    if (gateable && (breakerArmed || freshnessActive)) {
      store.stats.gated++;
      save();
      return (await serveLocalRead(req, cached)) ?? jsonResponse({ error: "not available locally (network gate active)" }, 404);
    }

    store.stats.misses++;
    let failed: Response | null = null;
    try {
      const res = await fetchImpl(input as string | URL | Request, init);
      if (res.ok) {
        const body = await res.clone().text();
        if (req.kind === "read-search" && opts.shadowLog) {
          await recordShadow(opts.shadowLog, "remote", req, body, store, opts.embed, opts.reranker, opts.lexicalWeight);
        }
        store.cache[key] = { status: res.status, body, savedAt: Date.now() };
        harvestMemories(store, body);
        store.netState.lastRemoteReadAt = Date.now();
        delete store.netState.readsBlockedUntil;
        store.stats.passthroughs++;
        opts.onPassthroughSuccess?.();
        save();
        return res;
      }
      failed = res;
      store.stats.fallbacks++;
      const errBody = await res.clone().text().catch(() => "");
      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        store.netState.readsBlockedUntil =
          Date.now() + (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_429_BLOCK_MS);
      }
      onFallback?.(`read ${req.kind} fell back (HTTP ${res.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
    } catch (err) {
      store.stats.fallbacks++;
      onFallback?.(`read ${req.kind} fell back (${err instanceof Error ? err.message : String(err)})`);
    }

    if (cached) {
      store.stats.staleServed++;
      save();
      return jsonResponse(JSON.parse(cached.body), cached.status);
    }

    // Local fallback for search / getAll / single get.
    const localAnswer = await serveLocalRead(req);
    if (localAnswer) {
      if (req.kind === "read-search" && opts.shadowLog) {
        await recordShadow(opts.shadowLog, "fallback", req, null, store, opts.embed, opts.reranker, opts.lexicalWeight);
      }
      save();
      return localAnswer;
    }

    // Can't synthesize a meaningful answer (history, unknown reads): return the
    // original failed response, or rethrow for network errors.
    if (failed) return failed;
    throw new Error("mem0 API unreachable and no local fallback available");
  };

  return interceptor as typeof fetch;
}
