/**
 * The on-disk store: load with the size bound applied, and persist with a
 * cross-process merge so concurrent sessions do not overwrite each other.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clampMemory } from "./memory.js";
import { reportDiagnostic } from "./diagnostics.js";
import { MAX_MEMORY_CHARS, OPS_DONE_MAX, opKey } from "./types.js";
import type { LocalMemory, NetState, PendingOp, Store, SyncState } from "./types.js";

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
          // The clamped text carries a newer timestamp so it wins the save merge
          // against the oversized disk copy. On a tie the disk side won, wrote
          // the original back, and every later load clamped and re-appended to
          // the quarantine sidecar.
          m.updated_at = new Date().toISOString();
        }
      }
    }
    return store;
  } catch {
    return emptyStore();
  }
}

export function makeSaver(store: Store, path: string): (() => void) & { flushNow: () => void; dispose: () => void } {
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
      // A local wipe is recorded explicitly. Without the marker an empty
      // in-memory map is indistinguishable from a session that never loaded the
      // corpus, and basing the result on the disk map restored everything
      // `/mem0-cache clear-all` had just removed. The marker is consumed here:
      // the written file is the record of the wipe, and a marker left in it
      // would suppress the disk basis for every later save in every session.
      const wiped = store.wipedAt !== undefined;
      const merged: Record<string, LocalMemory> = wiped ? {} : { ...(disk.memories as Record<string, LocalMemory>) };
      delete store.wipedAt;
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
        // A clamped record is a local mutation worth keeping: the disk copy
        // held text past the cap, and letting it win on a timestamp tie wrote
        // the oversized text straight back, so the next load clamped it again.
        if (mine.overflow && !theirs.overflow) {
          merged[id] = mine;
          continue;
        }
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
      // the safe join for an op queued elsewhere. The exception is an op this
      // (or another) session already finished: the disk copy predates its
      // removal, and re-admitting it replayed a completed write on every sync
      // run. opsDone tombstones carry the completion past the merge.
      const diskSync = (disk.syncState ?? {}) as SyncState;
      const doneOps = { ...(diskSync.opsDone ?? {}), ...(store.syncState.opsDone ?? {}) };
      const seen = new Set(store.ops.map(opKey));
      for (const op of (disk.ops ?? []) as PendingOp[]) {
        const key = opKey(op);
        if (seen.has(key) || doneOps[key] !== undefined) continue;
        store.ops.push(op);
        seen.add(key);
      }
      // The in-memory cache is authoritative. A key absent from it was either
      // never fetched here or deliberately cleared, so it is dropped at the
      // single site that decides. Spreading disk first brought a cleared entry
      // straight back on the next save.
      //
      // syncState, netState and stats take the merged view: another session's
      // retirement, breaker window and accumulated counters are state the disk
      // holds, and overwriting them with a stale copy erased them.
      const prior = (disk.syncState ?? {}) as SyncState;
      const mineState = store.syncState;
      const quarantined = { ...(prior.quarantined ?? {}), ...(mineState.quarantined ?? {}) };
      const failures: Record<string, number> = { ...(prior.failures ?? {}) };
      for (const [id, n] of Object.entries(mineState.failures ?? {})) {
        failures[id] = Math.max(n, failures[id] ?? 0);
      }
      // Both sides contribute tombstones; a completion either side recorded
      // suppresses the disk op. Prune the oldest past the cap so the map does
      // not grow without bound.
      const opsDone = { ...(prior.opsDone ?? {}), ...(mineState.opsDone ?? {}) };
      const doneKeys = Object.keys(opsDone);
      if (doneKeys.length > OPS_DONE_MAX) {
        doneKeys.sort((a, b) => (opsDone[a] ?? 0) - (opsDone[b] ?? 0));
        for (const k of doneKeys.slice(0, doneKeys.length - OPS_DONE_MAX)) delete opsDone[k];
      }
      store.syncState = {
        ...prior,
        ...mineState,
        ...(Object.keys(quarantined).length ? { quarantined } : {}),
        ...(Object.keys(failures).length ? { failures } : {}),
        ...(Object.keys(opsDone).length ? { opsDone } : {}),
        backoffUntil: Math.max(prior.backoffUntil ?? 0, mineState.backoffUntil ?? 0),
        lastAttemptAt: Math.max(prior.lastAttemptAt ?? 0, mineState.lastAttemptAt ?? 0),
      };
      const priorNet = (disk.netState ?? {}) as NetState;
      store.netState = {
        ...priorNet,
        ...store.netState,
        readsBlockedUntil: Math.max(priorNet.readsBlockedUntil ?? 0, store.netState.readsBlockedUntil ?? 0),
      };
      const baseStats = disk.stats ?? store.stats;
      const summed: Store["stats"] = { ...store.stats };
      for (const [k, v] of Object.entries(baseStats)) {
        const current = (summed as Record<string, unknown>)[k];
        // Counters only accumulate, so the larger figure is the true one even
        // when this session has seen less traffic than the disk copy. String
        // fields such as the last strategy are left to this session's copy.
        if (typeof v === "number" && typeof current === "number") {
          (summed as Record<string, unknown>)[k] = Math.max(current, v);
        }
      }
      store.stats = summed;
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
      reportDiagnostic("failed to persist store", err);
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
  const dispose = () => {
    flushNow();
    for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
      process.removeListener(signal, flushNow);
    }
  };
  return Object.assign(save, { flushNow, dispose });
}

// ---------------------------------------------------------------------------
// Request classification
