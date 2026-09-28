import { describe, expect, it } from "vitest";
import { applyLocalWrite, createSyncRunner, emptyStore } from "../src/index.js";
import type { ClassifiedRequest, LocalMemory, Store } from "../src/index.js";

/** A v3 add request in the shape the SDK actually sends: scope in the query
 *  string, the memory text in the body. */
function addRequest(body: Record<string, unknown>, query: string): ClassifiedRequest {
  const url = new URL(`https://api.mem0.ai/v3/memories/add/${query}`);
  return { url, method: "POST", bodyText: JSON.stringify(body), search: query, kind: "write-add" };
}

function scopeOf(m: LocalMemory): Record<string, unknown> {
  return ((m.addPayload ?? {}) as Record<string, unknown>);
}

describe("local write scope capture", () => {
  it("carries the request query scope into the replay payload", () => {
    // The live failure this pins: a locally-stored memory synced with an empty
    // addPayload, so every replay posted a body with no entity id and mem0
    // answered 400 "At least one entity ID is required". The scope was in the
    // request's query string and was never read.
    const store = emptyStore();
    const req = addRequest({ messages: [{ role: "user", content: "a locally written memory" }] }, "?user_id=artrix&app_id=artrix-reach");

    applyLocalWrite(store, req);

    const [m] = Object.values(store.memories);
    const payload = scopeOf(m);
    expect(payload.user_id).toBe("artrix");
    expect(payload.app_id).toBe("artrix-reach");
    expect(payload.messages).toBeUndefined(); // messages are rebuilt at replay
  });

  it("keeps a scope sent in the body too", () => {
    const store = emptyStore();
    const req = addRequest({ messages: [{ role: "user", content: "body-scoped" }], user_id: "artrix", app_id: "XAgent" }, "");
    applyLocalWrite(store, req);
    const [m] = Object.values(store.memories);
    expect(scopeOf(m).user_id).toBe("artrix");
    expect(scopeOf(m).app_id).toBe("XAgent");
  });

  it("lists the scope in the response it returns", () => {
    const store = emptyStore();
    const res = applyLocalWrite(store, addRequest({ messages: [{ role: "user", content: "x" }] }, "?user_id=artrix"));
    expect(res.status).toBe("PENDING");
  });
});

describe("sync scope repair", () => {
  it("repairs a payload that has no entity id, using the corpus scope", () => {
    // A record stored before scope capture worked has an empty payload. Retrying
    // it as-is cannot succeed, and discarding it loses the memory text. The
    // corpus carries the scope this machine writes under, so it is filled in.
    const store: Store = emptyStore();
    const id = "c1e04c62-2e57-412d-b014-ae023401a851";
    store.memories[id] = {
      id,
      memory: "a memory stored before scope capture worked",
      created_at: "2026-09-28T08:31:05.418Z",
      updated_at: "2026-09-28T08:31:05.418Z",
      source: "local",
    } as LocalMemory;
    // An observed memory establishes the scope this client writes under.
    store.memories["observed-1"] = {
      id: "observed-1",
      memory: "something already in the cloud",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      source: "observed",
      user_id: "artrix",
      app_id: "artrix-reach",
    } as LocalMemory;

    let sent = "";
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = String(init?.body ?? "");
        const body = JSON.parse(sent) as Record<string, unknown>;
        // The real server requires an entity id.
        if (!body.user_id && !body.agent_id && !body.app_id && !body.run_id) {
          return new Response(
            JSON.stringify({ error: "At least one entity ID is required (user_id, agent_id, app_id, or run_id)." }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }) as typeof fetch,
      getAuth: () => ({ origin: "https://api.mem0.ai", headers: { authorization: "Token t" } }),
    });

    return runner.sync(true).then((res) => {
      expect(res.uploaded).toBe(1);
      const body = JSON.parse(sent) as Record<string, unknown>;
      expect(body.user_id).toBe("artrix");
      expect(body.app_id).toBe("artrix-reach");
      expect(store.memories[id].source).toBe("observed");
    });
  });

  it("keeps a memory and its text when no scope can be determined", () => {
    // No scope anywhere means no correct request exists. Retiring the record
    // would discard its text, so it stays queued and reported.
    const store: Store = emptyStore();
    store.memories["orphan"] = {
      id: "orphan",
      memory: "no scope available for this one",
      created_at: "2026-09-28T08:31:05.418Z",
      updated_at: "2026-09-28T08:31:05.418Z",
      source: "local",
    } as LocalMemory;

    let calls = 0;
    const runner = createSyncRunner({
      store,
      save: () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("{}", { status: 400 });
      }) as typeof fetch,
      getAuth: () => ({ origin: "https://api.mem0.ai", headers: { authorization: "Token t" } }),
      backoffMs: 0,
    });

    return runner.sync(true).then((res) => {
      // Attempted as captured, and the text survives.
      expect(calls).toBe(1);
      expect(store.memories["orphan"]?.memory).toBe("no scope available for this one");
      expect(res.pending).toBeGreaterThan(0);
    });
  });
});
