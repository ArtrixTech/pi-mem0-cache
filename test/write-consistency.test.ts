import { describe, expect, it } from "vitest";
import {
  applyRemoteWriteEcho,
  classify,
  createInterceptor,
  createSyncRunner,
  emptyStore,
  type CapturedAuth,
  type LocalMemory,
  type Store,
} from "../src/index.ts";

const AUTH: CapturedAuth = { origin: "https://api.mem0.ai", headers: { authorization: "Token test-key" } };
const MEM_URL = (id: string) => `https://api.mem0.ai/v1/memories/${id}/`;
const DELETE_ALL_URL = "https://api.mem0.ai/v1/memories/?user_id=u1";

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function observed(id: string, memory: string): LocalMemory {
  const now = new Date().toISOString();
  return { id, memory, created_at: now, updated_at: now, source: "observed" };
}

function makeInterceptor(store: Store, fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  return createInterceptor(fetchImpl as typeof fetch, { store, save: () => {}, ttlMs: 60_000 });
}

describe("remote write echo", () => {
  it("remote delete marks the mirrored copy deleted and clears cached reads", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "doomed");
    store.cache["POST /v3/memories/search/ {}"] = { status: 200, body: "{}", savedAt: Date.now() };
    const interceptor = makeInterceptor(store, async () => okJson({ message: "ok" }));

    const res = await interceptor(MEM_URL("x1"), { method: "DELETE" });

    expect(res.ok).toBe(true);
    expect(store.memories.x1.deleted).toBe(true);
    expect(Object.keys(store.cache)).toHaveLength(0);
  });

  it("remote update rewrites mirror text, keeps source, clears cached reads", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "old text");
    store.cache["POST /v3/memories/ {}"] = { status: 200, body: "{}", savedAt: Date.now() };
    const interceptor = makeInterceptor(store, async () => okJson({ id: "x1", memory: "new text" }));

    await interceptor(MEM_URL("x1"), { method: "PUT", body: JSON.stringify({ text: "new text" }) });

    expect(store.memories.x1.memory).toBe("new text");
    expect(store.memories.x1.source).toBe("observed");
    expect(Object.keys(store.cache)).toHaveLength(0);
  });

  it("remote delete-all marks every mirrored memory deleted", async () => {
    const store = emptyStore();
    store.memories.a = observed("a", "one");
    store.memories.b = observed("b", "two");
    const interceptor = makeInterceptor(store, async () => okJson({ message: "ok" }));

    await interceptor(DELETE_ALL_URL, { method: "DELETE" });

    expect(Object.values(store.memories).every((m) => m.deleted)).toBe(true);
  });

  it("local fallback writes clear cached reads too", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "doomed");
    store.cache["POST /v3/memories/search/ {}"] = { status: 200, body: "{}", savedAt: Date.now() };
    const interceptor = makeInterceptor(store, async () => okJson({ error: "quota" }, 429));

    await interceptor(MEM_URL("x1"), { method: "DELETE" });

    expect(store.memories.x1.deleted).toBe(true);
    expect(Object.keys(store.cache)).toHaveLength(0);
  });

  it("a confirmed remote write supersedes queued ops for the same target", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "stale");
    store.ops.push({ kind: "write-update", memoryId: "x1", bodyText: '{"text":"offline edit"}', at: Date.now() });
    store.ops.push({ kind: "write-update", memoryId: "y2", bodyText: '{"text":"other"}', at: Date.now() });
    const interceptor = makeInterceptor(store, async () => okJson({}));

    await interceptor(MEM_URL("x1"), { method: "PUT", body: JSON.stringify({ text: "online edit" }) });

    expect(store.ops).toHaveLength(1);
    expect(store.ops[0].memoryId).toBe("y2");
  });

  it("a confirmed remote delete-all supersedes every queued op", async () => {
    const store = emptyStore();
    store.ops.push({ kind: "write-delete", memoryId: "x1", at: Date.now() });
    store.ops.push({ kind: "write-update", memoryId: "y2", bodyText: "{}", at: Date.now() });
    const interceptor = makeInterceptor(store, async () => okJson({}));

    await interceptor(DELETE_ALL_URL, { method: "DELETE" });

    expect(store.ops).toHaveLength(0);
  });
});

describe("applyRemoteWriteEcho", () => {
  it("creates an observed entry for an update to an unmirrored id", () => {
    const store = emptyStore();
    const req = classify(MEM_URL("new9"), { method: "PUT", body: JSON.stringify({ text: "fresh" }) });
    applyRemoteWriteEcho(store, req!);
    expect(store.memories.new9).toMatchObject({ memory: "fresh", source: "observed" });
  });
});

