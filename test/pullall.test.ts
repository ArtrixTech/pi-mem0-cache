import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEmbedHarness,
  createInterceptor,
  emptyStore,
  emptyVectorStore,
  pullAllMemories,
  type CapturedAuth,
  type Embedder,
  type Store,
} from "../src/index.ts";

const GETALL_URL = "https://api.mem0.ai/v3/memories/";

const auth: CapturedAuth = {
  origin: "https://api.mem0.ai",
  headers: { authorization: "Token m0-test" },
};

function mem(id: number): Record<string, unknown> {
  return { id: `m${id}`, memory: `记忆 ${id} 的内容`, created_at: new Date().toISOString() };
}

function pageResponse(ids: number[]): Response {
  return new Response(JSON.stringify({ results: ids.map(mem), count: 4069 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStore(): Store {
  return emptyStore();
}

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-pullall-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("pullAllMemories", () => {
  function mockFetch(pages: Record<number, number[]>, calls: { url: string; body: string; headers: Record<string, string> }[]) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      calls.push({ url, body: String(init?.body ?? "{}"), headers: (init?.headers ?? {}) as Record<string, string> });
      const ids = pages[page];
      if (!ids) return new Response("no such page", { status: 500 });
      return pageResponse(ids);
    }) as typeof fetch;
  }

  it("paginates getAll, harvests every page, and strips app-scoping filters", async () => {
    const store = makeStore();
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = mockFetch({ 1: Array.from({ length: 500 }, (_, i) => i), 2: Array.from({ length: 200 }, (_, i) => 500 + i) }, calls);

    const r = await pullAllMemories({
      store,
      fetchImpl,
      getAuth: () => auth,
      getFilters: () => ({ user_id: "artrix", app_id: "artrix-reach" }),
    });

    expect(r.pages).toBe(2); // second page short (200 < 500) → stop
    expect(r.fetched).toBe(700);
    expect(r.newHarvested).toBe(700);
    expect(r.total).toBe(4069);
    expect(Object.keys(store.memories)).toHaveLength(700);
    expect(calls[0].headers.authorization).toBe("Token m0-test"); // Token scheme, not Bearer
    const body = JSON.parse(calls[0].body) as { filters: Record<string, unknown> };
    expect(body.filters).toEqual({ user_id: "artrix" }); // app_id stripped → all apps
    expect(calls[0].url).toContain("page=1&page_size=500");
  });

  it("throws without auth or filters, and on HTTP errors", async () => {
    const store = makeStore();
    const fetchImpl = mockFetch({ 1: [1] }, []);
    await expect(pullAllMemories({ store, fetchImpl, getAuth: () => undefined, getFilters: () => ({ user_id: "u" }) }))
      .rejects.toThrow("no mem0 auth");
    await expect(pullAllMemories({ store, fetchImpl, getAuth: () => auth, getFilters: () => undefined }))
      .rejects.toThrow("no mem0 filters");
    const broken = (async () => new Response("denied", { status: 403 })) as typeof fetch;
    await expect(pullAllMemories({ store, fetchImpl: broken, getAuth: () => auth, getFilters: () => ({ user_id: "u" }) }))
      .rejects.toThrow("HTTP 403");
  });

  it("re-harvests idempotently (no duplicates)", async () => {
    const store = makeStore();
    const fetchImpl = mockFetch({ 1: [1, 2, 3] }, []);
    const opts = { store, fetchImpl, getAuth: () => auth, getFilters: () => ({ user_id: "artrix" }) };
    await pullAllMemories(opts);
    const r2 = await pullAllMemories(opts);
    expect(Object.keys(store.memories)).toHaveLength(3);
    expect(r2.newHarvested).toBe(0);
  });
});

describe("ensureEmbeddings chunking", () => {
  it("embeds large corpora in multiple calls", async () => {
    const store = makeStore();
    for (let i = 0; i < 600; i++) store.memories[`m${i}`] = { id: `m${i}`, memory: `text ${i}`, created_at: "", updated_at: "", deleted: false, source: "observed" };
    const vecStore = emptyVectorStore();
    const batchSizes: number[] = [];
    const embedder: Embedder = {
      model: "test",
      embed: async (texts) => {
        batchSizes.push(texts.length);
        return texts.map((t) => [1, 0]);
      },
    };
    const harness = createEmbedHarness(store, () => {}, vecStore, embedder);
    await harness.ensure();
    expect(batchSizes).toEqual([256, 256, 88]);
    expect(Object.keys(vecStore.vectors)).toHaveLength(600);
  });
});

describe("interceptor filters capture", () => {
  it("records the latest read filters for pull-all", async () => {
    const store = makeStore();
    const filtersRef: { current?: Record<string, unknown> } = {};
    const interceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url.includes("/v3/memories/search/")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 0, filtersRef });

    await interceptor("https://api.mem0.ai/v3/memories/search/", {
      method: "POST",
      body: JSON.stringify({ query: "q", filters: { user_id: "artrix", app_id: "artrix-reach" } }),
    });
    expect(filtersRef.current).toEqual({ user_id: "artrix", app_id: "artrix-reach" });
  });
});