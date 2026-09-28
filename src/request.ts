/**
 * Request classification: which mem0 endpoint a fetch call targets and what
 * scope it carries.
 */

import type { ClassifiedRequest, FetchInput } from "./types.js";

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
  const search = url.search;
  // The SDK mixes versions by operation: /v3/ for search + add, /v1/ for
  // single-item get/update/delete and history. Matching only v1 here silently
  // sent every v3 single-item operation to the network path.
  const memoryIdMatch = path.match(/^\/v[13]\/memories\/([^/]+)\/?$/);
  const historyMatch = path.match(/^\/v[13]\/memories\/([^/]+)\/history\/?$/);

  let parsedBody: Record<string, unknown> | undefined;
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
  }

  if (method === "GET" && historyMatch) {
    return { url, method, bodyText, search, kind: "read-history", memoryId: historyMatch[1] };
  }
  if (method === "POST" && /^\/v[23]\/memories\/search\/?$/.test(path)) {
    return { url, method, bodyText, search, kind: "read-search", query: typeof parsedBody?.query === "string" ? parsedBody.query : undefined };
  }
  if (method === "POST" && /^\/v3\/memories\/add\/?$/.test(path)) {
    return { url, method, bodyText, search, kind: "write-add" };
  }
  if (method === "POST" && /^\/v3\/memories\/?$/.test(path)) {
    return { url, method, bodyText, search, kind: "read-getall" };
  }
  if (method === "GET" && memoryIdMatch) {
    return { url, method, bodyText, search, kind: "read-get", memoryId: memoryIdMatch[1] };
  }
  if ((method === "PUT" || method === "PATCH") && memoryIdMatch) {
    return { url, method, bodyText, search, kind: "write-update", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && memoryIdMatch) {
    return { url, method, bodyText, search, kind: "write-delete", memoryId: memoryIdMatch[1] };
  }
  if (method === "DELETE" && /^\/v1\/memories\/?$/.test(path)) {
    return { url, method, bodyText, kind: "write-delete-all" };
  }
  if (method === "GET") {
    return { url, method, bodyText, kind: "read-other" };
  }
  return { url, method, bodyText, kind: "other" };
}

export function cacheKey(req: ClassifiedRequest): string {
  return `${req.method} ${req.url.pathname}${req.url.search} ${req.bodyText ?? ""}`;
}
