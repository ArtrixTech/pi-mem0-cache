import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, loadStore, makeSaver, MAX_MEMORY_CHARS } from "../src/index.js";
import type { LocalMemory, Store } from "../src/index.js";

function record(id: string, text: string, extra: Partial<LocalMemory> = {}): LocalMemory {
  return {
    id,
    memory: text,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    source: "observed",
    ...extra,
  } as LocalMemory;
}

/** A store file plus two savers, mimicking two sessions on one file. */
function pair(initial: Record<string, LocalMemory>) {
  const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
  const path = join(dir, "store.json");
  writeFileSync(path, JSON.stringify({ ...emptyStore(), memories: initial }));
  const saverFor = (store: Store) => {
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    return save;
  };
  return { path, saverFor, read: () => JSON.parse(readFileSync(path, "utf8")) as Store };
}

describe("merge safety: tombstones", () => {
  it("keeps a tombstone when timestamps match and the disk side is the tombstone", () => {
    // Both sides carry the same timestamp, the disk side has the deletion. The
    // old rule only preferred a tombstone when the IN-MEMORY side held it, so a
    // session that had loaded the live record undid the deletion.
    const { path, saverFor, read } = pair({ r: record("r", "live") });
    const stale = loadStore(path);
    const deleter = loadStore(path);
    deleter.memories.r.deleted = true;
    const sd = saverFor(deleter);
    sd();
    sd.flushNow();

    const ss = saverFor(stale);
    ss();
    ss.flushNow();
    expect(read().memories.r.deleted).toBe(true);
  });

  it("keeps a delete made in a newer session", () => {
    const { path, saverFor, read } = pair({ r: record("r", "live") });
    const stale = loadStore(path);
    const deleter = loadStore(path);
    deleter.memories.r = { ...deleter.memories.r, deleted: true, updated_at: "2026-09-02T00:00:00.000Z" } as LocalMemory;
    const sd = saverFor(deleter);
    sd();
    sd.flushNow();

    const ss = saverFor(stale);
    ss();
    ss.flushNow();
    expect(read().memories.r.deleted).toBe(true);
  });

  it("stacks a deletion on the record's own timestamp, so the tie is a tie", () => {
    // What the delete path actually does: it flips the flag and leaves the
    // timestamps alone. That is precisely why the tombstone has to win a tie,
    // and it is the case that produced the live regression.
    const { path, saverFor, read } = pair({ r: record("r", "live") });
    const store = loadStore(path);
    const before = store.memories.r.updated_at;
    store.memories.r.deleted = true;
    expect(store.memories.r.updated_at).toBe(before);
    const sv = saverFor(store);
    sv();
    sv.flushNow();
    expect(read().memories.r.deleted).toBe(true);
  });

  it("carries a tombstone forward across sessions", () => {
    const { path, saverFor, read } = pair({ r: record("r", "live") });
    const a = loadStore(path);
    a.memories.r = { ...a.memories.r, deleted: true, updated_at: "2026-09-03T00:00:00.000Z" } as LocalMemory;
    const sa = saverFor(a);
    sa();
    sa.flushNow();

    const b = loadStore(path);
    const sb = saverFor(b);
    sb();
    sb.flushNow();
    expect(read().memories.r.deleted).toBe(true);
  });
});

describe("merge safety: cache", () => {
  it("does not resurrect a cache entry deleted in memory", () => {
    // The merge was { ...disk.cache, ...store.cache }, so the disk side always
    // contributed. A session that cleared its cache wrote the old entries back.
    const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
    const path = join(dir, "store.json");
    const seeded = { ...emptyStore(), cache: { "GET /x": { status: 200, body: "{}", savedAt: 1 } } };
    writeFileSync(path, JSON.stringify(seeded));

    const store = loadStore(path);
    store.cache = {}; // cleared in memory
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    save();
    save.flushNow();

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(Object.keys(onDisk.cache)).toEqual([]);
  });
});

describe("merge safety: quarantine sidecar", () => {
  it("does not re-append the same oversized memory on every load", () => {
    const qpath = join(mkdtempSync(join(tmpdir(), "mem0-quar-")), "quarantine.jsonl");
    const previous = process.env.MEM0_HARVEST_QUARANTINE_PATH;
    process.env.MEM0_HARVEST_QUARANTINE_PATH = qpath;
    try {
      const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
      const path = join(dir, "store.json");
      writeFileSync(
        path,
        JSON.stringify({ ...emptyStore(), memories: { big: record("big", "z".repeat(MAX_MEMORY_CHARS * 3)) } }),
      );
      const save = makeSaver(loadStore(path), path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
      save();
      save.flushNow();

      const lines = () => (existsSync(qpath) ? readFileSync(qpath, "utf8").split("\n").filter(Boolean).length : 0);
      const first = lines();
      expect(first).toBe(1);
      // Loading the already-clamped file again must not append a second copy.
      loadStore(path);
      loadStore(path);
      expect(lines()).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.MEM0_HARVEST_QUARANTINE_PATH;
      else process.env.MEM0_HARVEST_QUARANTINE_PATH = previous;
    }
  });
});
