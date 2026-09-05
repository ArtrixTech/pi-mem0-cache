import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  cosine,
  createEmbedHarness,
  createInterceptor,
  createJinaEmbedder,
  emptyStore,
  emptyVectorStore,
  ensureEmbeddings,
  loadVectorStore,
  searchLocalVector,
  summarizeShadow,
  type Embedder,
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

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-embed-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("createJinaEmbedder", () => {
  it("posts an OpenAI-compatible request and returns vectors ordered by index", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const embedder = createJinaEmbedder("sk-test", "jina-embeddings-v5-text-nano", async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okJson({
        data: [
          { embedding: [0, 0, 1], index: 1 },
          { embedding: [1, 0, 0], index: 0 },
        ],
      });
    });
    const vecs = await embedder.embed(["a", "b"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.jina.ai/v1/embeddings");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "jina-embeddings-v5-text-nano", input: ["a", "b"] });
    expect(vecs).toEqual([[1, 0, 0], [0, 0, 1]]); // sorted by index, not response order
  });

  it("throws on non-ok responses", async () => {
    const embedder = createJinaEmbedder("sk-test", undefined, async () => okJson({ detail: "no" }, 401));
    await expect(embedder.embed(["x"])).rejects.toThrow("HTTP 401");
  });
});

describe("cosine / searchLocalVector", () => {
  it("scores identical directions 1 and orthogonal 0", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0);
  });

  it("ranks corpus by similarity", () => {
    const store = storeWith(mem("a", "alpha"), mem("b", "beta"), mem("c", "gamma"));
    const vectors = { a: { hash: "h", vec: [1, 0] }, b: { hash: "h", vec: [0.9, 0.1] }, c: { hash: "h", vec: [0, 1] } };
    const ranked = searchLocalVector([1, 0], [store.memories.a, store.memories.b, store.memories.c], vectors, 10);
    expect(ranked[0].m.id).toBe("a");
    expect(ranked[1].m.id).toBe("b");
    expect(ranked).toHaveLength(2); // c filtered out (cosine 0 vs orthogonal query)
  });
});

describe("ensureEmbeddings", () => {
  function countingEmbedder(): { embedder: Embedder; batches: string[][] } {
    const table: Record<string, number[]> = { alpha: [1, 0], beta: [0.9, 0.1], gamma: [0, 1] };
    const batches: string[][] = [];
    const embedder: Embedder = {
      model: "test-model",
      embed: async (texts) => {
        batches.push([...texts]);
        return texts.map((t) => table[t] ?? [0, 0]);
      },
    };
    return { embedder, batches };
  }

  it("embeds incrementally and prunes deleted memories", async () => {
    const { embedder, batches } = countingEmbedder();
    const store = storeWith(mem("a", "alpha"), mem("b", "beta"));
    const vecStore = emptyVectorStore();
    const r1 = await ensureEmbeddings(store, vecStore, embedder);
    expect(r1).toEqual({ embedded: 2, corpus: 2 });
    expect(vecStore.dims).toBe(2);

    // one new memory + one changed text → one batch with exactly those two targets
    store.memories.c = mem("c", "gamma");
    store.memories.b.memory = "beta changed";
    const r2 = await ensureEmbeddings(store, vecStore, embedder);
    expect(r2).toEqual({ embedded: 2, corpus: 3 });
    expect(batches[1]).toEqual(["beta changed", "gamma"]); // targets recorded by text

    // unchanged corpus → no API call
    const r3 = await ensureEmbeddings(store, vecStore, embedder);
    expect(r3).toEqual({ embedded: 0, corpus: 3 });
    expect(batches).toHaveLength(2);

    // deleted memory → vector pruned
    store.memories.a.deleted = true;
    await ensureEmbeddings(store, vecStore, embedder);
    expect(vecStore.vectors.a).toBeUndefined();
  });

  it("wipes vectors on model mismatch", async () => {
    const store = storeWith(mem("a", "alpha"));
    const vecStore = emptyVectorStore();
    const { embedder } = countingEmbedder();
    await ensureEmbeddings(store, vecStore, embedder);
    expect(Object.keys(vecStore.vectors)).toEqual(["a"]);
    const other = countingEmbedder().embedder;
    (other as { model: string }).model = "other-model";
    await ensureEmbeddings(store, vecStore, other);
    expect(vecStore.model).toBe("other-model");
    expect(Object.keys(vecStore.vectors)).toEqual(["a"]); // re-embedded under the new model
  });
});

describe("createEmbedHarness", () => {
  it("ranks by vectors and falls back to null on failure", async () => {
    const store = storeWith(mem("a", "alpha"), mem("b", "beta"));
    const vecStore = emptyVectorStore();
    const save = vi.fn();
    let fail = false;
    const embedder: Embedder = {
      model: "test-model",
      embed: async (texts) => {
        if (fail) throw new Error("jina down");
        return texts.map((t) => (t === "alpha query" ? [0.95, 0.05] : t === "alpha" ? [1, 0] : [0.9, 0.1]));
      },
    };
    const harness = createEmbedHarness(store, save, vecStore, embedder);

    const ranked = await harness.search("alpha query");
    expect(ranked?.map((s) => s.m.id)).toEqual(["a", "b"]);
    expect(save).toHaveBeenCalled(); // corpus was embedded and persisted

    fail = true;
    expect(await harness.search("alpha query")).toBeNull(); // cooldown + null
    const s = harness.status();
    expect(s.lastError).toContain("jina down");
    expect(s.cooldownUntil).toBeDefined();
  });
});

