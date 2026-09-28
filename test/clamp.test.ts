import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampMemory, createOpenAiCompatEmbedder, emptyStore, harvestMemories, MAX_MEMORY_CHARS } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "mem0-clamp-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const OLD_QUARANTINE = process.env.MEM0_HARVEST_QUARANTINE_PATH;

beforeEach(() => {
  process.env.MEM0_HARVEST_QUARANTINE_PATH = join(tmp, "quarantine.jsonl");
});
afterEach(() => {
  if (OLD_QUARANTINE === undefined) delete process.env.MEM0_HARVEST_QUARANTINE_PATH;
  else process.env.MEM0_HARVEST_QUARANTINE_PATH = OLD_QUARANTINE;
});

describe("clampMemory", () => {
  it("passes through a memory within the bound", () => {
    const r = clampMemory("short", "id-1");
    expect(r.text).toBe("short");
    expect(r.overflow).toBeUndefined();
  });

  it("truncates and reports the original size when over the bound", () => {
    const r = clampMemory("x".repeat(MAX_MEMORY_CHARS + 500), "id-2");
    expect(r.text).toHaveLength(MAX_MEMORY_CHARS);
    expect(r.overflow).toEqual({ originalChars: MAX_MEMORY_CHARS + 500, truncatedAt: MAX_MEMORY_CHARS });
  });

  it("quarantines the original text alongside trimming the copy", () => {
    const original = "y".repeat(MAX_MEMORY_CHARS + 10);
    clampMemory(original, "id-3");
    const lines = readFileSync(process.env.MEM0_HARVEST_QUARANTINE_PATH!, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]) as { id: string; chars: number; memory: string };
    expect(entry.id).toBe("id-3");
    expect(entry.chars).toBe(original.length);
    // The full text is recoverable, so a truncated memory is never lost.
    expect(entry.memory).toBe(original);
  });

  it("keeps a whole character when the cut lands mid-surrogate-pair", () => {
    // An emoji is two UTF-16 units; cutting between them produces a lone
    // surrogate, which is invalid and would render as a replacement character.
    const head = "a".repeat(MAX_MEMORY_CHARS - 1);
    const r = clampMemory(head + "😀".repeat(50), "id-4");
    const last = r.text.charCodeAt(r.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("harvestMemories size guard", () => {
  it("clamps an oversized memory from a remote response", () => {
    const store = emptyStore();
    harvestMemories(store, JSON.stringify({ results: [{ id: "r1", memory: "z".repeat(MAX_MEMORY_CHARS + 100) }] }));
    expect(store.memories.r1.memory).toHaveLength(MAX_MEMORY_CHARS);
    expect(store.memories.r1.overflow?.originalChars).toBe(MAX_MEMORY_CHARS + 100);
    expect(store.stats.harvestDropped).toBe(1);
  });

  it("leaves a normal memory untouched", () => {
    const store = emptyStore();
    harvestMemories(store, JSON.stringify({ results: [{ id: "r2", memory: "normal" }] }));
    expect(store.memories.r2.memory).toBe("normal");
    expect(store.memories.r2.overflow).toBeUndefined();
    // The counter starts at zero and only moves for a memory that was clamped.
    expect(store.stats.harvestDropped).toBe(0);
  });
});

describe("embedder input guard", () => {
  it("truncates an oversized input so one long memory cannot fail the batch", async () => {
    let sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = (JSON.parse(String(init.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({ data: sent.map((_, i) => ({ index: i, embedding: [1, 0] })) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const embedder = createOpenAiCompatEmbedder({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/embeddings",
      fetchImpl,
      maxInputChars: 100,
    });
    // The regression: a 250,819-character memory produced HTTP 400 for the whole
    // batch, so the embedding layer never converged.
    const vecs = await embedder.embed(["short", "x".repeat(500)]);
    expect(sent[0]).toBe("short");
    expect(sent[1]).toHaveLength(100);
    expect(vecs).toHaveLength(2);
  });

  it("caps an input that would otherwise be rejected by the provider", async () => {
    let sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = (JSON.parse(String(init.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({ data: sent.map((_, i) => ({ index: i, embedding: [1, 0] })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const embedder = createOpenAiCompatEmbedder({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/embeddings",
      fetchImpl,
    });
    // An unclamped 250,819-character memory made the provider answer HTTP 400 for
    // the entire batch.
    await embedder.embed(["q".repeat(250_819)]);
    expect(sent[0].length).toBe(8000);
  });

  it("sends nothing for an empty input list", async () => {
    const fetchImpl = vi.fn();
    const embedder = createOpenAiCompatEmbedder({
      apiKey: "k",
      model: "m",
      endpoint: "https://example.test/embeddings",
      fetchImpl: fetchImpl as never,
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
