import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type DiagnosticReporter = (message: string) => void;
const REPORTER = Symbol.for("pi-mem0-cache.diagnostic-reporter");
const PENDING = Symbol.for("pi-mem0-cache.retired-diagnostics");
const state = globalThis as typeof globalThis & {
  [REPORTER]?: DiagnosticReporter;
  [PENDING]?: string[];
};

/** Bind persistence diagnostics and preserve late shutdown errors in a private file. */
export function setDiagnosticReporter(reporter: DiagnosticReporter): () => void {
  const logPath = process.env.MEM0_CACHE_DIAGNOSTICS_PATH ?? join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "logs", "mem0-cache-diagnostics.jsonl",
  );
  const retired: DiagnosticReporter = (message) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      try {
        if (statSync(logPath).size > 2 * 1024 * 1024) renameSync(logPath, `${logPath}.1`);
      } catch { /* A fresh diagnostic file starts with its first record. */ }
      appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), message: message.slice(0, 16384) }) + "\n", { mode: 0o600 });
    } catch {
      const pending = state[PENDING] ??= [];
      pending.push(message);
      if (pending.length > 100) pending.shift();
    }
  };
  state[REPORTER] = reporter;
  for (const message of state[PENDING]?.splice(0) ?? []) reporter(message);
  return () => {
    if (state[REPORTER] === reporter) state[REPORTER] = retired;
  };
}

/** Preserve standalone stderr diagnostics through the same entry point. */
export function reportDiagnostic(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const text = `${message}: ${detail}`;
  const reporter = state[REPORTER];
  if (reporter) reporter(text);
  else console.warn(`[pi-mem0-cache] ${text}`);
}
