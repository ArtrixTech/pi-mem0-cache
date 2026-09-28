/**
 * The on-disk store: load with the size bound applied, and persist with a
 * cross-process merge so concurrent sessions do not overwrite each other.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clampMemory } from "./memory.js";
import { MAX_MEMORY_CHARS } from "./types.js";
import type { LocalMemory, PendingOp, Store } from "./types.js";

export function emptyStore(): Store {
  return {
    version: 1,
    cache: {},
    memories: {},
    ops: [],
    syncState: {},
    netState: {},
    stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0, gated: 0, harvestDropped: 0 },
  };
}

export function loadStore(path: string): Store {
  try {
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    const base = emptyStore();
    const store: Store = {
      version: 1,
      cache: parsed.cache ?? {},
      memories: parsed.memories ?? {},
      ops: parsed.ops ?? [],
      syncState: parsed.syncState ?? {},
      netState: parsed.netState ?? {},
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
    };
    // Clamp on the way in. clampMemory guards the two write paths, and a record
    // already sitting in the file passed through every load untouched — so an
    // oversized memory outlived both its deletion from the corpus and the guard
    // that had been added to stop it. Loading is the one point every session
    // passes through.
    for (const m of Object.values(store.memories)) {
      if (typeof m?.memory === "string" && m.memory.length > MAX_MEMORY_CHARS) {
        const clamped = clampMemory(m.memory, m.id);
        m.memory = clamped.text;
        if (clamped.overflow) {
          m.overflow = clamped.overflow;
          store.stats.harvestDropped = (store.stats.harvestDropped ?? 0) + 1;
        }
      }
    }
    return store;
  } catch {
    return emptyStore();
  }
}

export function makeSaver(store: Store, path: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  /** Merge other processes' writes into this one before overwriting the file.
   *
   *  Every pi session loads its own copy of the store and writes the whole file
   *  back, so a long-lived session's stale copy overwrites anything a newer
   *  session wrote. That is not hypothetical: a memory deleted here returned to
   *  the corpus because a session that had loaded it earlier saved afterwards.
   *  Merging by id and timestamp keeps both sides' work on the disk copy.
   */
  const mergeFromDisk = (): Store => {
    try {
      if (!existsSync(path)) return store;
      const disk = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
      if (!disk.memories) return store;
      const merged: Record<string, LocalMemory> = { ...(disk.memories as Record<string, LocalMemory>) };
      for (const [id, mine] of Object.entries(store.memories)) {
        const theirs = merged[id];
        if (!theirs) {
          merged[id] = mine;
          continue;
        }
        const mineAt = Date.parse(mine.updated_at ?? mine.created_at ?? "") || 0;
        const theirsAt = Date.parse(theirs.updated_at ?? theirs.created_at ?? "") || 0;
        // A tombstone and a live record for the same id: the more recent write
        // decides, which is what makes a delete survive a concurrent update.
        if (mineAt > theirsAt) merged[id] = mine;
        else if (mineAt === theirsAt && mine.deleted) merged[id] = mine;
      }
      store.memories = merged;
      // Ops are additive per process and replay is idempotent, so the union is
      // the safe join: an op queued elsewhere still replays, and a replayed op
      // was already removed from its own side.
      const opsKey = (o: PendingOp) => `${o.kind}|${o.memoryId ?? ""}|${o.at}`;
      const seen = new Set(store.ops.map(opsKey));
      for (const op of (disk.ops ?? []) as PendingOp[]) {
        if (!seen.has(opsKey(op))) {
          store.ops.push(op);
          seen.add(opsKey(op));
        }
      }
      store.cache = { ...(disk.cache ?? {}), ...store.cache };
    } catch {
      // A parse failure means another process is mid-write; this save wins.
    }
    return store;
  };
  const flush = () => {
    if (!pending) return;
    pending = false;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const merged = mergeFromDisk();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2));
      renameSync(tmp, path);
    } catch (err) {
      console.warn("[pi-mem0-cache] failed to persist store:", err);
    }
  };
  // Flush synchronously when the process is about to leave. The debounce below
  // is 300ms, and a session that exits inside that window used to lose its last
  // write entirely — which is how a deleted memory returned to the corpus after
  // a stale process saved its in-memory copy back over the deletion.
  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  };
  for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(signal, flushNow);
  }
  const save = () => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (typeof timer.unref === "function") timer.unref();
  };
  return Object.assign(save, { flushNow });
}

// ---------------------------------------------------------------------------
// Request classification
