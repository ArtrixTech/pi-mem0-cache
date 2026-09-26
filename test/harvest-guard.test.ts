import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { emptyStore, harvestMemories, MAX_MEMORY_CHARS, type Store } from "../src/index.js";

const QUARANTINE = "/tmp/pi-mem0-cache-test-quarantine.jsonl";

function makeStore(): Store {
  return emptyStore();
}

function result(id: string, memory: string): string {
  return JSON.stringify({ results: [{ id, memory }] });
}

beforeEach(() => {
  process.env.MEM0_HARVEST_QUARANTINE_PATH = QUARANTINE;
  if (existsSync(QUARANTINE)) rmSync(QUARANTINE);
});

afterEach(() => {
  delete process.env.MEM0_HARVEST_QUARANTINE_PATH;
  if (existsSync(QUARANTINE)) rmSync(QUARANTINE);
});

describe("harvestMemories oversized guard", () => {
  it("harvests a memory at exactly the cap unchanged", () => {
    const store = makeStore();
    const text = "a".repeat(MAX_MEMORY_CHARS);
    harvestMemories(store, result("ok", text));
    expect(store.memories.ok.memory).toBe(text);
    expect(store.stats.harvestDropped).toBe(0);
  });

  it("truncates a memory past the cap and marks it overflow", () => {
    const store = makeStore();
    harvestMemories(store, result("big", "x".repeat(MAX_MEMORY_CHARS + 5000)));
    const m = store.memories.big;
    expect(m).toBeDefined();
    expect(m.memory.length).toBe(MAX_MEMORY_CHARS);
    expect(m.overflow?.originalChars).toBe(MAX_MEMORY_CHARS + 5000);
    expect(store.stats.harvestDropped).toBe(1);
  });

  it("never truncates below the cap for multi-byte text and keeps valid strings", () => {
    const store = makeStore();
    harvestMemories(store, result("cjk", "中文记忆".repeat(4000)));
    const m = store.memories.cjk;
    expect(m.memory.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    // No lone surrogate halves left behind by the slice.
    for (const ch of m.memory) {
      const c = ch.codePointAt(0)!;
      expect(c < 0xd800 || c > 0xdfff).toBe(true);
    }
  });

  it("writes the full original text to the quarantine sidecar", () => {
    const store = makeStore();
    const text = "y".repeat(MAX_MEMORY_CHARS + 100);
    harvestMemories(store, result("q", text));
    const lines = readFileSync(QUARANTINE, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.id).toBe("q");
    expect(entry.chars).toBe(text.length);
    expect(entry.memory).toBe(text);
  });

  it("leaves normal-sized memories alone and does not count them", () => {
    const store = makeStore();
    harvestMemories(store, JSON.stringify({ results: [{ id: "a", memory: "short" }, { id: "b", memory: "z".repeat(500) }] }));
    expect(store.memories.a.memory).toBe("short");
    expect(store.memories.b.memory).toBe("z".repeat(500));
    expect(store.stats.harvestDropped).toBe(0);
  });
});
