/**
 * Provider credentials: resolve an API key from the environment first, then the
 * macOS Keychain. Shared by the embedder and the reranker so both report their
 * source the same way.
 */

import { execFileSync } from "node:child_process";
import { EMBED_PROVIDERS } from "./types.js";

/** Keychain service name per provider, written by scripts/setup-key.sh. */
export const KEYCHAIN_SERVICES: Record<string, string> = {
  openrouter: "pi-mem0-cache.openrouter",
  jina: "pi-mem0-cache.jina",
  mem0: "pi-mem0-cache.mem0",
};

/**
 * Read a secret from the macOS Keychain.
 *
 * Keys stored this way never appear in a shell export, a dotfile, a process
 * argument, or a repo — `security -w` prints the value on stdout, so it is read
 * as a buffer and never echoed. Returns undefined when the entry is missing or
 * the platform has no keychain, so every caller keeps an env fallback.
 */
export function readKeyFromKeychain(service: string): string | undefined {
  // Tests must be able to run without reading the machine's real credentials:
  // a developer with a live key in the keychain would otherwise get a different
  // code path than CI. Set MEM0_KEYCHAIN=0 to disable all keychain reads.
  if (process.env.MEM0_KEYCHAIN === "0") return undefined;
  if (!service) return undefined;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const trimmed = String(out).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a provider's API key: environment first, then the Keychain. An empty
 *  env var counts as absent, so `export OPENROUTER_API_KEY=` cannot mask a
 *  keychain key. */
export function resolveProviderKey(provider: string): string | undefined {
  const preset = EMBED_PROVIDERS[provider];
  const envName = preset?.keyEnv ?? `${provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const service = KEYCHAIN_SERVICES[provider];
  return service ? readKeyFromKeychain(service) : undefined;
}