describe("interceptor with embed harness", () => {
  function tableEmbedder(): Embedder {
    const table: Record<string, number[]> = {
      "veeam 查询": [0.95, 0.05],
      "veeam 备份": [1, 0],
      "veeam 警告": [0.4, 0.9],
    };
    return { model: "test-model", embed: async (texts) => texts.map((t) => table[t] ?? [0, 0]) };
  }

  it("serves gated reads with the vector ranking and logs both sides on miss", async () => {
    // keyword ranking for "veeam 查询" puts kw-first first (both memories score 1,
    // insertion order); the vector ranking reverses that — proving the override works.
    const store = storeWith(mem("kw-first", "veeam 警告"), mem("vec-first", "veeam 备份"));
    const vecStore = emptyVectorStore();
    const embed = createEmbedHarness(store, () => {}, vecStore, tableEmbedder());

    // --- gated read: vector ranking wins over keyword ranking ---
    const gatedInterceptor = createInterceptor(async () => {
      throw new Error("gated reads must not touch the network");
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 60 * 60 * 1000, embed });
    store.netState.lastRemoteReadAt = Date.now() - 1000;
    const gated = await gatedInterceptor(...searchRequest("veeam 查询"));
    const gatedBody = (await gated.json()) as { results: { id: string }[] };
    expect(gatedBody.results[0].id).toBe("vec-first");

    // --- miss path: shadow entry carries keyword + vector sides ---
    const entries: ShadowEntry[] = [];
    const missInterceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url === SEARCH_URL) {
        return okJson({ results: [{ id: "remote-1", memory: "m", score: 0.8 }, { id: "vec-first", memory: "m" }] });
      }
      throw new Error(`unexpected ${url}`);
    }, {
      store,
      save: () => {},
      ttlMs: 0,
      remoteReadIntervalMs: 0,
      embed,
      shadowLog: (e) => entries.push(e),
    });
    await missInterceptor(...searchRequest("veeam 查询"));
    expect(entries).toHaveLength(1);
    expect(entries[0].localVec?.map((h) => h.id)).toEqual(["vec-first", "kw-first"]);
    expect(entries[0].overlapVec5).toBe(1); // vec-first is in both top-5s
    expect(entries[0].mrrVec).toBe(0); // remote top-1 remote-1 is absent from the vector list
  });

  it("re-embeds automatically after every successful passthrough (add)", async () => {
    const store = emptyStore();
    const vecStore = emptyVectorStore();
    const embed = createEmbedHarness(store, () => {}, vecStore, {
      model: "t",
      embed: async (texts) => texts.map(() => [1, 0]),
    });
    const interceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url.includes("/v3/memories/add/")) {
        return okJson({ results: [{ id: "new-1", memory: "新记忆 内容" }] });
      }
      throw new Error(`unexpected ${url}`);
    }, { store, save: () => {}, ttlMs: 0, remoteReadIntervalMs: 0, embed, onPassthroughSuccess: () => void embed.ensure() });

    await interceptor("https://api.mem0.ai/v3/memories/add/", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    });
    await new Promise((r) => setTimeout(r, 20)); // let the void'd ensure settle
    expect(vecStore.vectors["new-1"]).toBeDefined(); // ensure fired on passthrough success
  });

  it("degrades to keyword-only shadow fields when the harness fails", async () => {
    const store = storeWith(mem("a", "veeam 备份"));
    const vecStore = emptyVectorStore();
    const failing: Embedder = { model: "test-model", embed: async () => { throw new Error("down"); } };
    const entries: ShadowEntry[] = [];
    const interceptor = createInterceptor(async (input) => {
      const url = String(input);
      if (url === SEARCH_URL) return okJson({ results: [{ id: "remote-1", memory: "m" }] });
      throw new Error(`unexpected ${url}`);
    }, {
      store,
      save: () => {},
      ttlMs: 0,
      remoteReadIntervalMs: 0,
      embed: createEmbedHarness(store, () => {}, vecStore, failing),
      shadowLog: (e) => entries.push(e),
    });
    await interceptor(...searchRequest("veeam"));
    expect(entries).toHaveLength(1);
    expect(entries[0].localVec).toBeUndefined();
    expect(entries[0].overlap5).toBeDefined();
  });
});

describe("summarizeShadow with vector side", () => {
  it("aggregates keyword and vector metrics separately", () => {
    const entries: ShadowEntry[] = [
      { ts: 1, mode: "remote", query: "q", local: [{ id: "a", score: 1 }], remote: [{ id: "a" }], overlap5: 1, overlap10: 1, mrr: 1, localVec: [{ id: "a", score: 0.9 }], overlapVec5: 1, overlapVec10: 1, mrrVec: 1 },
      { ts: 2, mode: "remote", query: "q2", local: [], remote: [{ id: "z" }], overlap5: 0, overlap10: 0, mrr: 0 },
      { ts: 3, mode: "fallback", query: "q3", local: [{ id: "b", score: 1 }], remote: [], overlap5: 0, overlap10: 0, mrr: 0 },
    ];
    const s = summarizeShadow(entries);
    expect(s).toMatchObject({
      comparisons: 2,
      fallbacks: 1,
      vecComparisons: 1,
      meanOverlapVec5: 1,
      meanMrrVec: 1,
      top1VecRecall: 1,
    });
  });
});

describe("loadVectorStore", () => {
  it("tolerates missing and malformed files", () => {
    expect(loadVectorStore(join(tmp, "missing-vectors.json"))).toEqual({ model: "", dims: 0, vectors: {} });
    const bad = join(tmp, "bad-vectors.json");
    writeFileSync(bad, "{oops");
    expect(loadVectorStore(bad)).toEqual({ model: "", dims: 0, vectors: {} });
  });
});