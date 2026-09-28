/**
 * Sync runner and pull-all: replay local writes once the API works, and
 * harvest the full cloud corpus into the mirror.
 */

import { join } from "node:path";
import { harvestMemories } from "./memory.js";
import { classify } from "./request.js";
import { ENTITY_FILTER_KEYS } from "./types.js";
import type { LocalMemory, PendingOp, Store } from "./types.js";
import type { CapturedAuth } from "./interceptor.js";

// ---------------------------------------------------------------------------
// Sync: upload locally-stored memories once the API works again

export interface SyncRunnerOptions {
  store: Store;
  save: () => void;
  fetchImpl: typeof fetch;
  getAuth: () => CapturedAuth | undefined;
  onEvent?: (message: string) => void;
  /** Called once when an item is retired from the queue after repeated
   *  permanent failures, so the operator learns a memory did not sync. */
  onQuarantine?: (id: string, reason: string) => void;
  /** Backoff after a failed sync attempt (default 1h). */
  backoffMs?: number;
}

/** Attempts before a permanently-rejected item leaves the queue. A payload the
 *  server answers with 400/404/422 will answer the same way next time, so
 *  three tries is enough to conclude the answer is final. */
export const MAX_SYNC_FAILURES = 3;

/**
 * Whether a rejection can succeed on retry.
 *
 * The distinction decides the response: a permanent rejection is counted and
 * eventually retired, while a transient one keeps its place and arms backoff.
 * Retrying a 400 forever costs a request per run and never converges, and
 * retiring a 500 discards a memory the server would accept moments later.
 */
function isPermanentStatus(status: number): boolean {
  if (status === 408 || status === 429) return false; // timeout / rate limited
  if (status >= 500) return false;
  return status >= 400;
}

export type ReplayOutcome = { ok: true } | { ok: false; permanent: boolean; reason: string };

export interface SyncResult {
  uploaded: number;
  failed: number;
  skipped: boolean;
  /** Pending work remaining: local adds + queued ops, excluding quarantined. */
  pending: number;
  appliedOps: number;
  /** Requests attempted in this run. */
  attempts: number;
  /** Items retired this run after repeated permanent failures. */
  quarantined: string[];
}

export const DEFAULT_SYNC_BACKOFF_MS = 60 * 60 * 1000;

