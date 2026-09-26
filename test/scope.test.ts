import { describe, expect, it } from "vitest";
import { extractScope, matchesScope, type ScopeFilters } from "../src/recall/scope.js";

describe("extractScope", () => {
  it("pulls the four entity keys out of a read body's filters", () => {
    const body = JSON.stringify({ filters: { user_id: "artrix", app_id: "artrix-reach", run_id: "r1" } });
    expect(extractScope(body)).toEqual({ user_id: "artrix", app_id: "artrix-reach", run_id: "r1" });
  });

  it("ignores unrelated filter keys", () => {
    const body = JSON.stringify({ filters: { user_id: "artrix", created_at: { gte: "2026-01-01" } } });
    expect(extractScope(body)).toEqual({ user_id: "artrix" });
  });

  it("drops \"*\" wildcards, which mean unconstrained (mem0ai/mem0#6168)", () => {
    const body = JSON.stringify({ filters: { user_id: "artrix", app_id: "*", agent_id: "*" } });
    expect(extractScope(body)).toEqual({ user_id: "artrix" });
  });

  it("returns undefined for a body with no filters", () => {
    expect(extractScope(JSON.stringify({ query: "x" }))).toBeUndefined();
  });

  it("returns undefined for a non-JSON body", () => {
    expect(extractScope("not json")).toBeUndefined();
    expect(extractScope(undefined)).toBeUndefined();
  });

  it("ignores non-string filter values", () => {
    const body = JSON.stringify({ filters: { app_id: ["a", "b"], user_id: "artrix" } });
    expect(extractScope(body)).toEqual({ user_id: "artrix" });
  });

  it("returns undefined when every entity filter is a wildcard", () => {
    expect(extractScope(JSON.stringify({ filters: { app_id: "*", user_id: "*" } }))).toBeUndefined();
  });
});

describe("matchesScope", () => {
  const mem = (scope: Record<string, unknown>) => scope;

  it("matches when every requested key matches the memory", () => {
    expect(matchesScope(mem({ user_id: "artrix", app_id: "r" }), { user_id: "artrix", app_id: "r" })).toBe(true);
  });

  it("rejects a memory from a different app", () => {
    expect(matchesScope(mem({ user_id: "artrix", app_id: "other" }), { user_id: "artrix", app_id: "r" })).toBe(false);
  });

  it("rejects a memory from a different user", () => {
    expect(matchesScope(mem({ user_id: "someone" }), { user_id: "artrix" })).toBe(false);
  });

  it("treats a missing memory field as a match only when the filter is absent", () => {
    // A memory with no app_id cannot answer a request that scopes to an app.
    expect(matchesScope(mem({}), { app_id: "r" })).toBe(false);
    expect(matchesScope(mem({}), { user_id: "artrix" })).toBe(false);
  });

  it("matches everything when the request is unscoped", () => {
    expect(matchesScope(mem({ app_id: "r" }), undefined as ScopeFilters | undefined)).toBe(true);
    expect(matchesScope(mem({}), {})).toBe(true);
  });

  it("matches a null-valued memory field when the request does not scope that key", () => {
    // Global-scope writes store app_id: null; a request scoping only user_id
    // must still see them.
    expect(matchesScope(mem({ app_id: null, user_id: "artrix" }), { user_id: "artrix" })).toBe(true);
  });

  it("normalizes undefined and null memory values to absent", () => {
    expect(matchesScope(mem({ app_id: undefined }), { app_id: "r" })).toBe(false);
    expect(matchesScope(mem({ app_id: undefined }), {})).toBe(true);
  });
});
