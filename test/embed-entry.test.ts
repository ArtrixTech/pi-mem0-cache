import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import piMem0Cache from "../src/index.ts";

const SEARCH_URL = "https://api.mem0.ai/v3/memories/search/";
const JINA_URL = "https://api.jina.ai/v1/embeddings";

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-embed-entry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface NotifyCtx {
  ui: { notify: (msg: string, level: string) => void };
}

describe("extension entry embedding wiring", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("serves gated reads via jina-backed vectors and reports embed status", async () => {
    const run = `e${Date.now()}`;
    const storePath = join(tmp, `store-${run}.json`);
    // Seeded corpus + a gate that went quiet 1s ago: the gated read below must
    // be served by the vector ranking, which reverses the keyword order.
    const now = new Date().toISOString();
    const seeded = {
      version: 1,
      cache: {},
      syncState: {},
      netState: { lastRemoteReadAt: Date.now() - 1000 },
      stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0, gated: 0 },
      memories: {
        "kw-first": { id: "kw-first", memory: "veeam 警告", created_at: now, updated_at: now, source: "observed" },
        "vec-first": { id: "vec-first", memory: "veeam 备份", created_at: now, updated_at: now, source: "observed" },
      },
    };
    writeFileSync(storePath, JSON.stringify(seeded));
    vi.stubEnv("MEM0_CACHE_PATH", storePath);
    vi.stubEnv("MEM0_CACHE_SHADOW_PATH", join(tmp, `shadow-${run}.jsonl`));
    vi.stubEnv("MEM0_VECTORS_PATH", join(tmp, `vectors-${run}.json`));
    vi.stubEnv("JINA_API_KEY", "sk-entry-test");

    const table: Record<string, number[]> = {
      "veeam 查询": [0.95, 0.05],
      "veeam 备份": [1, 0],
      "veeam 警告": [0.4, 0.9],
    };
    const inner = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === JINA_URL) {
        const req = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
        return new Response(
          JSON.stringify({ data: (req.input ?? []).map((t, i) => ({ embedding: table[t] ?? [0, 0], index: i })) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === SEARCH_URL) {
        return new Response(JSON.stringify({ results: [{ id: "remote-1", memory: "m" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    globalThis.fetch = inner;

    let handler: ((args: string | undefined, ctx: NotifyCtx) => Promise<void>) | undefined;
    const registerCommand = (
      _name: string,
      cmd: { handler: (args: string | undefined, ctx: NotifyCtx) => Promise<void> },
    ): void => {
      handler = cmd.handler;
    };
    piMem0Cache({ registerCommand } as never);

    // Gated read: keyword would put kw-first first; vectors reverse it.
    const res = await globalThis.fetch(SEARCH_URL, { method: "POST", body: JSON.stringify({ query: "veeam 查询" }) });
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results[0].id).toBe("vec-first");

    // Embed status: corpus fully embedded by the gated read above.
    let msg = "";
    await handler!("embed", { ui: { notify: (m: string) => { msg = m; } } });
    expect(msg).toContain("2/2 vectors");
    expect(msg).toContain("jina-embeddings-v5-text-nano");

    // Refresh forces a full re-embed.
    await handler!("embed refresh", { ui: { notify: (m: string) => { msg = m; } } });
    expect(msg).toContain("embedded 2/2");
  });

  it("stays keyword-only without JINA_API_KEY", async () => {
    const run = `k${Date.now()}`;
    const storePath = join(tmp, `store-${run}.json`);
    const now = new Date().toISOString();
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      cache: {},
      syncState: {},
      netState: { lastRemoteReadAt: Date.now() - 1000 },
      stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0, gated: 0 },
      memories: {
        kw1: { id: "kw1", memory: "veeam 警告", created_at: now, updated_at: now, source: "observed" },
        kw2: { id: "kw2", memory: "veeam 备份", created_at: now, updated_at: now, source: "observed" },
      },
    }));
    vi.stubEnv("MEM0_CACHE_PATH", storePath);
    vi.stubEnv("MEM0_VECTORS_PATH", join(tmp, `vectors-${run}.json`));
    // no JINA_API_KEY
    globalThis.fetch = (async () => {
      throw new Error("must not touch the network");
    }) as typeof fetch;

    let handler: ((args: string | undefined, ctx: NotifyCtx) => Promise<void>) | undefined;
    const registerCommand = (
      _name: string,
      cmd: { handler: (args: string | undefined, ctx: NotifyCtx) => Promise<void> },
    ): void => {
      handler = cmd.handler;
    };
    piMem0Cache({ registerCommand } as never);

    const res = await globalThis.fetch(SEARCH_URL, { method: "POST", body: JSON.stringify({ query: "veeam 查询" }) });
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results.map((r) => r.id)).toEqual(["kw1", "kw2"]); // keyword order preserved

    let msg = "";
    await handler!("embed", { ui: { notify: (m: string) => { msg = m; } } });
    expect(msg).toContain("disabled");
  });
});