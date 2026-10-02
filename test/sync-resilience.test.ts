import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncRunner, emptyStore, loadStore, makeSaver, reconcileOps, MAX_MEMORY_CHARS } from "../src/index.ts";
import type { CapturedAuth, ClassifiedRequest, LocalMemory, Store } from "../src/index.ts";

const auth: CapturedAuth = {
  origin: "https://api.mem0.ai",
  headers: { authorization: "Token test" },
};

function mem(id: string, text: string, createdAt: string): LocalMemory {
  return {
    id,
    memory: text,
    created_at: createdAt,
    updated_at: createdAt,
    user_id: "u",
    app_id: "a",
    source: "local",
    addPayload: { user_id: "u", app_id: "a" },
  };
}

function storeWith(...memories: LocalMemory[]): Store {
  const s = emptyStore();
  for (const m of memories) s.memories[m.id] = m;
  return s;
}

/** Rejects an oversized add the way the live API does: HTTP 400 when the
 *  payload exceeds what the server accepts. An add payload carries the memory
 *  text and no id, so size is the signal the server acts on. */
function fetcherRejectingOversized(log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? String(init.body) : "";
    const isRejected = body.length > MAX_MEMORY_CHARS * 2;
    log.push(`${init?.method ?? "GET"} ${String(input)}${isRejected ? " -> 400" : " -> 200"}`);
    if (isRejected) return new Response("bad request", { status: 400 });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
}

describe("sync queue resilience", () => {
  it("syncs the items behind a permanently-failing one", async () => {
    // The live failure this pins: the 250,819-char memory sorted first in the
    // chronological queue, every replay of it returned 400, and the loop broke
    // on the first failure — so four ordinary memories behind it never synced,
    // across sessions, for over a week.
    const poison = mem("local-poison", "x".repeat(MAX_MEMORY_CHARS * 3), "2026-09-19T09:19:53.861Z");
    const good1 = mem("local-good-1", "ordinary note one", "2026-09-20T08:05:33.378Z");
    const good2 = mem("local-good-2", "ordinary note two", "2026-09-27T06:33:39.965Z");
    const store = storeWith(poison, good1, good2);
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: fetcherRejectingOversized(),
      getAuth: () => auth,
    });

    const res = await runner.sync(true);
    expect(res.uploaded).toBe(2);
    expect(store.memories["local-good-1"].source).toBe("observed");
    expect(store.memories["local-good-2"].source).toBe("observed");
  });

  it("quarantines an item after repeated failures and stops retrying it", async () => {
    // Retrying a payload the server rejects with 400 cannot ever succeed, so
    // each attempt is a wasted request. Three attempts is enough to conclude it.
    const poison = mem("local-poison", "y".repeat(MAX_MEMORY_CHARS * 3), "2026-09-19T09:19:53.861Z");
    const store = storeWith(poison, mem("local-ok", "fine", "2026-09-20T00:00:00.000Z"));
    const quarantine: { id: string; reason: string }[] = [];
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: fetcherRejectingOversized(),
      getAuth: () => auth,
      onQuarantine: (id, reason) => quarantine.push({ id, reason }),
      backoffMs: 0,
    });

    await runner.sync(true);
    await runner.sync(true);
    const third = await runner.sync(true);
    expect(quarantine.map((q) => q.id)).toEqual(["local-poison"]);

    // Once quarantined it leaves the queue: it survives in the store as a
    // record, stops counting as pending, and draws no further request.
    const before = third.attempts;
    const fourth = await runner.sync(true);
    expect(fourth.skipped).toBe(true);
    expect(fourth.attempts).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it("keeps a transient failure in the queue and backs off", async () => {
    // A 500 or a dropped connection is the retryable case. Quarantining it
    // would discard a memory the server would accept moments later.
    const store = storeWith(mem("local-flaky", "retry me", "2026-09-20T00:00:00.000Z"));
    let calls = 0;
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("boom", { status: 500 });
      }) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 60_000,
    });

    const res = await runner.sync(true);
    expect(res.failed).toBe(1);
    expect(store.memories["local-flaky"].source).toBe("local");
    expect(store.syncState.backoffUntil).toBeGreaterThan(Date.now());

    // Backoff still holds a non-forced run back.
    const skipped = await runner.sync();
    expect(skipped.skipped).toBe(true);
    expect(calls).toBe(1);
  });

  it("counts a permanent rejection and retires on the third attempt", async () => {
    const store = storeWith(mem("local-404", "gone", "2026-09-20T00:00:00.000Z"));
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => new Response("nope", { status: 422 })) as typeof fetch,
      getAuth: () => auth,
      backoffMs: 0,
    });
    // A permanent status counts toward retirement, and attempts one and two
    // leave the item in place for another try.
    const first = await runner.sync(true);
    expect(first.attempts).toBe(1);
    expect(store.syncState.failures?.["local-404"]).toBe(1);
    await runner.sync(true);
    expect(store.syncState.failures?.["local-404"]).toBe(2);
    const third = await runner.sync(true);
    expect(third.quarantined).toEqual(["local-404"]);
    expect(store.syncState.quarantined?.["local-404"].reason).toContain("422");
    // Retired: gone from pending, and the idle run issues no request.
    const fourth = await runner.sync(true);
    expect(fourth.attempts).toBe(0);
    expect(fourth.pending).toBe(0);
  });
});

