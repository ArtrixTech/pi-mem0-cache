import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocalWrite,
  createSyncRunner,
  emptyStore,
  loadStore,
  makeSaver,
  MAX_MEMORY_CHARS,
} from "../src/index.js";
import type { ClassifiedRequest, LocalMemory, Store } from "../src/index.js";

const record = (id: string, text: string, extra: Partial<LocalMemory> = {}): LocalMemory =>
  ({
    id,
    memory: text,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    source: "observed",
    ...extra,
  }) as LocalMemory;

const auth = { origin: "https://api.mem0.ai", headers: { authorization: "Token t" } };

function onFile(initial: Record<string, LocalMemory>) {
  const dir = mkdtempSync(join(tmpdir(), "mem0-rev-"));
  const path = join(dir, "store.json");
  writeFileSync(path, JSON.stringify({ ...emptyStore(), memories: initial }));
  return {
    path,
    read: (): Store => JSON.parse(readFileSync(path, "utf8")) as Store,
    save: (store: Store) => {
      const saver = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
      saver();
      saver.flushNow();
    },
  };
}

describe("review finding 1: an intentional wipe reaches the disk copy", () => {
  it("does not restore memories cleared in this session", () => {
    // /mem0-cache clear-all sets `store.memories = {}` and saves. The merge based
    // its result on the disk map and only overlaid the in-memory one, so an empty
    // in-memory map restored everything the wipe had removed.
    const { path, read, save } = onFile({ a: record("a", "one"), b: record("b", "two") });
    const store = loadStore(path);
    store.memories = {};
    store.wipedAt = Date.now(); // what /mem0-cache clear-all records
    save(store);
    expect(Object.keys(read().memories)).toEqual([]);
  });

  it("keeps the corpus when the map is merely empty, with no wipe recorded", () => {
    // An empty in-memory map without the marker is a session that has not
    // loaded anything yet. Its save must leave the disk corpus alone.
    const { path, read, save } = onFile({ a: record("a", "one") });
    const store = loadStore(path);
    store.memories = {};
    save(store);
    expect(Object.keys(read().memories)).toEqual(["a"]);
  });

  it("clears the whole corpus on an explicit wipe, including another session's writes", () => {
    // The wipe marker must not swallow a genuine concurrent write from elsewhere.
    const { path, read, save } = onFile({ a: record("a", "one") });
    const wiping = loadStore(path);
    const other = loadStore(path);
    other.memories.b = record("b", "added elsewhere", { updated_at: "2026-09-05T00:00:00.000Z" });
    save(other);

    wiping.memories = {}; // this session was asked to clear what it knew about
    wiping.wipedAt = Date.now();
    save(wiping);
    expect(Object.keys(read().memories)).toEqual([]);
  });
});

describe("review finding 2: a clamped record persists", () => {
  it("writes the clamped text back so the next load need not re-clamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem0-rev-"));
    const path = join(dir, "store.json");
    const seeded = { ...emptyStore(), memories: { big: record("big", "z".repeat(MAX_MEMORY_CHARS * 3)) } };
    writeFileSync(path, JSON.stringify(seeded));

    const store = loadStore(path);
    expect(store.memories.big.memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);

    const saver = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saver();
    saver.flushNow();

    // The merge previously took the disk copy because the timestamps tied, so
    // the oversized text came back on the next load and was clamped again.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.memories.big.memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    const reloaded = loadStore(path);
    expect(reloaded.memories.big.memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
  });

  it("does not append a second sidecar entry for the same record", () => {
    const qpath = join(mkdtempSync(join(tmpdir(), "mem0-revq-")), "q.jsonl");
    const previous = process.env.MEM0_HARVEST_QUARANTINE_PATH;
    process.env.MEM0_HARVEST_QUARANTINE_PATH = qpath;
    try {
      const dir = mkdtempSync(join(tmpdir(), "mem0-rev-"));
      const path = join(dir, "store.json");
      writeFileSync(path, JSON.stringify({ ...emptyStore(), memories: { big: record("big", "z".repeat(MAX_MEMORY_CHARS * 3)) } }));
      const lines = () => (existsSync(qpath) ? readFileSync(qpath, "utf8").split("\n").filter(Boolean).length : 0);
      const store = loadStore(path);
      const saver = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
      saver();
      saver.flushNow();
      loadStore(path);
      loadStore(path);
      expect(lines()).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.MEM0_HARVEST_QUARANTINE_PATH;
      else process.env.MEM0_HARVEST_QUARANTINE_PATH = previous;
    }
  });
});

