/**
 * pi-mem0-cache
 *
 * Wraps globalThis.fetch and intercepts calls to api.mem0.ai:
 * - Reads (search / getAll / get / history) are cached to disk with a 24h TTL.
 * - On API failure (quota exhausted, network down, 4xx/5xx), reads fall back
 *   to the stale cache entry, then to a local memory store.
 * - Writes that fail against the API are applied to the local store instead.
 *
 * Local writes are NOT replayed to mem0 later — the local store remains
 * searchable via the read fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "mem0-cache.json");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const WRAPPED = Symbol.for("pi-mem0-cache.wrapped");
const MAX_FALLBACK_RESULTS = 10;

interface CachedResponse {
  status: number;
  body: string;
  savedAt: number;
}

export interface LocalMemory {
  id: string;
  memory: string;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  source: "local" | "observed";
  [key: string]: unknown;
}

export interface Store {
  version: 1;
  cache: Record<string, CachedResponse>;
  memories: Record<string, LocalMemory>;
  stats: {
    hits: number;
    misses: number;
    passthroughs: number;
    staleServed: number;
    fallbacks: number;
    localWrites: number;
  };
}

export function emptyStore(): Store {
  return {
    version: 1,
    cache: {},
    memories: {},
    stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0 },
  };
}

export function loadStore(path: string): Store {
  try {
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    const base = emptyStore();
    return {
      version: 1,
      cache: parsed.cache ?? {},
      memories: parsed.memories ?? {},
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
    };
  } catch {
    return emptyStore();
  }
}

export function makeSaver(store: Store, path: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2));
      renameSync(tmp, path);
    } catch (err) {
      console.warn("[pi-mem0-cache] failed to persist store:", err);
    }
  };
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (typeof timer.unref === "function") timer.unref();
  };
}

// ---------------------------------------------------------------------------
// Request classification

type FetchInput = string | URL | Request;

interface ClassifiedRequest {
  url: URL;
  method: string;
  bodyText: string | undefined;
  kind: "read-search" | "read-getall" | "read-get" | "read-history" | "read-other" | "write-add" | "write-update" | "write-delete" | "write-delete-all" | "write-other" | "other";
  memoryId?: string;
  query?: string;
}

export function isMem0Host(url: URL): boolean {
  return url.hostname === "api.mem0.ai" || url.hostname.endsWith(".mem0.ai");
}

export function classify(input: FetchInput, init?: RequestInit): ClassifiedRequest | null {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isMem0Host(url)) return null;

  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const rawBody = init?.body ?? (typeof input === "object" && "body" in input ? (input as Request).body : undefined);
  const bodyText = typeof rawBody === "string" ? rawBody : undefined;
  // Bodies that aren't plain strings (streams etc.) — passthrough, don't intercept.
  if (rawBody !== undefined && bodyText === undefined) return null;

  const path = url.pathname;
  const memoryIdMatch = path.match(/^\/v1\/memories\/([^/]+)\/?$/);
  const historyMatch = path.match(/^\/v1\/memories\/([^/]+)\/history\/?$/);

  let parsedBody: Record<string, unknown> | undefined;
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
  }

  if (method === "GET" && historyMatch) {
    return { url, method, bodyText, kind: "read-history", memoryId: historyMatch[1] };
  }
  if (method === "POST" && /^\/v[23]\/memories\/search\/?$/.test(path)) {
    return { url, method, bodyText, kind: "read-search", query: typeof parsedBody?.query === "string" ? parsedBody.query : undefined };
  }
  if (method === "POST" && /^\/v3\/memories\/add\/?$/.test(path)) {
    return { url, method, bodyText, kind: "write-add" };
  }
  if (method === "POST" && /^\/v3\/memories\/?$/.test(path)) {
    return { url, method, bodyText, kind: "read-getall" };
  }
  if (method === "GET" && memoryIdMatch) {
    return { url, method, bodyText, kind: "read-get", memoryId: memoryIdMatch[1] };
  }
  if ((method === "PUT" || method === "PATCH") && memoryIdMatch) {
    return { url, method, bodyText, kind: "write-update", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && memoryIdMatch) {
    return { url, method, bodyText, kind: "write-delete", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && /^\/v1\/memories\/?$/.test(path)) {
    return { url, method, bodyText, kind: "write-delete-all" };
  }
  if (method === "GET") {
    return { url, method, bodyText, kind: "read-other" };
  }
  return { url, method, bodyText, kind: "other" };
}

function cacheKey(req: ClassifiedRequest): string {
  return `${req.method} ${req.url.pathname}${req.url.search} ${req.bodyText ?? ""}`;
}

// ---------------------------------------------------------------------------
// Local memory operations

export function harvestMemories(store: Store, bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { results?: unknown[] }).results)
      ? (parsed as { results: unknown[] }).results
      : [];
  for (const item of candidates) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.memory !== "string") continue;
    const existing = store.memories[m.id];
    // Never let an observed copy overwrite a local write.
    if (existing?.source === "local") continue;
    store.memories[m.id] = {
      ...m,
      id: m.id,
      memory: m.memory,
      created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
      updated_at: typeof m.updated_at === "string" ? m.updated_at : new Date().toISOString(),
      deleted: false,
      source: "observed",
    } as LocalMemory;
  }
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[一-鿿＀-￯]/g) ?? [];
}

export function searchLocal(store: Store, query: string, limit = MAX_FALLBACK_RESULTS): LocalMemory[] {
  const tokens = tokenize(query);
  const all = Object.values(store.memories).filter((m) => !m.deleted);
  if (tokens.length === 0) return all.slice(0, limit);
  const scored = all
    .map((m) => {
      const text = m.memory.toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

function stripInternal(m: LocalMemory): Record<string, unknown> {
  const { deleted, source, ...rest } = m;
  return rest;
}

function applyLocalWrite(store: Store, req: ClassifiedRequest): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (req.kind) {
    case "write-add": {
      let contents: string[] = [];
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { messages?: { content?: string }[] };
        contents = (body.messages ?? [])
          .map((m) => m.content)
          .filter((c): c is string => typeof c === "string" && c.length > 0);
      } catch {
        /* ignore */
      }
      const memory = contents.join("\n") || "(empty)";
      const id = `local-${randomUUID()}`;
      store.memories[id] = { id, memory, created_at: now, updated_at: now, source: "local" };
      return { message: "Memory stored locally (mem0 API unavailable).", id, status: "PENDING" };
    }
    case "write-update": {
      const id = req.memoryId ?? "";
      let text: string | undefined;
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { text?: string };
        text = body.text;
      } catch {
        /* ignore */
      }
      const existing = store.memories[id];
      if (existing) {
        if (text !== undefined) existing.memory = text;
        existing.updated_at = now;
        existing.source = "local";
      } else {
        store.memories[id] = { id, memory: text ?? "", created_at: now, updated_at: now, source: "local" };
      }
      return { message: "Memory updated locally (mem0 API unavailable).", id };
    }
    case "write-delete": {
      const id = req.memoryId ?? "";
      if (store.memories[id]) store.memories[id].deleted = true;
      return { message: "Memory deleted locally (mem0 API unavailable)." };
    }
    case "write-delete-all": {
      for (const m of Object.values(store.memories)) m.deleted = true;
      return { message: "Memories deleted locally (mem0 API unavailable)." };
    }
    default:
      return { message: "Handled locally (mem0 API unavailable)." };
  }
}

