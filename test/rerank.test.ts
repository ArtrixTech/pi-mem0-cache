import { describe, expect, it, vi, beforeEach } from "vitest";
import { createReranker, parseRerankResponse } from "../src/recall/rerank.js";
import type { FusedHit } from "../src/recall/fusion.js";

const hit = (id: string, score = 1): FusedHit => ({ id, score, ranks: {} });

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("parseRerankResponse", () => {
  it("maps index back to the candidate id and keeps the reranker's order", () => {
    const out = parseRerankResponse(
      { results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }] },
      ["a", "b", "c"],
    );
    expect(out.map((h) => h.id)).toEqual(["c", "a", "b"]);
    expect(out[0].score).toBe(0.9);
  });

  it("accepts a data envelope as well as results", () => {
    const out = parseRerankResponse({ data: [{ index: 1, relevance_score: 0.7 }] }, ["a", "b"]);
    expect(out).toEqual([{ id: "b", score: 0.7 }]);
  });

  it("falls back to array position when the response omits index", () => {
    const out = parseRerankResponse({ results: [{ relevance_score: 0.9 }, { relevance_score: 0.4 }] }, ["a", "b"]);
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("accepts score as an alias for relevance_score", () => {
    const out = parseRerankResponse({ results: [{ index: 0, score: 0.42 }] }, ["a"]);
    expect(out[0].score).toBe(0.42);
  });

  it("drops out-of-range indices instead of producing undefined ids", () => {
    const out = parseRerankResponse({ results: [{ index: 9, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] }, ["a"]);
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });

  it("returns an empty list for a shapeless body", () => {
    expect(parseRerankResponse({}, ["a"])).toEqual([]);
    expect(parseRerankResponse(null, ["a"])).toEqual([]);
    expect(parseRerankResponse({ results: "nope" }, ["a"])).toEqual([]);
  });
});

describe("createReranker", () => {
  it("posts the query and resolved document texts, and returns reordered hits", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rerank = createReranker({
      apiKey: "test-key",
      model: "voyageai/rerank-2.5-lite",
      endpoint: "https://openrouter.ai/api/v1/rerank",
      fetchImpl,
    });

    const texts: Record<string, string> = { a: "first doc", b: "second doc" };
    const out = await rerank("my query", [hit("a"), hit("b")], (id) => texts[id] ?? "");

    expect(out.map((h) => h.id)).toEqual(["b", "a"]);
    const body = seen[0].body as { model: string; query: string; documents: string[] };
    expect(body.model).toBe("voyageai/rerank-2.5-lite");
    expect(body.query).toBe("my query");
    expect(body.documents).toEqual(["first doc", "second doc"]);
  });

  it("sends the bearer token from the api key", async () => {
    let auth = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).Authorization ?? "");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rerank = createReranker({ apiKey: "sk-secret", fetchImpl });
    await rerank("q", [hit("a")], () => "doc");
    expect(auth).toBe("Bearer sk-secret");
  });

  it("short-circuits an empty candidate list without calling the provider", async () => {
    const fetchImpl = vi.fn();
    const rerank = createReranker({ apiKey: "k", fetchImpl: fetchImpl as never });
    expect(await rerank("q", [], () => "")).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws with the provider's response body on a non-2xx status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 })) as unknown as typeof fetch;
    const rerank = createReranker({ apiKey: "k", fetchImpl });
    // A bare status code is what let the Jina 403 sit unnoticed for nine days.
    await expect(rerank("q", [hit("a")], () => "doc")).rejects.toThrow(/402[\s\S]*insufficient credits/);
  });

  it("truncates an over-long document so one huge memory cannot fail the batch", async () => {
    let sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = (JSON.parse(String(init.body)) as { documents: string[] }).documents;
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rerank = createReranker({ apiKey: "k", fetchImpl, maxDocChars: 50 });
    await rerank("q", [hit("a")], () => "x".repeat(500));
    expect(sent[0].length).toBe(50);
  });

  it("uses the default endpoint and model when not overridden", async () => {
    let url = "";
    let model = "";
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = String(u);
      model = (JSON.parse(String(init.body)) as { model: string }).model;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rerank = createReranker({ apiKey: "k", fetchImpl });
    await rerank("q", [hit("a")], () => "doc");
    expect(url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(model).toBe("voyageai/rerank-2.5-lite");
  });
});
