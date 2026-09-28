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
        // An unparseable or missing timestamp yields -Infinity so it loses to
        // any real timestamp. `Date.parse(x) || 0` collapsed both sides to 0,
        // which left a live disk record winning over an in-memory tombstone.
        const at = (m: LocalMemory): number => {
          const t = Date.parse(m.updated_at ?? m.created_at ?? "");
          return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
        };
        const mineAt = at(mine);
        const theirsAt = at(theirs);
        // A deletion is a decision someone made, and the live record is the
        // state that decision removed. It wins on any comparison that is not a
        // strictly older timestamp, which covers equal instants, a missing
        // timestamp on either side, and a tombstone written against a record
        // whose timestamp it inherited.
        if (mine.deleted && !theirs.deleted && mineAt >= theirsAt) {
          merged[id] = mine;
          continue;
        }
        if (theirs.deleted && !mine.deleted) continue;
        if (mineAt > theirsAt) {
          merged[id] = mine;
          continue;
        }
        if (mineAt < theirsAt) continue;
        // Equally recent, both live or both tombstoned: prefer a tombstone so
        // the deletion survives, and keep the disk copy otherwise.
        if (mine.deleted) merged[id] = mine;
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
      // The in-memory cache is authoritative. A key absent from it was either
      // never fetched here or deliberately cleared, so it is dropped at the
      // single site that decides. Spreading disk first brought a cleared entry
      // straight back on the next save.
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
