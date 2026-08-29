import { describe, expect, it } from "vitest";
import {
  classify,
  createInterceptor,
  emptyStore,
  harvestMemories,
  searchLocal,
  tokenize,
  type Store,
} from "../src/index.ts";

const SEARCH_URL = "https://api.mem0.ai/v3/memories/search/";
const GETALL_URL = "https://api.mem0.ai/v3/memories/";
const ADD_URL = "https://api.mem0.ai/v3/memories/add/";

function searchRequest(query: string): [string, RequestInit] {
  return [SEARCH_URL, { method: "POST", body: JSON.stringify({ query }) }];
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeStore(): Store {
  return emptyStore();
}

describe("classify", () => {
  it("ignores non-mem0 hosts", () => {
    expect(classify("https://example.com/v3/memories/search/")).toBeNull();
  });

  it("classifies search with query", () => {
    const [url, init] = searchRequest("hello");
    const c = classify(url, init);
    expect(c?.kind).toBe("read-search");
    expect(c?.query).toBe("hello");
  });

  it("classifies getAll, add, update, delete, deleteAll, get, history", () => {
    expect(classify(GETALL_URL, { method: "POST", body: "{}" })?.kind).toBe("read-getall");
    expect(classify(ADD_URL, { method: "POST", body: "{}" })?.kind).toBe("write-add");
    expect(classify("https://api.mem0.ai/v1/memories/abc/", { method: "PUT", body: "{}" })?.kind).toBe("write-update");
    expect(classify("https://api.mem0.ai/v1/memories/abc/", { method: "DELETE" })?.kind).toBe("write-delete");
    expect(classify("https://api.mem0.ai/v1/memories/?user_id=x", { method: "DELETE" })?.kind).toBe("write-delete-all");
    expect(classify("https://api.mem0.ai/v1/memories/abc/", { method: "GET" })?.kind).toBe("read-get");
    expect(classify("https://api.mem0.ai/v1/memories/abc/history/", { method: "GET" })?.kind).toBe("read-history");
    expect(classify("https://api.mem0.ai/v1/ping/", { method: "GET" })?.kind).toBe("read-other");
  });

  it("passes through non-string bodies", () => {
    const stream = new ReadableStream();
    expect(classify(SEARCH_URL, { method: "POST", body: stream })).toBeNull();
  });
});

describe("tokenize / searchLocal", () => {
  it("tokenizes latin and CJK", () => {
    expect(tokenize("Artrix 偏好 dark theme")).toEqual(["artrix", "偏", "好", "dark", "theme"]);
  });

  it("ranks by token overlap and skips deleted", () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.a = { id: "a", memory: "user prefers dark theme", created_at: now, updated_at: now, source: "local" };
    store.memories.b = { id: "b", memory: "user likes light theme", created_at: now, updated_at: now, source: "local" };
    store.memories.c = { id: "c", memory: "unrelated note", created_at: now, updated_at: now, source: "local", deleted: true };
    const results = searchLocal(store, "dark theme preference");
    expect(results.map((r) => r.id)).toContain("a");
    expect(results.map((r) => r.id)).not.toContain("c");
  });
});

describe("harvestMemories", () => {
  it("collects results and never overwrites local writes", () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.x = { id: "x", memory: "local version", created_at: now, updated_at: now, source: "local" };
    harvestMemories(store, JSON.stringify({ results: [{ id: "x", memory: "remote version" }, { id: "y", memory: "new" }] }));
    expect(store.memories.x.memory).toBe("local version");
    expect(store.memories.y.memory).toBe("new");
  });
});

