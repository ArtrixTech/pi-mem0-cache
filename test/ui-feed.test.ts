import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piMem0Cache from "../src/index.ts";

const SEARCH_URL = "https://api.mem0.ai/v3/memories/search/";
const ADD_URL = "https://api.mem0.ai/v3/memories/add/";
const AUTH = { authorization: "Token t" };

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-uifeed-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type EventHandler = (event: unknown, ctx: UiCtx) => void;
interface UiCtx {
  hasUI: boolean;
  ui: {
    notify: (msg: string, level: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
}

function makeCtx(hasUI: boolean): { ctx: UiCtx; notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const setStatus = vi.fn();
  return { ctx: { hasUI, ui: { notify, setStatus } }, notify, setStatus };
}

describe("extension entry UI routing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Keep the suite hermetic: no keychain, no embed provider, no reranker.
  beforeEach(() => {
    vi.stubEnv("MEM0_KEYCHAIN", "0");
    vi.stubEnv("MEM0_EMBED", "0");
    vi.stubEnv("MEM0_RERANK", "0");
  });

  function load(
    run: string,
    opts: { searchStatus?: number; addStatus?: number } = {},
  ): { handlers: Map<string, EventHandler>; urls: string[] } {
    const searchStatus = opts.searchStatus ?? 200;
    const addStatus = opts.addStatus ?? 500;
    vi.stubEnv("MEM0_CACHE_PATH", join(tmp, `store-${run}.json`));
    vi.stubEnv("MEM0_CACHE_SHADOW_PATH", join(tmp, `shadow-${run}.jsonl`));
    vi.stubEnv("MEM0_VECTORS_PATH", join(tmp, `vectors-${run}.json`));
    const handlers = new Map<string, EventHandler>();
    const on = (name: string, handler: EventHandler): void => {
      handlers.set(name, handler);
    };
    const registerCommand = (): void => {};
    const urls: string[] = [];
    const inner = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === SEARCH_URL) {
        return new Response(JSON.stringify({ results: [] }), { status: searchStatus, headers: { "content-type": "application/json" } });
      }
      if (url === ADD_URL) {
        return new Response("boom", { status: addStatus });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    globalThis.fetch = inner;
    piMem0Cache({ on, registerCommand } as never);
    return { handlers, urls };
  }

  it("queues fallback warnings and flushes them as notify() toasts on agent_end", async () => {
    const { handlers } = load(`e${Date.now()}`, { searchStatus: 500 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await globalThis.fetch(SEARCH_URL, { method: "POST", headers: AUTH, body: JSON.stringify({ query: "x" }) });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("[pi-mem0-cache]"));

    const { ctx, notify, setStatus } = makeCtx(true);
    handlers.get("agent_end")?.(null, ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("fell back (HTTP 500)"), "warning");
    expect(setStatus).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("renders the routine sync result as a footer status, without a toast", async () => {
    const { handlers, urls } = load(`s${Date.now()}`);
    // A failing live write queues a pending local memory...
    await globalThis.fetch(ADD_URL, { method: "POST", headers: AUTH, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) });
    // ...and a successful passthrough with auth triggers the sync replay.
    // The replay hits the same failing ADD_URL mock, so the sync ends with
    // failed 1 — the lastResult still renders as footer status, and the
    // "sync paused" warning becomes a toast.
    await globalThis.fetch(SEARCH_URL, { method: "POST", headers: AUTH, body: JSON.stringify({ query: "x" }) });
    await vi.waitFor(() => {
      expect(urls.filter((u) => u === ADD_URL)).toHaveLength(2); // live write + sync replay
    });
    // Let the sync runner finish emitting after the replay response resolves.
    await new Promise((resolve) => setImmediate(resolve));

    const { ctx, notify, setStatus } = makeCtx(true);
    handlers.get("agent_end")?.(null, ctx);
    expect(setStatus).toHaveBeenCalledWith("mem0-cache", expect.stringMatching(/^sync: uploaded 0, ops applied 0, failed 1, pending 1/));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("sync paused"), "warning");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("sync: uploaded"), expect.anything());
  });

  it("falls back to stderr when the flush context has no UI (headless)", async () => {
    const { handlers } = load(`h${Date.now()}`, { searchStatus: 500 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await globalThis.fetch(SEARCH_URL, { method: "POST", headers: AUTH, body: JSON.stringify({ query: "x" }) });

    const { ctx, notify, setStatus } = makeCtx(false);
    handlers.get("agent_end")?.(null, ctx);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fell back (HTTP 500)"));
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