describe("review finding 3: a permanently failing op leaves the queue", () => {
  it("stops replaying a queued op after three permanent failures", async () => {
    // quarantine() recorded the id in syncState.quarantined, which only the ADDS
    // list consults. store.ops was never filtered, so the op replayed on every
    // run and the counter reset each time it was retired.
    const store = emptyStore();
    store.ops.push({ kind: "write-delete-all", query: "?user_id=x", at: 1000 });
    let calls = 0;
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("bad", { status: 422 });
      }) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 0,
    });

    await runner.sync(true);
    await runner.sync(true);
    const third = await runner.sync(true);
    expect(third.quarantined.length).toBe(1);
    expect(store.ops).toHaveLength(0);
    expect(calls).toBe(3);

    // Retired: no further request.
    await runner.sync(true);
    expect(calls).toBe(3);
  });
});

describe("review finding 4: the merge preserves the other session's state", () => {
  it("keeps a quarantine recorded by another session", () => {
    const { path, read, save } = onFile({ a: record("a", "one") });
    const a = loadStore(path);
    const b = loadStore(path); // loaded earlier, knows nothing of the quarantine
    a.syncState.quarantined = { poisoned: { reason: "3 permanent failures", at: 1 } };
    a.syncState.failures = { poisoned: 3 };
    save(a);
    save(b);
    const disk = read();
    expect(Object.keys(disk.syncState.quarantined ?? {})).toEqual(["poisoned"]);
    expect(disk.syncState.failures?.poisoned).toBe(3);
  });

  it("keeps the newer backoff and the larger counters", () => {
    const { path, read, save } = onFile({ a: record("a", "one") });
    const a = loadStore(path);
    const b = loadStore(path);
    a.syncState.backoffUntil = Date.now() + 3_600_000;
    a.syncState.lastResult = "uploaded 1, failed 0, pending 0";
    a.stats.misses = 42;
    save(a);
    save(b);
    const disk = read();
    expect(disk.syncState.backoffUntil).toBeGreaterThan(Date.now());
    expect(disk.stats.misses).toBe(42);
  });

  it("keeps a reads-blocked window set by another session", () => {
    const { path, read, save } = onFile({ a: record("a", "one") });
    const a = loadStore(path);
    const b = loadStore(path);
    a.netState.readsBlockedUntil = Date.now() + 120_000;
    save(a);
    save(b);
    expect(read().netState.readsBlockedUntil).toBeGreaterThan(Date.now());
  });
});

describe("review finding 5: auth and endpoint failures are not permanent", () => {
  it("does not retire a memory on repeated 401", async () => {
    // Three sync runs against a rotated token would retire every pending memory.
    const store = emptyStore();
    store.memories.keep = record("keep", "a real memory", { source: "local", updated_at: undefined });
    let calls = 0;
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("unauthorized", { status: 401 });
      }) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 0,
    });
    for (let i = 0; i < 4; i++) await runner.sync(true);
    expect(store.syncState.quarantined?.keep).toBeUndefined();
    expect(store.memories.keep.source).toBe("local");
    expect(calls).toBe(4); // still attempted, never retired
  });

  it("does not retire a memory on repeated 404 from the add endpoint", async () => {
    const store = emptyStore();
    store.memories.keep = record("keep", "a real memory", { source: "local", updated_at: undefined });
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 0,
    });
    for (let i = 0; i < 4; i++) await runner.sync(true);
    expect(store.syncState.quarantined?.keep).toBeUndefined();
  });

  it("still retires a payload the server rejects on its merits", async () => {
    const store = emptyStore();
    store.memories.bad = record("bad", "rejected content", { source: "local", updated_at: undefined });
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => new Response("invalid", { status: 422 })) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 0,
    });
    await runner.sync(true);
    await runner.sync(true);
    await runner.sync(true);
    expect(store.syncState.quarantined?.bad).toBeDefined();
  });
});

describe("review finding 9: a wildcard scope never reaches the payload", () => {
  it("drops app_id=* rather than storing a memory under it", () => {
    // mem0 stores a "*"-valued write so that no later read can reach it, the
    // asymmetry behind mem0ai/mem0#6168. The read path drops the wildcard; the
    // write path was passing it through.
    const store = emptyStore();
    const search = "?user_id=artrix&app_id=*";
    const req: ClassifiedRequest = {
      url: new URL(`https://api.mem0.ai/v3/memories/add/${search}`),
      method: "POST",
      bodyText: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      search,
      kind: "write-add",
    };
    applyLocalWrite(store, req);
    const [m] = Object.values(store.memories);
    const payload = (m.addPayload ?? {}) as Record<string, unknown>;
    expect(payload.app_id).toBeUndefined();
    expect(payload.user_id).toBe("artrix");
  });
});