describe("interceptor reads", () => {
  it("miss → passthrough → caches response; second call is a hit", async () => {
    const store = makeStore();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okJson({ results: [{ id: "1", memory: "hello world" }] });
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });

    const [url, init] = searchRequest("hello");
    const r1 = await fetcher(url, init);
    expect(r1.status).toBe(200);
    expect(store.stats.misses).toBe(1);
    expect(calls).toBe(1);

    const r2 = await fetcher(url, init);
    expect(await r2.json()).toEqual({ results: [{ id: "1", memory: "hello world" }] });
    expect(store.stats.hits).toBe(1);
    expect(calls).toBe(1);
    // harvested into local corpus
    expect(store.memories["1"].memory).toBe("hello world");
  });

  it("different queries have different cache entries", async () => {
    const store = makeStore();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okJson({ results: [] });
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    await fetcher(...searchRequest("q1"));
    await fetcher(...searchRequest("q2"));
    expect(calls).toBe(2);
  });

  it("expired entry re-fetches", async () => {
    const store = makeStore();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okJson({ results: [] });
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 0 });
    const [url, init] = searchRequest("q");
    await fetcher(url, init);
    await fetcher(url, init);
    expect(calls).toBe(2);
  });

  it("quota failure with stale cache → serves stale", async () => {
    const store = makeStore();
    const [url, init] = searchRequest("hello");
    store.cache[`POST /v3/memories/search/ ${JSON.stringify({ query: "hello" })}`] = {
      status: 200,
      body: JSON.stringify({ results: [{ id: "9", memory: "stale answer" }] }),
      savedAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    const fetchImpl = (async () => okJson({ error: "Usage quota exceeded" }, 429)) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher(url, init);
    expect(await res.json()).toEqual({ results: [{ id: "9", memory: "stale answer" }] });
    expect(store.stats.staleServed).toBe(1);
  });

  it("quota failure without cache → local search fallback", async () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.m = { id: "m", memory: "user prefers vim keybindings", created_at: now, updated_at: now, source: "local" };
    const fetchImpl = (async () => okJson({ error: "Usage quota exceeded" }, 429)) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher(...searchRequest("vim keybindings"));
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results.map((r) => r.id)).toEqual(["m"]);
    expect(store.stats.fallbacks).toBe(1);
  });

  it("network error on getAll → returns local corpus", async () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.m = { id: "m", memory: "note", created_at: now, updated_at: now, source: "observed" };
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher(GETALL_URL, { method: "POST", body: "{}" });
    const body = (await res.json()) as { results: unknown[]; count: number };
    expect(body.count).toBe(1);
  });
});

describe("interceptor writes", () => {
  it("successful write passes through untouched", async () => {
    const store = makeStore();
    const fetchImpl = (async () => okJson({ message: "ok" })) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher(ADD_URL, { method: "POST", body: JSON.stringify({ messages: [{ content: "fact" }] }) });
    expect(await res.json()).toEqual({ message: "ok" });
    expect(store.stats.localWrites).toBe(0);
  });

  it("failed add lands in local store and is searchable", async () => {
    const store = makeStore();
    const fetchImpl = (async () => okJson({ error: "quota" }, 429)) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher(ADD_URL, { method: "POST", body: JSON.stringify({ messages: [{ content: "user likes tea" }] }) });
    expect(res.status).toBe(200);
    expect(store.stats.localWrites).toBe(1);
    const found = searchLocal(store, "tea");
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe("local");
  });

  it("failed update edits the local copy", async () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.u = { id: "u", memory: "old text", created_at: now, updated_at: now, source: "observed" };
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    const res = await fetcher("https://api.mem0.ai/v1/memories/u/", { method: "PUT", body: JSON.stringify({ text: "new text" }) });
    expect(res.status).toBe(200);
    expect(store.memories.u.memory).toBe("new text");
    expect(store.memories.u.source).toBe("local");
  });

  it("failed delete marks memory deleted", async () => {
    const store = makeStore();
    const now = new Date().toISOString();
    store.memories.d = { id: "d", memory: "bye", created_at: now, updated_at: now, source: "local" };
    const fetchImpl = (async () => okJson({ error: "quota" }, 429)) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    await fetcher("https://api.mem0.ai/v1/memories/d/", { method: "DELETE" });
    expect(store.memories.d.deleted).toBe(true);
    expect(searchLocal(store, "bye")).toHaveLength(0);
  });
});

describe("non-mem0 traffic", () => {
  it("passes through without touching stats", async () => {
    const store = makeStore();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return okJson({});
    }) as typeof fetch;
    const fetcher = createInterceptor(fetchImpl, { store, save: () => {}, ttlMs: 60_000 });
    await fetcher("https://example.com/api");
    expect(calls).toBe(1);
    expect(store.stats.passthroughs).toBe(0);
  });
});
