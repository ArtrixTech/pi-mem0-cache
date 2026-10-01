/**
 * Shadow log: records every strategy's local ranking next to mem0's remote
 * ranking on each search miss. Purely observational.
 */

import { EmbedHarnessChannel } from "./rank.js";
import { reportDiagnostic } from "./diagnostics.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LEXICAL_WEIGHT_DEFAULT,
  LexicalChannel,
  recall,
  type ChannelHit,
} from "./recall/fusion.js";
import { extractScope, matchesScope } from "./recall/scope.js";
import { CODE_VERSION, SHADOW_SCHEMA_VERSION } from "./version.js";
import { searchLocalScored } from "./memory.js";
import { SHADOW_ROTATE_BYTES } from "./types.js";
import type { ClassifiedRequest, Store } from "./types.js";
import type { EmbedHarness } from "./embed.js";
import type { Reranker } from "./rank.js";

// ---------------------------------------------------------------------------
// Shadow log: records local-vs-remote search agreement on every miss

export interface ShadowLocalHit {
  id: string;
  score: number;
}

export interface ShadowRemoteHit {
  id: string;
  score?: number;
}

export interface ShadowEntry {
  ts: number;
  /** Field-structure version, so a reader can tell an absent field from one the
   *  writer did not know about. See src/version.ts. */
  schemaVersion?: number;
  /** The running code's version at write time. Lets a report answer "since
   *  version X" without guessing which build produced an entry. */
  codeVersion?: string;
  /** remote = miss answered by the API; fallback = API failed, local answered */
  mode: "remote" | "fallback";
  query: string;
  local: ShadowLocalHit[];
  remote: ShadowRemoteHit[];
  overlap5: number;
  overlap10: number;
  /** reciprocal rank of the remote top-1 id within the local ranking (0 = absent) */
  mrr: number;
  /** vector-recall side (present when the embedding layer answered) */
  localVec?: ShadowLocalHit[];
  overlapVec5?: number;
  overlapVec10?: number;
  mrrVec?: number;
  /** BM25-only ranking side — the lexical floor, logged next to `local` (the
   *  legacy scorer) so the two compare on identical live traffic. */
  localBm25?: ShadowLocalHit[];
  overlapBm25_5?: number;
  overlapBm25_10?: number;
  mrrBm25?: number;
  /** Fused (lexical + dense, RRF) ranking side, stored as ids. */
  localFusion?: string[];
  overlapFusion5?: number;
  overlapFusion10?: number;
  mrrFusion?: number;
  /** Dense-only ranking side: the shipped default's retrieval stage. */
  localDense?: string[];
  overlapDense5?: number;
  overlapDense10?: number;
  mrrDense?: number;
  /** Dense followed by the reranker: the shipped default end to end. */
  localDenseRerank?: string[];
  overlapDenseRerank5?: number;
  overlapDenseRerank10?: number;
  mrrDenseRerank?: number;
  /** Query terms BM25 found nowhere in the corpus — a vocabulary-gap signal
   *  that separates "no lexical signal" from "lexical signal misranked". */
  unmatched?: string[];
  /** The entity filters this read carried. Recorded so a report can stratify by
   *  scope: accuracy over a project-scoped corpus and accuracy over the whole
   *  account are different questions. */
  scope?: Record<string, string>;
  /** Per-channel failures observed while building this entry. */
  channelErrors?: Record<string, string>;
}

export function compareShadow(
  local: { id: string }[],
  remote: { id: string }[],
): { overlap5: number; overlap10: number; mrr: number } {
  const localTop10 = local.slice(0, 10);
  const remoteTop10 = remote.slice(0, 10);
  const overlap = (k: number): number => {
    const remoteTopK = remoteTop10.slice(0, k).map((h) => h.id);
    const localTopK = new Set(localTop10.slice(0, k).map((h) => h.id));
    return remoteTopK.filter((id) => localTopK.has(id)).length;
  };
  const remoteTop1 = remoteTop10[0]?.id;
  const rank = remoteTop1 === undefined ? -1 : localTop10.findIndex((h) => h.id === remoteTop1);
  return { overlap5: overlap(5), overlap10: overlap(10), mrr: rank >= 0 ? 1 / (rank + 1) : 0 };
}