describe("loadStore size normalisation", () => {
  it("clamps an oversized memory found on disk", () => {
    // The recurrence this pins: clampMemory guards the harvest and write-add
    // paths, and an oversized record already in the file passed through every
    // load untouched. A stale process holding the old store then saved it back
    // after it had been deleted, which is how it returned a second time.
    const dir = mkdtempSync(join(tmpdir(), "mem0-load-"));
    const path = join(dir, "store.json");
    const oversized = "z".repeat(MAX_MEMORY_CHARS * 5);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        cache: {},
        memories: {
          "local-big": {
            id: "local-big",
            memory: oversized,
            created_at: "2026-09-19T09:19:53.861Z",
            updated_at: "2026-09-19T09:19:53.861Z",
            user_id: "u",
            app_id: "a",
            source: "local",
          },
        },
        ops: [],
        syncState: {},
        netState: {},
        stats: {},
      }),
    );

    const store = loadStore(path);
    const loaded = store.memories["local-big"];
    expect(loaded.memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    expect(store.stats.harvestDropped).toBeGreaterThan(0);
    expect(loaded.overflow?.originalChars).toBe(oversized.length);
  });

  it("leaves a normally-sized memory untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem0-load-"));
    const path = join(dir, "store.json");
    const text = "a normal memory";
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        cache: {},
        memories: {
          "local-ok": {
            id: "local-ok",
            memory: text,
            created_at: "2026-09-20T00:00:00.000Z",
            updated_at: "2026-09-20T00:00:00.000Z",
            user_id: "u",
            app_id: "a",
            source: "local",
          },
        },
        ops: [],
        syncState: {},
        netState: {},
        stats: {},
      }),
    );
    const store = loadStore(path);
    expect(store.memories["local-ok"].memory).toBe(text);
    expect(store.memories["local-ok"].overflow).toBeUndefined();
  });
});

