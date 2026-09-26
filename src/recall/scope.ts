/**
 * Scope filtering for local (mirror-served) reads.
 *
 * The mirror stores memories from every project on the account. Remote reads are
 * scoped by the mem0 client's `filters` (user_id / app_id / agent_id / run_id).
 * The local read path originally ignored them entirely and answered `getAll`
 * with `Object.values(store.memories)` — every memory of every app. That gap was
 * invisible while local recall was too poor to be used. Fusion made local recall
 * good enough to serve answers, which turns the gap into a correctness defect: a
 * project-scoped read returns another project's memories.
 *
 * These helpers reproduce the remote scoping rule locally. One deliberate
 * nuance: `"*"` is read as "unconstrained". mem0's wildcard matches only non-null
 * values, the asymmetry behind mem0ai/mem0#6168 (global-scope writes store
 * `app_id: null`, global reads filter `app_id: "*"`, so the writes are
 * unreachable). The interceptor already patches remote requests to the
 * unconstrained reading, so the local path follows the patched semantics.
 */

/** Entity keys that scope a mem0 request. */
export const SCOPE_KEYS = ["user_id", "agent_id", "app_id", "run_id"] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];

export type ScopeFilters = Partial<Record<ScopeKey, string>>;

/**
 * Extract the effective scope from a read request.
 *
 * Two carriers are supported because mem0 uses both: POST reads (search,
 * getAll) put `filters` in a JSON body, and SDK single-item GETs
 * (`/v1/memories/<id>/?user_id=…`) put them in the query string. A GET cannot
 * carry a body at all under the fetch standard, so for those reads the query
 * form is the sole scope carrier.
 *
 * Returns undefined when neither carrier yields usable scope (no filters, no
 * entity keys, or every entity key a wildcard) — meaning "unconstrained", so
 * callers must treat undefined as "match everything".
 */
export function extractScope(bodyText: string | undefined, search?: string): ScopeFilters | undefined {
  const fromBody = scopeFromBody(bodyText);
  const fromQuery = scopeFromQuery(search);
  if (!fromBody) return fromQuery;
  if (!fromQuery) return fromBody;
  // A request carrying both must satisfy both; merge, body winning on conflict.
  return { ...fromQuery, ...fromBody };
}

function scopeFromBody(bodyText: string | undefined): ScopeFilters | undefined {
  if (!bodyText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const filters = (parsed as { filters?: unknown }).filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  return pickScopeKeys(filters as Record<string, unknown>);
}

/** Query-string form: `?user_id=artrix&app_id=artrix-reach`, plus the same keys
 *  nested under `filters[...]` in case a client sends it that way. */
function scopeFromQuery(search: string | undefined): ScopeFilters | undefined {
  if (!search) return undefined;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return undefined;
  const flat: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) flat[key] = value;
  return pickScopeKeys(flat);
}

function pickScopeKeys(filters: Record<string, unknown>): ScopeFilters | undefined {
  const out: ScopeFilters = {};
  for (const key of SCOPE_KEYS) {
    const value = filters[key];
    // "*" means unconstrained: drop it, keeping the key out of the match set.
    if (typeof value === "string" && value.length > 0 && value !== "*") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Does a memory satisfy a request's scope?
 *
 * A scoped key requires an equal, present, non-null value on the memory: a
 * memory with no `app_id` cannot answer a request scoped to an app, which is the
 * conservative direction (a missing field is unknown provenance, so it must not
 * leak into a scoped read). Keys the request does not scope are not checked,
 * which is what lets global-scope memories (`app_id: null`) remain visible to
 * user-scoped reads.
 */
export function matchesScope(
  memory: Record<string, unknown>,
  scope: ScopeFilters | undefined,
): boolean {
  if (!scope) return true;
  for (const key of SCOPE_KEYS) {
    const wanted = scope[key];
    if (wanted === undefined) continue;
    const actual = memory[key];
    if (typeof actual !== "string" || actual !== wanted) return false;
  }
  return true;
}

/** Filter a list of memories down to those the request is allowed to see. */export function filterByScope<T extends Record<string, unknown>>(memories: T[], scope: ScopeFilters | undefined): T[] {
  if (!scope) return memories;
  return memories.filter((m) => matchesScope(m, scope));
}