export function createSyncRunner(opts: SyncRunnerOptions) {
  const { store, save, fetchImpl, getAuth, onEvent } = opts;
  const backoffMs = opts.backoffMs ?? DEFAULT_SYNC_BACKOFF_MS;
  let inFlight: Promise<SyncResult> | null = null;

  const pendingList = () =>
    Object.values(store.memories).filter(
      (m) => m.source === "local" && !m.deleted && !store.syncState.quarantined?.[m.id],
    );
  const pendingTotal = () => pendingList().length + store.ops.length;
  const quarantine = (id: string, reason: string): void => {
    store.syncState.quarantined = { ...(store.syncState.quarantined ?? {}), [id]: { reason, at: Date.now() } };
    delete store.syncState.failures?.[id];
    onEvent?.(`sync: retired ${id} after ${MAX_SYNC_FAILURES} permanent failures (${reason})`);
    opts.onQuarantine?.(id, reason);
  };

  /** Record a permanent failure and retire the item once it has had enough
   *  attempts. Returns true when this failure retired it. */
  const notePermanentFailure = (id: string, reason: string): boolean => {
    const failures = { ...(store.syncState.failures ?? {}) };
    const count = (failures[id] ?? 0) + 1;
    failures[id] = count;
    store.syncState.failures = failures;
    if (count >= MAX_SYNC_FAILURES) {
      quarantine(id, reason);
      return true;
    }
    return false;
  };

  /** Entity keys this client writes under, read from the corpus. Used to repair
   *  a locally-stored memory whose payload was captured before query-string
   *  scope was read: the record has text and no entity id, and mem0 rejects any
   *  request without one. */
  const corpusScope = (): Record<string, string> => {
    for (const m of Object.values(store.memories)) {
      if (m.source === "local") continue;
      const rec = m as unknown as Record<string, unknown>;
      const scope: Record<string, string> = {};
      for (const k of ENTITY_FILTER_KEYS) {
        const v = rec[k];
        if (typeof v === "string" && v) scope[k] = v;
      }
      if (Object.keys(scope).length > 0) return scope;
    }
    return {};
  };

  async function replayAdd(m: LocalMemory, auth: CapturedAuth): Promise<ReplayOutcome> {
    const base = { ...(m.addPayload ?? {}) };
    delete base.messages;
    const hasEntity = [...ENTITY_FILTER_KEYS].some((k) => {
      const v = base[k];
      return typeof v === "string" ? v.length > 0 : v !== undefined && v !== null;
    });
    if (!hasEntity) {
      // Repair from the corpus where possible. With no scope anywhere the
      // request goes out as captured: the server's answer decides the outcome,
      // and the record keeps its text either way.
      const repaired = corpusScope();
      if (Object.keys(repaired).length > 0) Object.assign(base, repaired);
    }
    const payload = { ...base, messages: [{ role: "user", content: m.memory }] };
    try {
      const res = await fetchImpl(`${auth.origin}/v3/memories/add/`, {
        method: "POST",
        headers: { ...auth.headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = `HTTP ${res.status}`;
        const bodyText = await res.text().catch(() => "");
        return isPermanentStatus(res.status)
          ? { ok: false, permanent: true, reason: `HTTP ${res.status}${bodyText ? ` ${bodyText.slice(0, 120)}` : ""}` }
          : { ok: false, permanent: false, reason: `HTTP ${res.status}` };
      }
      harvestMemories(store, await res.text().catch(() => ""));
      m.source = "observed";
      delete m.addPayload;
      // The merge that guards against concurrent writers resolves a shared id by
      // updated_at, and a session that loaded this record earlier holds the
      // pre-upload copy. Touching the timestamp lets the newer state win.
      m.updated_at = new Date().toISOString();
      return { ok: true };
    } catch {
      return { ok: false, permanent: false, reason: "network error" };
    }
  }

  /** Replay one queued write intent. 404 counts as applied: the server-side
   *  goal state (updated/gone) is unreachable because the target is gone —
   *  the mirror converges by dropping its copy. */
  async function replayOp(op: PendingOp, auth: CapturedAuth): Promise<ReplayOutcome> {
    const headers = { ...auth.headers, "content-type": "application/json" };
    const classify = (res: Response): ReplayOutcome =>
      isPermanentStatus(res.status)
        ? { ok: false, permanent: true, reason: `HTTP ${res.status}` }
        : { ok: false, permanent: false, reason: `HTTP ${res.status}` };
    try {
      if (op.kind === "write-update" && op.memoryId) {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.memoryId}/`, {
          method: "PUT",
          headers,
          body: op.bodyText ?? "{}",
        });
        if (!res.ok && res.status !== 404) return classify(res);
        if (res.status === 404) delete store.memories[op.memoryId];
      } else if (op.kind === "write-delete" && op.memoryId) {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.memoryId}/`, { method: "DELETE", headers });
        if (!res.ok && res.status !== 404) return classify(res);
        delete store.memories[op.memoryId]; // server-gone: drop the tombstone
      } else if (op.kind === "write-delete-all") {
        const res = await fetchImpl(`${auth.origin}/v1/memories/${op.query ?? ""}`, { method: "DELETE", headers });
        if (!res.ok && res.status !== 404) return classify(res);
        for (const m of Object.values(store.memories)) if (m.deleted) delete store.memories[m.id];
      }
      store.ops = store.ops.filter((o) => o !== op);
      return { ok: true };
    } catch {
      return { ok: false, permanent: false, reason: "network error" };
    }
  }

  async function sync(force = false): Promise<SyncResult> {
    // Locally-created memories deleted before ever syncing never reached the
    // cloud — purge them outright.
    for (const m of Object.values(store.memories)) {
      if (m.source === "local" && m.deleted) delete store.memories[m.id];
    }

    const pending = pendingList();
    const auth = getAuth();
    if ((pending.length === 0 && store.ops.length === 0) || !auth) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] };
    }
    const now = Date.now();
    if (!force && store.syncState.backoffUntil && now < store.syncState.backoffUntil) {
      return { uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] };
    }
    store.syncState.lastAttemptAt = now;

    // Replay in the order the writes happened locally: adds (created_at) and
    // queued ops (at) merge into one chronological queue, so a delete-all
    // recorded before a later add replays before it.
    const queue: { at: number; kind: "add" | "op"; id: string; run: () => Promise<ReplayOutcome> }[] = [
      ...pending.map((m) => ({
        at: Date.parse(m.created_at) || 0,
        kind: "add" as const,
        id: m.id,
        run: () => replayAdd(m, auth),
      })),
      ...store.ops.map((op) => ({
        at: op.at,
        kind: "op" as const,
        id: op.memoryId ?? `op-${op.at}`,
        run: () => replayOp(op, auth),
      })),
    ].sort((a, b) => a.at - b.at);

    let uploaded = 0;
    let appliedOps = 0;
    let failed = 0;
    let attempts = 0;
    const retired: string[] = [];
    let sawTransient = false;
    for (const item of queue) {
      attempts++;
      const outcome = await item.run();
      if (outcome.ok) {
        if (item.kind === "add") uploaded++;
        else appliedOps++;
        continue;
      }
      failed++;
      if (outcome.permanent) {
        // Retire only the item the server refuses. Every item behind it still
        // gets its attempt: one unacceptable payload used to stop the whole
        // queue, which left four ordinary memories unsynced indefinitely.
        if (item.kind === "add" && notePermanentFailure(item.id, outcome.reason)) retired.push(item.id);
        else if (item.kind === "op") notePermanentFailure(item.id, outcome.reason);
        continue;
      }
      // Transient: the server is unhappy with the run, not the payload. Stop
      // here and back off: the rest would hit the same failing host.
      sawTransient = true;
      store.syncState.backoffUntil = Date.now() + backoffMs;
      onEvent?.(`sync paused after a failed replay; retrying after backoff`);
      break;
    }
    if (sawTransient) {
      // cleared below only when nothing transient happened
    } else if (uploaded > 0 || appliedOps > 0) {
      store.syncState.backoffUntil = 0;
    }
    store.syncState.lastResult = `uploaded ${uploaded}, ops applied ${appliedOps}, failed ${failed}, pending ${pendingTotal()}${retired.length ? `, retired ${retired.length}` : ""}`;
    save();
    if (uploaded > 0 || appliedOps > 0 || failed > 0) {
      onEvent?.(`sync: ${store.syncState.lastResult}`);
    }
    return { uploaded, failed, skipped: false, pending: pendingTotal(), appliedOps, attempts, quarantined: retired };
  }

  /** Fire-and-forget; dedupes concurrent runs. Returns null when nothing to do. */
  function maybeSync(): Promise<SyncResult> | null {
    if (inFlight) return inFlight;
    if (pendingList().length === 0 && store.ops.length === 0) return null;
    inFlight = sync(false)
      .catch(() => ({ uploaded: 0, failed: 0, skipped: true, pending: pendingTotal(), appliedOps: 0, attempts: 0, quarantined: [] }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { sync, maybeSync, pendingCount: () => pendingList().length, pendingOps: () => store.ops.length };
}

// ---------------------------------------------------------------------------
// Pull-all: full-mirror harvest via paginated getAll (bypasses the interceptor)

export interface PullAllOptions {
  store: Store;
  /** Unwrapped fetch — pull-all must bypass the interceptor's gates/cache. */
  fetchImpl: typeof fetch;
  getAuth: () => CapturedAuth | undefined;
  /** Entity filters observed from the client's own reads; app_id/agent_id/run_id
   *  are dropped so the mirror covers every app of the user. */
  getFilters: () => Record<string, unknown> | undefined;
  pageSize?: number;
  maxPages?: number;
}

export interface PullAllResult {
  pages: number;
  fetched: number;
  newHarvested: number;
  /** Server-reported total for the filter scope (0 when absent). */
  total: number;
}

/** Fallback auth built from the mem0 client's environment key (Token scheme,
 *  default platform origin) — used when no request has been observed yet. */
export function authFromEnv(): CapturedAuth | undefined {
  const key = process.env.MEM0_API_KEY;
  if (!key) return undefined;
  return { origin: process.env.MEM0_API_ORIGIN || "https://api.mem0.ai", headers: { authorization: `Token ${key}` } };
}

/** Fallback filters parsed from any cached request key in the store — lets
 *  pull-all run before the client has made a single read this session. */
export function filtersFromCache(store: Store): Record<string, unknown> | undefined {
  for (const key of Object.keys(store.cache)) {
    if (!key.startsWith("POST /v3/memories/")) continue;
    // Key format: "METHOD <path> <body-json>" — the JSON body may contain
    // spaces (raw query text), so rejoin everything after the path.
    const parts = key.split(" ");
    if (parts.length < 3) continue;
    try {
      const parsed = JSON.parse(parts.slice(2).join(" ")) as { filters?: Record<string, unknown> };
      if (parsed.filters && typeof parsed.filters === "object" && Object.keys(parsed.filters).length > 0) {
        return parsed.filters;
      }
    } catch {
      /* skip malformed key */
    }
  }
  return undefined;
}

export async function pullAllMemories(opts: PullAllOptions): Promise<PullAllResult> {
  const { store, fetchImpl, getAuth, getFilters, pageSize = 500, maxPages = 50 } = opts;
  const auth = getAuth();
  if (!auth) throw new Error("no mem0 auth captured yet — run any mem0 read first");
  const filters = getFilters();
  if (!filters || Object.keys(filters).length === 0) {
    throw new Error("no mem0 filters captured yet — run any memory search first");
  }
  const baseFilters: Record<string, unknown> = { ...filters };
  for (const key of ["app_id", "agent_id", "run_id"]) delete baseFilters[key];
  const before = Object.keys(store.memories).length;
  let fetched = 0;
  let pages = 0;
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${auth.origin}/v3/memories/?page=${page}&page_size=${pageSize}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ filters: baseFilters }),
    });
    if (!res.ok) throw new Error(`getAll page ${page} HTTP ${res.status}`);
    const body = (await res.json()) as { results?: unknown[]; count?: number };
    const results = Array.isArray(body.results) ? body.results : [];
    pages++;
    fetched += results.length;
    if (typeof body.count === "number") total = body.count;
    if (results.length > 0) harvestMemories(store, JSON.stringify({ results }));
    // Stop when the page runs short OR the server-reported total is reached —
    // the server may clamp page_size below what we asked for.
    if (results.length < pageSize) break;
    if (total > 0 && fetched >= total) break;
  }
  return { pages, fetched, newHarvested: Object.keys(store.memories).length - before, total };
}
