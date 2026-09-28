/**
 * Version fingerprint for shadow entries.
 *
 * A shadow entry is evidence about one moment of live traffic, and evidence is
 * only useful when it says what produced it. These two identifiers are stored on
 * every entry so a later statistic can be sliced by the code that wrote it,
 * which is what makes "cumulative since version X" an answerable question.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Field-structure version of a shadow entry. Bump this when a field is added,
 *  removed or changes meaning, so a reader can tell an absent field from one the
 *  writer never knew about. */
export const SHADOW_SCHEMA_VERSION = 1;

/** The running code's version. Read from the package manifest once, so a report
 *  can distinguish entries written by this build from entries written by an
 *  earlier one. Absent when the manifest cannot be read. */
function readPackageVersion(): string | undefined {
  try {
    // Both the dev tree and the installed checkout keep the manifest two levels
    // above this file (src/version.ts -> package.json), so one relative path
    // serves both.
    const url = new URL("../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export const CODE_VERSION: string | undefined = readPackageVersion();