// ---------------------------------------------------------------------------
// Fetch interceptor

export interface InterceptorOptions {
  store: Store;
  save: () => void;
  ttlMs: number;
  onFallback?: (reason: string) => void;
}

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
  const { store, save, ttlMs, onFallback } = opts;

  const interceptor = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const req = classify(input, init);
    if (!req || req.kind === "other") {
      return fetchImpl(input as string | URL | Request, init);
    }

    // -- Writes ---------------------------------------------------------------
    if (req.kind.startsWith("write-")) {
      if (req.kind === "write-other") return fetchImpl(input as string | URL | Request, init);
      try {
        const res = await fetchImpl(input as string | URL | Request, init);
        if (res.ok) {
          store.stats.passthroughs++;
          return res;
        }
        store.stats.fallbacks++;
        store.stats.localWrites++;
        onFallback?.(`write ${req.kind} fell back to local store (HTTP ${res.status})`);
      } catch (err) {
        store.stats.fallbacks++;
        store.stats.localWrites++;
        onFallback?.(`write ${req.kind} fell back to local store (${err instanceof Error ? err.message : String(err)})`);
      }
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

    store.stats.misses++;
    let failed: Response | null = null;
    try {
      const res = await fetchImpl(input as string | URL | Request, init);
      if (res.ok) {
        const body = await res.clone().text();
        store.cache[key] = { status: res.status, body, savedAt: Date.now() };
        harvestMemories(store, body);
        store.stats.passthroughs++;
        save();
        return res;
      }
      failed = res;
      store.stats.fallbacks++;
      onFallback?.(`read ${req.kind} fell back (HTTP ${res.status})`);
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
    if (req.kind === "read-search") {
      save();
      return jsonResponse({ results: searchLocal(store, req.query ?? "").map(stripInternal) });
    }
    if (req.kind === "read-getall") {
      const all = Object.values(store.memories).filter((m) => !m.deleted).map(stripInternal);
      save();
      return jsonResponse({ results: all, count: all.length });
    }
    if (req.kind === "read-get" && req.memoryId) {
      const m = store.memories[req.memoryId];
      if (m && !m.deleted) {
        save();
        return jsonResponse(stripInternal(m));
      }
    }

    // Can't synthesize a meaningful answer (history, unknown reads): return the
    // original failed response, or rethrow for network errors.
    if (failed) return failed;
    throw new Error("mem0 API unreachable and no local fallback available");
  };

  return interceptor as typeof fetch;
}