export interface ShadowSummary {
  comparisons: number;
  fallbacks: number;
  /** Legacy keyword scorer (the `local` field). */
  meanOverlap5: number;
  meanOverlap10: number;
  meanMrr: number;
  perfect5Rate: number;
  top1Recall: number;
  /** Per-strategy rows, keyed by strategy name. Each carries its own comparison
   *  count, since a strategy that could not run on an entry is excluded rather
   *  than counted as zero. */
  strategies: Record<string, StrategySummary>;
}

export interface StrategySummary {
  comparisons: number;
  meanOverlap5: number;
  meanOverlap10: number;
  meanMrr: number;
  top1Rate: number;
}

/** How to read one strategy out of a shadow entry. Adding a strategy to the
 *  comparison table means adding a row here. */
const STRATEGY_ROWS: { name: string; ids: (e: ShadowEntry) => string[] | undefined; mrr: (e: ShadowEntry) => number | undefined }[] = [
  { name: "legacy", ids: (e) => e.local.map((h) => h.id), mrr: (e) => e.mrr },
  { name: "remote", ids: (e) => e.remote.map((h) => h.id), mrr: () => 1 },
  {
    name: "bm25",
    ids: (e) => e.localBm25?.map((h) => h.id),
    mrr: (e) => e.mrrBm25,
  },
  { name: "dense", ids: (e) => e.localDense ?? e.localVec?.map((h) => h.id), mrr: (e) => e.mrrDense ?? e.mrrVec },
  { name: "fusion", ids: (e) => e.localFusion, mrr: (e) => e.mrrFusion },
  { name: "dense+rerank", ids: (e) => e.localDenseRerank, mrr: (e) => e.mrrDenseRerank },
];

/** Summarise one strategy over the entries where it produced a ranking. */
function summarizeStrategy(remote: ShadowEntry[], row: (typeof STRATEGY_ROWS)[number]): StrategySummary {
  const eligible = remote.filter((e) => row.mrr(e) !== undefined);
  const n = eligible.length;
  const mean = (pick: (e: ShadowEntry) => number) => (n === 0 ? 0 : eligible.reduce((s, e) => s + pick(e), 0) / n);
  return {
    comparisons: n,
    // Derived from the recorded id list against remote's own list, so a
    // strategy's overlap is recomputable from the log alone.
    meanOverlap5: mean((e) => overlapWithRemote(row.ids(e) ?? [], e, 5)),
    meanOverlap10: mean((e) => overlapWithRemote(row.ids(e) ?? [], e, 10)),
    meanMrr: mean((e) => row.mrr(e) ?? 0),
    top1Rate: n === 0 ? 0 : eligible.filter((e) => (row.mrr(e) ?? 0) > 0).length / n,
  };
}

/** How many of the strategy's top-N ids appear in remote's list. */
function overlapWithRemote(ids: string[], entry: ShadowEntry, n: number): number {
  const remoteIds = new Set(entry.remote.map((h) => h.id));
  return ids.slice(0, n).filter((id) => remoteIds.has(id)).length;
}

export function summarizeShadow(entries: ShadowEntry[]): ShadowSummary {
  const remote = entries.filter((e) => e.mode === "remote");
  const n = remote.length;
  const mean = (pick: (e: ShadowEntry) => number) => (n === 0 ? 0 : remote.reduce((sum, e) => sum + pick(e), 0) / n);
  return {
    comparisons: n,
    fallbacks: entries.length - n,
    meanOverlap5: mean((e) => e.overlap5),
    meanOverlap10: mean((e) => e.overlap10),
    meanMrr: mean((e) => e.mrr),
    perfect5Rate: n === 0 ? 0 : remote.filter((e) => e.overlap5 >= 5).length / n,
    top1Recall: n === 0 ? 0 : remote.filter((e) => e.mrr > 0).length / n,
    strategies: Object.fromEntries(STRATEGY_ROWS.map((row) => [row.name, summarizeStrategy(remote, row)])),
  };
}

/** Append one entry, sealing the active segment when it grows past
 *  rotateBytes.
 *
 * Sealing renames the full segment to a date-stamped sibling and starts a fresh
 * active file. Nothing is deleted, so a report can read the whole history rather
 * than a sliding window of the most recent lines.
 *
 * The active path keeps its configured name, which means an existing log written
 * by an earlier version becomes the first active segment and its entries stay
 * readable without a migration step.
 */
