import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDefaultEmbedder, readJinaKeyFromConfig } from "../src/index.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-mem0-embed-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("jina key resolution", () => {
  const savedEnv = { ...process.env };
  afterAll(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  it("reads jinaApiKey from mem0-config.json", () => {
    const path = join(tmp, "mem0-config.json");
    writeFileSync(path, JSON.stringify({ apiKey: "m0-xxx", jinaApiKey: "jina_test-key" }));
    expect(readJinaKeyFromConfig(path)).toBe("jina_test-key");
  });

  it("returns undefined for missing field, missing file, and malformed json", () => {
    const path = join(tmp, "partial.json");
    writeFileSync(path, JSON.stringify({ apiKey: "m0-xxx" }));
    expect(readJinaKeyFromConfig(path)).toBeUndefined();
    expect(readJinaKeyFromConfig(join(tmp, "missing.json"))).toBeUndefined();
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{oops");
    expect(readJinaKeyFromConfig(bad)).toBeUndefined();
  });

  it("createDefaultEmbedder prefers env, falls back to config file, honors MEM0_EMBED=0", () => {
    const configPath = join(tmp, "cfg.json");
    writeFileSync(configPath, JSON.stringify({ jinaApiKey: "jina-from-config" }));

    vi.stubEnv("JINA_API_KEY", "jina-env-key");
    let embedder = createDefaultEmbedder();
    expect(embedder?.model).toBeDefined(); // env key wins; model default applied in entry path

    vi.stubEnv("JINA_API_KEY", "");
    vi.stubEnv("MEM0_CONFIG_PATH", configPath);
    embedder = createDefaultEmbedder();
    expect(embedder).toBeDefined(); // config-file fallback

    vi.stubEnv("MEM0_EMBED", "0");
    expect(createDefaultEmbedder()).toBeUndefined();
    vi.unstubAllEnvs();
  });
});