describe("offline write op-log", () => {
  it("offline update/delete/delete-all on cloud ids queue ops; local-id writes do not", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "text");
    const interceptor = makeInterceptor(store, async () => okJson({ error: "quota" }, 429));

    await interceptor(MEM_URL("x1"), { method: "PUT", body: JSON.stringify({ text: "offline" }) });
    await interceptor(MEM_URL("local-abc"), { method: "PUT", body: JSON.stringify({ text: "folded" }) });
    await interceptor(MEM_URL("local-abc"), { method: "DELETE" });
    await interceptor(MEM_URL("z9"), { method: "DELETE" });
    await interceptor(DELETE_ALL_URL, { method: "DELETE" });

    expect(store.ops.map((o) => [o.kind, o.memoryId])).toEqual([
      ["write-update", "x1"],
      ["write-delete", "z9"],
      ["write-delete-all", undefined],
    ]);
    expect(store.ops[2].query).toBe("?user_id=u1");
  });

  it("offline update keeps an observed memory observed — it must not replay as an add", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "text");
    const interceptor = makeInterceptor(store, async () => okJson({ error: "quota" }, 429));
    await interceptor(MEM_URL("x1"), { method: "PUT", body: JSON.stringify({ text: "offline" }) });

    const calls: string[] = [];
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return okJson({});
      }) as typeof fetch,
      getAuth: () => AUTH,
    });
    const r = await syncer.sync();

    expect(calls).toEqual(["PUT https://api.mem0.ai/v1/memories/x1/"]);
    expect(r).toMatchObject({ uploaded: 0, appliedOps: 1 });
  });
});

describe("sync op replay", () => {
  it("replays delete via DELETE, purges the tombstone, removes the op", async () => {
    const store = emptyStore();
    store.memories.x1 = { ...observed("x1", "doomed"), deleted: true };
    store.ops.push({ kind: "write-delete", memoryId: "x1", at: Date.now() });
    const calls: string[] = [];
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return okJson({});
      }) as typeof fetch,
      getAuth: () => AUTH,
    });

    const r = await syncer.sync();

    expect(calls).toEqual(["DELETE https://api.mem0.ai/v1/memories/x1/"]);
    expect(store.memories.x1).toBeUndefined();
    expect(store.ops).toHaveLength(0);
    expect(r).toMatchObject({ uploaded: 0, appliedOps: 1, failed: 0 });
  });

  it("treats 404 on delete/update replay as applied", async () => {
    const store = emptyStore();
    store.memories.x1 = observed("x1", "gone-server-side");
    store.ops.push({ kind: "write-update", memoryId: "x1", bodyText: '{"text":"t"}', at: Date.now() });
    store.ops.push({ kind: "write-delete", memoryId: "y2", at: Date.now() });
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => okJson({ error: "not found" }, 404)) as typeof fetch,
      getAuth: () => AUTH,
    });

    const r = await syncer.sync();

    expect(r.failed).toBe(0);
    expect(store.ops).toHaveLength(0);
    expect(store.memories.x1).toBeUndefined(); // server-gone: mirror converges
  });

  it("replays delete-all with the original query string and purges all tombstones", async () => {
    const store = emptyStore();
    store.memories.a = { ...observed("a", "1"), deleted: true };
    store.memories.b = { ...observed("b", "2"), deleted: true };
    store.ops.push({ kind: "write-delete-all", query: "?user_id=u1", at: Date.now() });
    const calls: string[] = [];
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return okJson({});
      }) as typeof fetch,
      getAuth: () => AUTH,
    });

    await syncer.sync();

    expect(calls).toEqual(["DELETE https://api.mem0.ai/v1/memories/?user_id=u1"]);
    expect(Object.keys(store.memories)).toHaveLength(0);
  });

  it("replays adds and ops in chronological order (delete-all before a later add)", async () => {
    const store = emptyStore();
    const t1 = Date.now() - 1000;
    const t2 = Date.now();
    store.ops.push({ kind: "write-delete-all", query: "", at: t1 });
    store.memories["local-late"] = {
      id: "local-late",
      memory: "created after the wipe",
      created_at: new Date(t2).toISOString(),
      updated_at: new Date(t2).toISOString(),
      source: "local",
      addPayload: { user_id: "u1" },
    };
    const calls: string[] = [];
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return okJson({ results: [] });
      }) as typeof fetch,
      getAuth: () => AUTH,
    });

    await syncer.sync();

    expect(calls).toEqual([
      "DELETE https://api.mem0.ai/v1/memories/",
      "POST https://api.mem0.ai/v3/memories/add/",
    ]);
  });

  it("keeps the op and arms backoff when replay fails", async () => {
    const store = emptyStore();
    store.ops.push({ kind: "write-delete", memoryId: "x1", at: Date.now() });
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => okJson({ error: "quota" }, 429)) as typeof fetch,
      getAuth: () => AUTH,
      backoffMs: 60_000,
    });

    const r1 = await syncer.sync();
    expect(r1.failed).toBe(1);
    expect(store.ops).toHaveLength(1);
    expect(store.syncState.backoffUntil).toBeGreaterThan(Date.now());

    const r2 = await syncer.sync();
    expect(r2.skipped).toBe(true); // backoff gate
  });

  it("maybeSync runs when only ops are pending (no local adds)", async () => {
    const store = emptyStore();
    store.ops.push({ kind: "write-delete", memoryId: "x1", at: Date.now() });
    const calls: string[] = [];
    const syncer = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        calls.push(String(input));
        return okJson({});
      }) as typeof fetch,
      getAuth: () => AUTH,
    });

    const p = syncer.maybeSync();
    expect(p).not.toBeNull();
    await p;
    expect(calls).toHaveLength(1);
    expect(syncer.pendingOps()).toBe(0);
  });
});
