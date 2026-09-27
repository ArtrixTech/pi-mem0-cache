/**
 * Cross-encoder reranking over a fused candidate pool.
 *
 * WHY A RERANKER AT ALL
 * The dense channel lifts overlap@10 to ~1.5 while MRR stays near 0.15: the right
 * memories reach the pool and sit in the wrong order. Ranking and retrieval fail
 * differently, and a cross-encoder sees the query and the document together, which
 * is the signal a bi-encoder cannot express. So the pipeline is two stages —
 * retrieve broadly with cheap channels, then spend one careful pass reordering the
 * top candidates.
 *
 * The reranker is deliberately optional at every level: a missing key, a dead
 * provider, or a slow response must degrade to the fused order rather than to no
 * answer. Callers pass it in; `recall()` catches a throw and keeps the fusion.
 */

import type { ChannelHit, FusedHit } from "./fusion.js";

export const DEFAULT_RERANK_ENDPOINT = "https://openrouter.ai/api/v1/rerank";
export const DEFAULT_RERANK_MODEL = "voyageai/rerank-2.5-lite";

export type RerankFn = (query: string, candidates: FusedHit[], textOf: (id: string) => string) => Promise<ChannelHit[]>;

export interface RerankerOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Per-document character cap. One oversized memory would otherwise blow the
   *  request limit and fail the whole batch, turning a single bad row into an
   *  outage of the precision stage. */
  maxDocChars?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Read a rerank response into ordered hits.
 *
 * Providers differ in envelope (`results` vs `data`), in score field
 * (`relevance_score` vs `score`), and in whether `index` is echoed back. All three
 * variations are handled here so a provider swap stays a config change.
 */
export function parseRerankResponse(body: unknown, ids: string[]): ChannelHit[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as { results?: unknown; data?: unknown };
  const list = Array.isArray(b.results) ? b.results : Array.isArray(b.data) ? b.data : [];
  const out: ChannelHit[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "object" || item === null) continue;
    const row = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
    // Fall back to array position: a response that omits index is still ordered.
    const idx = typeof row.index === "number" ? row.index : i;
    const id = ids[idx];
    if (id === undefined) continue;
    const raw = row.relevance_score ?? row.score;
    out.push({ id, score: typeof raw === "number" ? raw : 0 });
  }
  return out;
}

/** Build the reranker the pipeline calls. */
export function createReranker(opts: RerankerOptions): RerankFn {
  const endpoint = opts.endpoint ?? DEFAULT_RERANK_ENDPOINT;
  const model = opts.model ?? DEFAULT_RERANK_MODEL;
  const maxDocChars = opts.maxDocChars ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  return async (query, candidates, textOf) => {
    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.id);
    const documents = ids.map((id) => (textOf(id) ?? "").slice(0, maxDocChars));

    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, query, documents, top_n: documents.length }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Carry the body: a bare status is how a dead credential stayed invisible.
      const detail = await res.text().catch(() => "");
      throw new Error(`rerank ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return parseRerankResponse(await res.json(), ids);
  };
}

/** Resolve a reranker from the environment, or undefined when unconfigured.
 *  Preferring absence over a throwing stub keeps "no reranker" a supported state. */
export function createDefaultReranker(resolveKey: (provider: string) => string | undefined): RerankFn | undefined {
  if (process.env.MEM0_RERANK === "0") return undefined;
  const apiKey = process.env.MEM0_RERANK_API_KEY ?? resolveKey("openrouter");
  if (!apiKey) return undefined;
  return createReranker({
    apiKey,
    model: process.env.MEM0_RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
    endpoint: process.env.MEM0_RERANK_ENDPOINT ?? DEFAULT_RERANK_ENDPOINT,
  });
}