// ---------------------------------------------------------------------------
// Extension entry

export default function piMem0Cache(pi: ExtensionAPI): void {
  const storePath = process.env.MEM0_CACHE_PATH ?? DEFAULT_STORE_PATH;
  const ttlMs = Number(process.env.MEM0_CACHE_TTL_MS) > 0 ? Number(process.env.MEM0_CACHE_TTL_MS) : DEFAULT_TTL_MS;
  const store = loadStore(storePath);
  const save = makeSaver(store, storePath);

  const g = globalThis as { fetch?: typeof fetch & { [WRAPPED]?: boolean } };
  if (typeof g.fetch === "function" && !g.fetch[WRAPPED]) {
    const wrapped = createInterceptor(g.fetch, {
      store,
      save,
      ttlMs,
      onFallback: (reason) => console.warn(`[pi-mem0-cache] ${reason}`),
    }) as typeof fetch & { [WRAPPED]?: boolean };
    wrapped[WRAPPED] = true;
    g.fetch = wrapped;
  }

  pi.registerCommand("mem0-cache", {
    description: "mem0 read cache: /mem0-cache [stats|clear|clear-all|path]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim() || "stats";
      switch (sub) {
        case "stats": {
          const s = store.stats;
          const localCount = Object.values(store.memories).filter((m) => m.source === "local" && !m.deleted).length;
          ctx.ui.notify(
            `mem0-cache: ${Object.keys(store.cache).length} cached reads, ` +
              `${localCount} local memories | hits ${s.hits}, misses ${s.misses}, ` +
              `passthroughs ${s.passthroughs}, stale ${s.staleServed}, fallbacks ${s.fallbacks}, localWrites ${s.localWrites}`,
            "info",
          );
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
          save();
          ctx.ui.notify("mem0-cache: cache and local memories cleared", "info");
          break;
        case "path":
          ctx.ui.notify(`mem0-cache store: ${storePath}`, "info");
          break;
        default:
          ctx.ui.notify("usage: /mem0-cache [stats|clear|clear-all|path]", "warning");
      }
    },
  });
}
