import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import piMem0Cache, { readShadowEntries } from "../src/index.ts";

const SEARCH_URL = "https://api.mem0.ai/v3/memories/search/";

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-shadow-entry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface NotifyCtx {
  ui: { notify: (msg: string, level: string) => void };
}

describe("extension entry shadow wiring", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("wraps global fetch, logs shadow entries, and reports via /mem0-cache shadow", async () => {
    const run = `e${Date.now()}`;
    vi.stubEnv("MEM0_CACHE_PATH", join(tmp, `store-${run}.json`));
    vi.stubEnv("MEM0_CACHE_SHADOW_PATH", join(tmp, `shadow-${run}.jsonl`));
    const inner = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === SEARCH_URL) {
        return new Response(JSON.stringify({ results: [{ id: "r1", memory: "m", score: 0.8 }] }), {
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
    ): void => { handler = cmd.handler; };
    piMem0Cache({ registerCommand } as never);

    const res = await globalThis.fetch(SEARCH_URL, { method: "POST", body: JSON.stringify({ query: "hello" }) });
    expect(res.status).toBe(200);
    const entries = readShadowEntries(join(tmp, `shadow-${run}.jsonl`));
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe("remote");
    expect(entries[0].query).toBe("hello");

    let message = "";
    await handler!("shadow", { ui: { notify: (msg: string) => { message = msg; } } });
    expect(message).toContain("1 comparisons");
    expect(message).toContain("overlap@5");
  });
});