export function appendShadowLog(
  path: string,
  entry: ShadowEntry,
  rotateBytes = SHADOW_ROTATE_BYTES,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size <= rotateBytes) return;
    // A date-stamped name sorts with the other segments and distinguishes a
    // repeated seal on the same day from the one before it.
    const stamp = new Date().toISOString().slice(0, 10);
    const base = path.replace(/\.jsonl$/, "");
    let target = `${base}-${stamp}.jsonl`;
    for (let n = 1; existsSync(target); n++) target = `${base}-${stamp}-${n}.jsonl`;
    renameSync(path, target);
  } catch (err) {
    reportDiagnostic("failed to append shadow log", err);
  }
}

/** Every segment belonging to one shadow log, oldest first.
 *
 * The active file comes last so a caller that reads in order sees history in
 * time order. A sealed segment carries its seal date in the name; entries inside
 * it carry their own `ts`, which is what the report actually sorts on.
 */
export function shadowSegments(path: string): string[] {
  const dir = dirname(path);
  const base = basename(path).replace(/\.jsonl$/, "");
  const sealed: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}-`) || !name.endsWith(".jsonl")) continue;
      sealed.push(join(dir, name));
    }
  } catch {
    return existsSync(path) ? [path] : [];
  }
  // Lexicographic order matches chronological order because the name carries an
  // ISO date, and a same-day n-suffix sorts after the base name.
  sealed.sort();
  return existsSync(path) ? [...sealed, path] : sealed;
}

export function readShadowEntries(path: string): ShadowEntry[] {
  const entries: ShadowEntry[] = [];
  for (const segment of shadowSegments(path)) {
    try {
      for (const line of readFileSync(segment, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as ShadowEntry);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* an unreadable segment must not hide the others */
    }
  }
  return entries.sort((a, b) => a.ts - b.ts);
}

function remoteSearchHits(body: string | null): ShadowRemoteHit[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const hits: ShadowRemoteHit[] = [];
    for (const item of results.slice(0, 10)) {
      if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
        const hit = item as { id: string; score?: unknown };
        hits.push(typeof hit.score === "number" ? { id: hit.id, score: hit.score } : { id: hit.id });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** Compare the pre-fetch mirror state against the remote answer for one search.
 *  Called BEFORE harvestMemories on the success path, so the local rankings
 *  reflect what a freshness-gated read would have served from the mirror.
 *  Keyword ranking is always recorded; the vector ranking is added when the
 *  embedding layer answers. */
/** Test mode: a single shadow entry records what *every* strategy would have
 *  answered, so strategies are compared on identical live traffic. The remote
 *  ranking is the shared ground truth; `served` names the one the agent saw. */
export interface ShadowStrategyRanking {
  /** ids in rank order (top 10), so any strategy can be scored post-hoc from the
   *  log without reproducing its internals. */
  ids: string[];
  overlap5: number;
  overlap10: number;
  mrr: number;
  /** Populated when the strategy could not run (provider down, etc.). */
  error?: string;
}

export async function recordShadow(
  log: (entry: ShadowEntry) => void,
  mode: ShadowEntry["mode"],
  req: ClassifiedRequest,
  remoteBody: string | null,
  store: Store,
  embed?: EmbedHarness,
  /// Recorded alongside the other strategies so the shipped default's rerank
  /// stage is measured on live traffic. Absent means the dense+rerank side is
  /// simply not logged for this entry.
  reranker?: Reranker,
  lexicalWeight: number = LEXICAL_WEIGHT_DEFAULT,
): Promise<void> {
  const remote = remoteSearchHits(remoteBody);
  const query = req.query ?? "";
  // Log under the request's own scope: the shadow log must measure what this
  // read was entitled to see, not what a scope-free corpus would have returned.
  const scope = extractScope(req.bodyText, req.search);
  const scopedDocs = (): { id: string; text: string }[] =>
    Object.values(store.memories)
      .filter((m) => !m.deleted && matchesScope(m, scope))
      .map((m) => ({ id: m.id, text: m.memory }));
  const local = searchLocalScored(store, query, 10).map(({ m, score }) => ({ id: m.id, score }));
  const { overlap5, overlap10, mrr } = compareShadow(local, remote);
  const entry: ShadowEntry = {
    ts: Date.now(),
    schemaVersion: SHADOW_SCHEMA_VERSION,
    ...(CODE_VERSION ? { codeVersion: CODE_VERSION } : {}),
    mode,
    query: query.slice(0, 200),
    local,
    remote,
    overlap5,
    overlap10,
    mrr,
    ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
  };

  // BM25 ranking — the new lexical floor, logged on the same entry so the
  // legacy-vs-BM25 comparison comes from live traffic.
  const lexicalChannel = new LexicalChannel({ docs: scopedDocs() });
  const bm25Hits = lexicalChannel.search(query, 10) as ChannelHit[];
  const bm25Ids = bm25Hits.map((h) => h.id);
  if (bm25Ids.length > 0) {
    const bm = compareShadow(
      bm25Ids.map((id) => ({ id })),
      remote,
    );
    entry.localBm25 = bm25Ids.map((id, i) => ({ id, score: Number((bm25Hits[i].score ?? 0).toFixed(4)) }));
    entry.overlapBm25_5 = bm.overlap5;
    entry.overlapBm25_10 = bm.overlap10;
    entry.mrrBm25 = bm.mrr;
    entry.unmatched = lexicalChannel.unmatched(query).slice(0, 10);
  }

  // Fused ranking — what the fusion strategy would have served. Recorded as ids
  // so it survives any later scorer change.
  const denseDocs = embed ? Object.values(store.memories).filter((m) => !m.deleted && matchesScope(m, scope)) : [];
  if (embed) {
    try {
      const result = await recall({
        query,
        channels: [
          new LexicalChannel({ docs: scopedDocs(), weight: lexicalWeight }),
          new EmbedHarnessChannel(embed, denseDocs),
        ],
        perChannelLimit: 50,
        fusedLimit: 10,
      });
      const fusedIds = result.hits.map((h) => h.id);
      if (fusedIds.length > 0) {
        const f = compareShadow(
          fusedIds.map((id) => ({ id })),
          remote,
        );
        entry.localFusion = fusedIds;
        entry.overlapFusion5 = f.overlap5;
        entry.overlapFusion10 = f.overlap10;
        entry.mrrFusion = f.mrr;
      }
      const failed = result.status.filter((s) => !s.ok);
      if (failed.length > 0) {
        entry.channelErrors = Object.fromEntries(failed.map((s) => [s.name, s.error ?? "unknown"]));
      }
    } catch (err) {
      entry.channelErrors = { fusion: err instanceof Error ? err.message : String(err) };
    }
  }

  // The shipped default's own pipeline: dense alone, and dense reranked. Recorded
  // separately from fusion so the ladder's stages can be compared on live traffic
  // measured on live traffic, with the frozen gold set as the offline check.
  if (embed) {
    try {
      const denseText = new Map(denseDocs.map((m) => [m.id, m.memory]));
      const denseOnly = await recall({
        query,
        channels: [new EmbedHarnessChannel(embed, denseDocs)],
        perChannelLimit: 50,
        fusedLimit: 10,
      });
      const denseIds = denseOnly.hits.map((h) => h.id);
      if (denseIds.length > 0) {
        const d = compareShadow(
          denseIds.map((id) => ({ id })),
          remote,
        );
        entry.localDense = denseIds;
        entry.overlapDense5 = d.overlap5;
        entry.overlapDense10 = d.overlap10;
        entry.mrrDense = d.mrr;
      }

      if (reranker) {
        const rr = await recall({
          query,
          channels: [new EmbedHarnessChannel(embed, denseDocs)],
          perChannelLimit: 50,
          fusedLimit: 10,
          documentText: (id) => denseText.get(id) ?? "",
          reranker: (q, c, textOf) => reranker(q, c, textOf),
        });
        const rrIds = rr.hits.map((h) => h.id);
        if (rrIds.length > 0) {
          const d = compareShadow(
            rrIds.map((id) => ({ id })),
            remote,
          );
          entry.localDenseRerank = rrIds;
          entry.overlapDenseRerank5 = d.overlap5;
          entry.overlapDenseRerank10 = d.overlap10;
          entry.mrrDenseRerank = d.mrr;
        }
      }
    } catch (err) {
      entry.channelErrors = { ...(entry.channelErrors ?? {}), dense: err instanceof Error ? err.message : String(err) };
    }
  }

  const vecRanked = embed ? await embed.search(query).catch(() => null) : null;
  if (vecRanked) {
    const localVec = vecRanked.slice(0, 10).map(({ m, score }) => ({ id: m.id, score: Number(score.toFixed(4)) }));
    const vec = compareShadow(localVec, remote);
    entry.localVec = localVec;
    entry.overlapVec5 = vec.overlap5;
    entry.overlapVec10 = vec.overlap10;
    entry.mrrVec = vec.mrr;
  }
  log(entry);
}
