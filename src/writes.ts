/**
 * Local write application: apply a write to the mirror when the API is
 * unavailable, echo a confirmed remote write into it, and reconcile queued ops.
 */

import { randomUUID } from "node:crypto";
import { clampMemory } from "./memory.js";
import { ENTITY_FILTER_KEYS } from "./types.js";
import type { ClassifiedRequest, LocalMemory, Store } from "./types.js";

export function stripInternal(m: LocalMemory): Record<string, unknown> {
  const { deleted, source, ...rest } = m;
  return rest;
}

export function applyLocalWrite(store: Store, req: ClassifiedRequest): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (req.kind) {
    case "write-add": {
      let contents: string[] = [];
      let addPayload: Record<string, unknown> = {};
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { messages?: { content?: string }[] } & Record<string, unknown>;
        const { messages, ...rest } = body;
        addPayload = rest;
        contents = (messages ?? [])
          .map((m) => m.content)
          .filter((c): c is string => typeof c === "string" && c.length > 0);
      } catch {
        /* ignore */
      }
      const memory = contents.join("\n") || "(empty)";
      const id = `local-${randomUUID()}`;
      // Scope travels in the query string on a v3 add (`?user_id=…&app_id=…`),
      // which is how the SDK scopes a write. Reading only the body left the
      // replay payload with no entity id, and mem0 answers such a request with
      // 400 "At least one entity ID is required", so the memory could never
      // sync. Body keys are merged first so an explicit body scope wins.
      const queryScope: Record<string, unknown> = {};
      try {
        for (const [k, v] of new URLSearchParams(req.search ?? "")) {
          // A wildcard is not a scope: mem0 stores a "*"-valued write so no later
          // read can reach it, the asymmetry behind mem0ai/mem0#6168. The read
          // path drops it, and passing it through here stored the memory under
          // an app id that no scoped read matches.
          if (ENTITY_FILTER_KEYS.has(k) && v && v !== "*") queryScope[k] = v;
        }
      } catch {
        /* malformed query string */
      }
      // The same bound harvest applies, applied here too. A 250,819-character add
      // payload reached the store through this path, then failed every upload
      // (mem0 rejected it with HTTP 400) and every embedding request.
      const clamped = clampMemory(memory, id);
      store.memories[id] = {
        id,
        memory: clamped.text,
        created_at: now,
        updated_at: now,
        source: "local",
        // The replay payload carries the clamped text, so the upload mem0 accepts
        // matches what the mirror holds.
        addPayload: { ...queryScope, ...addPayload, memory: clamped.text, messages: undefined },
        ...(clamped.overflow ? { overflow: clamped.overflow } : {}),
      } as LocalMemory;
      if (clamped.overflow) store.stats.harvestDropped = (store.stats.harvestDropped ?? 0) + 1;
      return { message: "Memory stored locally (mem0 API unavailable).", id, status: "PENDING" };
    }
    case "write-update": {
      const id = req.memoryId ?? "";
      let text: string | undefined;
      try {
        const body = JSON.parse(req.bodyText ?? "{}") as { text?: string };
        text = body.text;
      } catch {
        /* ignore */
      }
      const existing = store.memories[id];
      if (existing) {
        if (text !== undefined) existing.memory = text;
        existing.updated_at = now;
        // source stays as-is: a mirrored (observed) memory updated offline is
        // carried to the cloud by the queued op below, not by an add replay.
        if (!id.startsWith("local-")) {
          store.ops.push({ kind: "write-update", memoryId: id, bodyText: req.bodyText, at: Date.now() });
        }
        // local-* memories fold the edit into their pending add replay.
      } else {
        store.memories[id] = { id, memory: text ?? "", created_at: now, updated_at: now, source: "local" };
      }
      return { message: "Memory updated locally (mem0 API unavailable).", id };
    }
    case "write-delete": {
      const id = req.memoryId ?? "";
      if (store.memories[id]) {
        store.memories[id].deleted = true;
        // The deletion carries a timestamp of its own. Without it a concurrent
        // update is strictly newer, so the merge reinstates the live record and
        // the mirror serves a memory the user deleted until the op replays.
        store.memories[id].updated_at = now;
      }
      // Cloud ids queue a delete op even when never mirrored — the intent must
      // reach the server. local-* ids purge at sync without ever uploading.
      if (!id.startsWith("local-")) {
        store.ops.push({ kind: "write-delete", memoryId: id, at: Date.now() });
      }
      return { message: "Memory deleted locally (mem0 API unavailable)." };
    }
    case "write-delete-all": {
      for (const m of Object.values(store.memories)) {
        m.deleted = true;
        m.updated_at = now;
      }
      store.ops.push({ kind: "write-delete-all", query: req.url.search, at: Date.now() });
      return { message: "Memories deleted locally (mem0 API unavailable)." };
    }
    default:
      return { message: "Handled locally (mem0 API unavailable)." };
  }
}

/** Propagate a confirmed-remote write into the mirror: delete/update/
 *  delete-all leave no harvestable trace in the response body, so without
 *  this echo the mirror would keep serving the mutated/deleted memories. */
export function applyRemoteWriteEcho(store: Store, req: ClassifiedRequest): void {
  const now = new Date().toISOString();
  if (req.kind === "write-update" && req.memoryId) {
    const id = req.memoryId;
    let text: string | undefined;
    try {
      const body = JSON.parse(req.bodyText ?? "{}") as { text?: unknown };
      if (typeof body.text === "string") text = body.text;
    } catch {
      /* ignore */
    }
    const existing = store.memories[id];
    if (existing) {
      if (text !== undefined) existing.memory = text;
      existing.updated_at = now;
    } else if (text !== undefined) {
      store.memories[id] = { id, memory: text, created_at: now, updated_at: now, source: "observed" };
    }
  } else if (req.kind === "write-delete" && req.memoryId) {
    const m = store.memories[req.memoryId];
    if (m) m.deleted = true;
  } else if (req.kind === "write-delete-all") {
    for (const m of Object.values(store.memories)) m.deleted = true;
  }
}

/** A confirmed-remote mutation carries newer state than any op queued offline
 *  for the same target; queued ops for it would replay stale intents. */
export function reconcileOps(store: Store, req: ClassifiedRequest): void {
  if (req.kind === "write-delete-all") {
    store.ops = [];
  } else if ((req.kind === "write-update" || req.kind === "write-delete") && req.memoryId) {
    const id = req.memoryId;
    store.ops = store.ops.filter((o) => o.memoryId !== id);
  }
}
