import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendShadowLog,
  compareShadow,
  createInterceptor,
  emptyStore,
  readShadowEntries,
  searchLocal,
  searchLocalScored,
  summarizeShadow,
  type LocalMemory,
  type ShadowEntry,
  type Store,
} from "../src/index.ts";

const SEARCH_URL = "https://api.mem0.ai/v3/memories/search/";

function searchRequest(query: string): [string, RequestInit] {
  return [SEARCH_URL, { method: "POST", body: JSON.stringify({ query }) }];
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mem(id: string, text: string): LocalMemory {
  const now = new Date().toISOString();
  return { id, memory: text, created_at: now, updated_at: now, deleted: false, source: "observed" };
}

function storeWith(...memories: LocalMemory[]): Store {
  const store = emptyStore();
  for (const m of memories) store.memories[m.id] = m;
  return store;
}

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-shadow-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("compareShadow", () => {
  const ids = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

  it("scores a perfect overlap", () => {
    const { overlap5, overlap10, mrr } = compareShadow(ids(5, "x"), ids(5, "x"));
    expect(overlap5).toBe(5);
    expect(overlap10).toBe(5);
    expect(mrr).toBe(1);
  });

  it("scores a disjoint ranking", () => {
    const { overlap5, overlap10, mrr } = compareShadow(ids(5, "l"), ids(5, "r"));
    expect(overlap5).toBe(0);
    expect(overlap10).toBe(0);
    expect(mrr).toBe(0);
  });

  it("computes partial overlap and MRR", () => {
    const local = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const remote = [{ id: "c" }, { id: "z" }, { id: "f" }, { id: "g" }, { id: "h" }];
    const { overlap5, mrr } = compareShadow(local, remote);
    expect(overlap5).toBe(1);
    expect(mrr).toBeCloseTo(1 / 3); // remote top-1 "c" sits at local rank 3
  });

  it("ignores entries beyond the top-10 window", () => {
    const local = Array.from({ length: 15 }, (_, i) => ({ id: `l${i}` }));
    const remote = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}` }));
    const { overlap10 } = compareShadow(local, remote);
    expect(overlap10).toBe(0);
  });
});

describe("searchLocalScored", () => {
  it("exposes token-overlap scores in rank order", () => {
    const store = storeWith(mem("m1", "truenas zvol snapshot 备份"), mem("m2", "truenas 磁盘占用"), mem("m3", "无关内容"));
    const scored = searchLocalScored(store, "truenas zvol 备份", 10);
    expect(scored[0].m.id).toBe("m1");
    expect(scored[0].score).toBe(4); // truenas + zvol + 备 + 份 (CJK tokenizes per char)
    expect(scored[1].m.id).toBe("m2");
    expect(scored[1].score).toBe(1);
    expect(searchLocal(store, "truenas zvol 备份")).toEqual([store.memories.m1, store.memories.m2]);
  });
});

describe("interceptor shadow logging", () => {
  it("records a remote comparison on a search miss", async () => {
    const store = storeWith(mem("local-a", "veeam 备份警告 检查"), mem("local-b", "磁盘占用分析"));
    const entries: ShadowEntry[] = [];
    const remoteIds = ["remote-1", "remote-2", "local-a"];
    const interceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url === SEARCH_URL) return okJson({ results: remoteIds.map((id) => ({ id, memory: "m", score: 0.9 })) });
      throw new Error(`unexpected url ${url}`);
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 0, shadowLog: (e) => entries.push(e) });

    const res = await interceptor(...searchRequest("veeam 备份 警告"));
    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.mode).toBe("remote");
    expect(entry.query).toBe("veeam 备份 警告");
    expect(entry.remote.map((h) => h.id)).toEqual(remoteIds);
    expect(entry.remote[2].score).toBe(0.9);
    expect(entry.local).toEqual([{ id: "local-a", score: 5 }]); // pre-fetch mirror state
    // mirror only knows local-a: overlap@5 = 1, remote top-1 absent → mrr 0
    expect(entry.overlap5).toBe(1);
    expect(entry.overlap10).toBe(1);
    expect(entry.mrr).toBe(0);
  });

  it("logs a fallback entry when the API fails and the mirror answers", async () => {
    const store = storeWith(mem("local-a", "veeam 备份警告"));
    const entries: ShadowEntry[] = [];
    const interceptor = createInterceptor(async () => {
      throw new Error("down");
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 0, shadowLog: (e) => entries.push(e) });

    const res = await interceptor(...searchRequest("veeam 备份"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results[0].id).toBe("local-a");
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe("fallback");
    expect(entries[0].remote).toEqual([]);
    expect(entries[0].local[0].id).toBe("local-a");
  });

  it("does not log gated reads", async () => {
    const store = storeWith(mem("local-a", "veeam 备份警告"));
    const entries: ShadowEntry[] = [];
    const interceptor = createInterceptor(async () => {
      throw new Error("gated reads must not touch the network");
    }, {
      store,
      save: () => {},
      ttlMs: 24 * 60 * 60 * 1000,
      remoteReadIntervalMs: 60 * 60 * 1000,
      shadowLog: (e) => entries.push(e),
    });
    store.netState.lastRemoteReadAt = Date.now() - 1000; // gate active

    const res = await interceptor(...searchRequest("veeam 备份"));
    expect(res.status).toBe(200);
    expect(entries).toHaveLength(0);
  });

  it("miss path stays intact without shadowLog", async () => {
    const store = storeWith(mem("local-a", "veeam 备份警告"));
    const interceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url === SEARCH_URL) return okJson({ results: [{ id: "remote-1", memory: "m" }] });
      throw new Error(`unexpected url ${url}`);
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 0 });

    const res = await interceptor(...searchRequest("veeam"));
    expect(res.status).toBe(200);
    expect(Object.keys(store.cache)).toHaveLength(1); // response cached as before
    expect(store.stats.misses).toBe(1);
  });
});

describe("shadow log file", () => {
  it("appends and rotates", () => {
    const path = join(tmp, "shadow.jsonl");
    for (let i = 0; i < 5; i++) {
      appendShadowLog(
        path,
        { ts: i, mode: "remote", query: `q${i}`, local: [{ id: "a", score: 1 }], remote: [{ id: "a" }], overlap5: 1, overlap10: 1, mrr: 1 },
        200, // tiny rotate threshold
        3,
      );
    }
    const entries = readShadowEntries(path);
    expect(entries).toHaveLength(3); // rotated down to keepLines
    expect(entries[2].query).toBe("q4");
    expect(summarizeShadow(entries)).toMatchObject({ comparisons: 3, fallbacks: 0, meanMrr: 1 });
  });

  it("tolerates malformed lines and missing files", () => {
    const path = join(tmp, "shadow-bad.jsonl");
    appendShadowLog(path, {
      ts: 1, mode: "remote", query: "q", local: [], remote: [], overlap5: 0, overlap10: 0, mrr: 0,
    });
    writeFileSync(path, "{broken\n");
    expect(readShadowEntries(path)).toEqual([]);
    expect(readShadowEntries(join(tmp, "missing.jsonl"))).toEqual([]);
    expect(summarizeShadow([])).toMatchObject({ comparisons: 0, fallbacks: 0 });
  });
});