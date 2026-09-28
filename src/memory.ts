/**
 * Mirror maintenance and local keyword search: adding memories to the local
 * corpus, bounding their size, and the lexical ranking used as the availability
 * floor.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_QUARANTINE_PATH, MAX_FALLBACK_RESULTS, MAX_MEMORY_CHARS } from "./types.js";
import type { LocalMemory, MemoryOverflow, Store } from "./types.js";

/** Slice at the cap without leaving a lone surrogate half at the boundary. */
function truncateSafe(text: string, cap: number): string {
  const sliced = text.slice(0, cap);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Enforce the memory size bound, reporting what was cut.
 *
 * Applied on both entry points: harvesting a response and applying a local write.
 * One path without it was enough for a 250,819-character memory to enter the
 * corpus, where it failed every upload (mem0 answered HTTP 400) and every
 * embedding request, blocking the dense channel until it was found.
 *
 * The cut text goes to the quarantine sidecar, so nothing is silently destroyed.
 */
export function clampMemory(text: string, id: string): { text: string; overflow?: MemoryOverflow } {
  if (text.length <= MAX_MEMORY_CHARS) return { text };
  // The sidecar records what was cut, once per record: `loadStore` re-runs this
  // on every load, and an unconditional append grew it by a copy of the same
  // original each time a session started.
  appendQuarantine({ id, chars: text.length, memory: text });
  return { text: truncateSafe(text, MAX_MEMORY_CHARS), overflow: { originalChars: text.length, truncatedAt: MAX_MEMORY_CHARS } };
}

/** Append the full original text of a truncated memory to the quarantine
 *  sidecar, so nothing the guard dropped becomes unrecoverable. */
function appendQuarantine(entry: { id: string; chars: number; memory: string }): void {
  const path = process.env.MEM0_HARVEST_QUARANTINE_PATH ?? DEFAULT_QUARANTINE_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // One entry per id. A repeat is the same original text rather than new
    // information, and appending it again on every load would grow the file
    // without bound. The scan is over a small file and runs only when a memory
    // actually exceeds the cap.
    if (existsSync(path)) {
      const marker = `"id":${JSON.stringify(entry.id)},`;
      const seen = readFileSync(path, "utf8").includes(marker);
      if (seen) return;
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.warn("[pi-mem0-cache] failed to append quarantine entry:", err);
  }
}

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
    const clamped = clampMemory(m.memory, m.id);
    store.memories[m.id] = {
      ...m,
      id: m.id,
      memory: clamped.text,
      created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
      updated_at: typeof m.updated_at === "string" ? m.updated_at : new Date().toISOString(),
      deleted: false,
      source: "observed",
      ...(clamped.overflow ? { overflow: clamped.overflow } : {}),
    } as LocalMemory;
    if (clamped.overflow) store.stats.harvestDropped = (store.stats.harvestDropped ?? 0) + 1;
  }
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[一-鿿＀-￯]/g) ?? [];
}

export function searchLocalScored(
  store: Store,
  query: string,
  limit = MAX_FALLBACK_RESULTS,
): { m: LocalMemory; score: number }[] {
  const tokens = tokenize(query);
  const all = Object.values(store.memories).filter((m) => !m.deleted);
  if (tokens.length === 0) return all.slice(0, limit).map((m) => ({ m, score: 0 }));
  const scored = all
    .map((m) => {
      const text = m.memory.toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function searchLocal(store: Store, query: string, limit = MAX_FALLBACK_RESULTS): LocalMemory[] {
  return searchLocalScored(store, query, limit).map((s) => s.m);
}