describe("makeSaver durability", () => {
  it("flushes a pending write when the process is about to exit", () => {
    // The loss this pins: the debounce is 300ms, so a process that exited
    // inside that window dropped its write. Observed directly — a save issued
    // and immediately followed by exit never changed the file's mtime.
    const dir = mkdtempSync(join(tmpdir(), "mem0-saver-"));
    const path = join(dir, "store.json");
    const store = emptyStore();
    store.memories["m1"] = mem("m1", "written just before exit", "2026-09-20T00:00:00.000Z");
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };

    save(); // queued, not yet flushed
    save.flushNow();

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.memories["m1"]?.memory).toBe("written just before exit");
  });

  it("does not write when nothing was queued", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem0-saver-"));
    const path = join(dir, "store.json");
    const save = makeSaver(emptyStore(), path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    save.flushNow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("makeSaver cross-process merge", () => {
  it("keeps a deletion made by another process", () => {
    // The recurrence this pins, reproduced on the live store: process A loads
    // the store and holds it, process B deletes a memory and saves, then A saves
    // its stale copy and the deletion is gone.
    const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
    const path = join(dir, "store.json");

    const live = mem("shared", "original text", "2026-09-20T00:00:00.000Z");
    writeFileSync(
      path,
      JSON.stringify({ ...emptyStore(), memories: { shared: live } }),
    );

    // Process A loads, then B deletes and saves with a later timestamp.
    const storeA = loadStore(path);
    const storeB = loadStore(path);
    storeB.memories["shared"] = { ...storeB.memories["shared"], deleted: true, updated_at: "2026-09-21T00:00:00.000Z" };
    const saveB = makeSaver(storeB, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveB();
    saveB.flushNow();

    // A now saves its copy, which still holds the live record.
    const saveA = makeSaver(storeA, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveA();
    saveA.flushNow();

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.memories["shared"].deleted).toBe(true);
  });

  it("keeps a memory added by another process", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
    const path = join(dir, "store.json");
    writeFileSync(path, JSON.stringify({ ...emptyStore(), memories: { a: mem("a", "first", "2026-09-20T00:00:00.000Z") } }));

    const storeA = loadStore(path);
    const storeB = loadStore(path);
    storeB.memories["b"] = mem("b", "added by B", "2026-09-21T00:00:00.000Z");
    const saveB = makeSaver(storeB, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveB();
    saveB.flushNow();

    const saveA = makeSaver(storeA, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveA();
    saveA.flushNow();

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.memories["b"]?.memory).toBe("added by B");
    expect(onDisk.memories["a"]?.memory).toBe("first");
  });

  it("keeps an op queued by another process", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem0-merge-"));
    const path = join(dir, "store.json");
    writeFileSync(path, JSON.stringify(emptyStore()));

    const storeA = loadStore(path);
    const storeB = loadStore(path);
    storeB.ops.push({ kind: "write-delete", memoryId: "x", at: 1000 });
    const saveB = makeSaver(storeB, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveB();
    saveB.flushNow();

    const saveA = makeSaver(storeA, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveA();
    saveA.flushNow();

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.ops.map((o) => o.memoryId)).toEqual(["x"]);
  });

  it("does not resurrect an applied op from a stale disk copy", async () => {
    // Live failure this pins: six write-delete ops replayed in every sync run
    // for days. Each run applied them (a 404 DELETE counts as applied) and
    // removed them from the in-memory queue, but the save merge unions disk
    // ops back in and the disk copy still held them — so the next save
    // resurrected them and the next run replayed them. Every sync result read
    // "ops applied 6" while the queue never shrank.
    const dir = mkdtempSync(join(tmpdir(), "mem0-sync-"));
    const path = join(dir, "store.json");
    const initial = emptyStore();
    initial.ops.push({ kind: "write-delete", memoryId: "gone", at: 1000 });
    writeFileSync(path, JSON.stringify(initial));

    const store = loadStore(path);
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    save();
    save.flushNow();

    const gone404 = (async () => new Response("", { status: 404 })) as typeof fetch;
    const runner = createSyncRunner({ store, save: () => {}, fetchImpl: gone404, getAuth: () => auth });
    const res = await runner.sync(true);
    expect(res.appliedOps).toBe(1);
    expect(store.ops).toHaveLength(0);

    // The disk copy still lists the op; the merge must not pull it back.
    save();
    save.flushNow();
    let onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.ops).toHaveLength(0);
    expect(Object.keys(onDisk.syncState.opsDone ?? {})).toHaveLength(1);

    // A fresh session loads zero ops, and its own save keeps them gone.
    const fresh = loadStore(path);
    expect(fresh.ops).toHaveLength(0);
    const saveFresh = makeSaver(fresh, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    saveFresh();
    saveFresh.flushNow();
    onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.ops).toHaveLength(0);
  });

  it("does not resurrect a retired op from a stale disk copy", async () => {
    // The quarantine path had the same hole: the op left the in-memory queue,
    // and the merge re-admitted it from disk because the retirement record is
    // keyed by item id while the merge checked the op key.
    const dir = mkdtempSync(join(tmpdir(), "mem0-sync-"));
    const path = join(dir, "store.json");
    const initial = emptyStore();
    initial.ops.push({ kind: "write-update", memoryId: "bad", bodyText: "{}", at: 1000 });
    writeFileSync(path, JSON.stringify(initial));

    const store = loadStore(path);
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    save();
    save.flushNow();

    const always400 = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const runner = createSyncRunner({ store, save: () => {}, fetchImpl: always400, getAuth: () => auth, backoffMs: 0 });
    await runner.sync(true);
    await runner.sync(true);
    const third = await runner.sync(true);
    expect(third.quarantined).toHaveLength(1);
    expect(store.ops).toHaveLength(0);

    save();
    save.flushNow();
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Store;
    expect(onDisk.ops).toHaveLength(0);

    const fresh = loadStore(path);
    expect(fresh.ops).toHaveLength(0);
    expect(fresh.syncState.quarantined?.bad).toBeDefined();
  });

  it("does not resurrect an op superseded by a confirmed remote write", () => {
    // Same merge hole, different removal site: a write-delete that succeeded
    // remotely makes a queued delete for the same id redundant, and
    // reconcileOps drops it. Without a tombstone the merge re-admitted it.
    const dir = mkdtempSync(join(tmpdir(), "mem0-sync-"));
    const path = join(dir, "store.json");
    const initial = emptyStore();
    initial.ops.push({ kind: "write-delete", memoryId: "x", at: 1000 });
    writeFileSync(path, JSON.stringify(initial));

    const store = loadStore(path);
    const save = makeSaver(store, path) as ReturnType<typeof makeSaver> & { flushNow: () => void };
    save();
    save.flushNow();

    reconcileOps(store, { kind: "write-delete", memoryId: "x" } as ClassifiedRequest);
    expect(store.ops).toHaveLength(0);
    save();
    save.flushNow();
    expect((JSON.parse(readFileSync(path, "utf8")) as Store).ops).toHaveLength(0);
  });
});
