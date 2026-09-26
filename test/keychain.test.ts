import { describe, expect, it, vi, beforeEach } from "vitest";

// The keychain reader shells out to `security`; mock node:child_process so the
// test never touches the real keychain.
const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => execFileSync(...args) }));

const { readKeyFromKeychain, KEYCHAIN_SERVICES, resolveProviderKey, createDefaultEmbedder } = await import(
  "../src/index.js"
);

beforeEach(() => {
  execFileSync.mockReset();
  vi.unstubAllEnvs();
});

describe("readKeyFromKeychain", () => {
  it("returns the trimmed secret on success", () => {
    execFileSync.mockReturnValue("sk-or-v1-abc123\n");
    expect(readKeyFromKeychain("pi-mem0-cache.openrouter")).toBe("sk-or-v1-abc123");
  });

  it("passes the service name and never logs the value", () => {
    execFileSync.mockReturnValue("secret\n");
    readKeyFromKeychain("pi-mem0-cache.openrouter");
    expect(execFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "pi-mem0-cache.openrouter", "-w"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns undefined when the entry does not exist", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("security: could not be found");
    });
    expect(readKeyFromKeychain("pi-mem0-cache.absent")).toBeUndefined();
  });

  it("returns undefined for an empty secret", () => {
    execFileSync.mockReturnValue("\n");
    expect(readKeyFromKeychain("pi-mem0-cache.empty")).toBeUndefined();
  });
});

describe("resolveProviderKey", () => {
  it("prefers the environment over the keychain", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "from-env");
    execFileSync.mockReturnValue("from-keychain\n");
    expect(resolveProviderKey("openrouter")).toBe("from-env");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the keychain when the env var is unset", () => {
    execFileSync.mockReturnValue("from-keychain\n");
    expect(resolveProviderKey("openrouter")).toBe("from-keychain");
  });

  it("treats an empty env var as absent", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    execFileSync.mockReturnValue("from-keychain\n");
    expect(resolveProviderKey("openrouter")).toBe("from-keychain");
  });

  it("returns undefined when neither source has a key", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveProviderKey("openrouter")).toBeUndefined();
  });

  it("knows the service name for each provider", () => {
    expect(KEYCHAIN_SERVICES.openrouter).toBe("pi-mem0-cache.openrouter");
    expect(KEYCHAIN_SERVICES.jina).toBe("pi-mem0-cache.jina");
  });
});

describe("createDefaultEmbedder with keychain-only credentials", () => {
  it("builds an OpenRouter embedder from a keychain-stored key", () => {
    vi.stubEnv("MEM0_CONFIG_PATH", "/tmp/no-such-config.json");
    execFileSync.mockReturnValue("sk-or-v1-from-keychain\n");
    const e = createDefaultEmbedder();
    expect(e?.model).toBe("qwen/qwen3-embedding-8b");
  });
});
