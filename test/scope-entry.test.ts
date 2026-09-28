import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import piMem0Cache from "../src/index.ts";

const GETALL_URL = "https://api.mem0.ai/v3/memories/";

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-scope-entry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface NotifyCtx {
  ui: { notify: (msg: string, level: string) => void };
}

/** Mount the extension against a seeded store and return the fetch the agent
 *  actually sees. The interceptor wraps globalThis.fetch at registration, so the
 *  test reads the wrapper after mounting. */
function mount(run: string, memories: Record<string, unknown>) {
  const storePath = join(tmp, `store-${run}.json`);
  const realFetch = (async () => {
    throw new Error("local only: the freshness gate must answer without the network");
  }) as unknown as typeof fetch;
  globalThis.fetch = realFetch;

  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      cache: {},
      syncState: {},
      ops: [],
      netState: { lastRemoteReadAt: Date.now() - 1000 },
      stats: { hits: 0, misses: 0, passthroughs: 0, staleServed: 0, fallbacks: 0, localWrites: 0, gated: 0 },
      memories,
      ...({} as Record<string, unknown>),
    }),
  );
  vi.stubEnv("MEM0_CACHE_PATH", storePath);
  vi.stubEnv("MEM0_CACHE_SHADOW_PATH", join(tmp, `shadow-${run}.jsonl`));
  vi.stubEnv("MEM0_VECTORS_PATH", join(tmp, `vectors-${run}.json`));
  vi.stubEnv("MEM0_CONFIG_PATH", join(tmp, "no-config.json"));
  vi.stubEnv("MEM0_KEYCHAIN", "0");
  vi.stubEnv("JINA_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");

  let handler: ((args: string | undefined, ctx: NotifyCtx) => Promise<void>) | undefined;
  piMem0Cache({
    registerCommand: (
      _n: string,
      cmd: { handler: (args: string | undefined, ctx: NotifyCtx) => Promise<void> },
    ) => {
      handler = cmd.handler;
    },
  } as never);
  return { fetch: globalThis.fetch, notify: handler! };
}

/** Seeded mirror: two apps plus one global-scope (app_id null) memory. */
function seedCorpus() {
  const now = new Date().toISOString();
  const base = { created_at: now, updated_at: now, source: "observed" as const };
  return {
    "a-1": { ...base, id: "a-1", memory: "reach 的部署脚本", user_id: "artrix", app_id: "artrix-reach" },
    "a-2": { ...base, id: "a-2", memory: "reach 的同步规程", user_id: "artrix", app_id: "artrix-reach" },
    "b-1": { ...base, id: "b-1", memory: "hbrw 的看板配置", user_id: "artrix", app_id: "hbrw-control" },
    "b-2": { ...base, id: "b-2", memory: "hbrw 的待办约定", user_id: "artrix", app_id: "hbrw-control" },
    // Global-scope write: no app_id at all.
    "g-1": { ...base, id: "g-1", memory: "全局偏好：用中文回答", user_id: "artrix" },
    "other": { ...base, id: "other", memory: "别人的记忆", user_id: "someone-else", app_id: "artrix-reach" },
  };
}

describe("scope isolation on local reads", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("getAll with an app filter returns only that app's memories", async () => {
    const { fetch: f } = mount(`s${Date.now()}`, seedCorpus());

    const res = await f(GETALL_URL, {
      method: "POST",
      body: JSON.stringify({ filters: { user_id: "artrix", app_id: "artrix-reach" } }),
    });
    const body = (await res.json()) as { results: { id: string }[]; count: number };
    const ids = body.results.map((r) => r.id).sort();
    // a-1/a-2 belong to the app; g-1 has no app_id so it is not app-scoped;
    // b-* is another app; "other" is another user.
    expect(ids).toEqual(["a-1", "a-2"]);
    expect(body.count).toBe(2);
  });

  it("getAll with only a user filter keeps global-scope memories visible", async () => {
    const { fetch: f } = mount(`s${Date.now()}u`, seedCorpus());

    const res = await f(GETALL_URL, {
      method: "POST",
      body: JSON.stringify({ filters: { user_id: "artrix" } }),
    });
    const body = (await res.json()) as { results: { id: string }[] };
    const ids = body.results.map((r) => r.id).sort();
    // Every memory of this user across apps, plus the global-scope one, and
    // nothing belonging to someone-else.
    expect(ids).toEqual(["a-1", "a-2", "b-1", "b-2", "g-1"]);
  });

  it("getAll with an app_id wildcard is unconstrained, not app-empty", async () => {
    const { fetch: f } = mount(`s${Date.now()}w`, seedCorpus());

    const res = await f(GETALL_URL, {
      method: "POST",
      body: JSON.stringify({ filters: { user_id: "artrix", app_id: "*" } }),
    });
    const body = (await res.json()) as { results: { id: string }[] };
    // "*" must not be treated as a literal app name (that would return nothing).
    expect(body.results.map((r) => r.id).sort()).toEqual(["a-1", "a-2", "b-1", "b-2", "g-1"]);
  });

  it("search with an app filter never ranks another app's memories", async () => {
    const { fetch: f } = mount(`s${Date.now()}q`, seedCorpus());

    const res = await f("https://api.mem0.ai/v3/memories/search/", {
      method: "POST",
      body: JSON.stringify({ query: "看板 待办 配置", filters: { user_id: "artrix", app_id: "artrix-reach" } }),
    });
    const body = (await res.json()) as { results: { id: string }[] };
    const ids = body.results.map((r) => r.id);
    // The query lexically matches the hbrw memories; scoping must exclude them.
    expect(ids).not.toContain("b-1");
    expect(ids).not.toContain("b-2");
    expect(ids.every((id) => id === "a-1" || id === "a-2")).toBe(true);
  });

  it("get of an out-of-scope memory id returns nothing", async () => {
    const { fetch: f } = mount(`s${Date.now()}g`, seedCorpus());

    // SDK single-item GET: scope travels in the query string, since a GET
    // cannot carry a body under the fetch standard.
    const res = await f(`${GETALL_URL}b-1?user_id=artrix&app_id=artrix-reach`, { method: "GET" });
    // b-1 exists and is live under another app: the local path must
    // not answer with it.
    expect(res.status).toBe(404);
  });

  it("tags a fetched memory with its scope so later writes can reuse it", async () => {
    const { fetch: f } = mount(`s${Date.now()}t`, seedCorpus());

    const res = await f(`${GETALL_URL}a-1?user_id=artrix&app_id=artrix-reach`, { method: "GET" });
    const body = (await res.json()) as { id: string; app_id?: string };
    expect(body.id).toBe("a-1");
    expect(body.app_id).toBe("artrix-reach");
  });
});
