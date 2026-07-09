import { describe, it, expect } from "vitest";
import { guardQuery, ALLOWED_ROOT_FIELDS } from "@/lib/graphql-guard";

describe("graphql_query escape-hatch guard", () => {
  it("allows a simple read query on an allowlisted root field", () => {
    const r = guardQuery(`query($request: HubsRequest!) { hubs(request: $request) { name address } }`);
    expect(r.ok).toBe(true);
  });

  it("allows inline fragments (required for AaveKit unions)", () => {
    const r = guardQuery(
      `query($request: UserBalancesRequest!) {
        userBalances(request: $request) {
          balances { __typename ... on Erc20Amount { token { address } } }
        }
      }`,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects mutations", () => {
    const r = guardQuery(`mutation { anything }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/read-only/i);
  });

  it("rejects non-allowlisted root fields and names the allowlist", () => {
    const r = guardQuery(`query { supply(request: {}) { __typename } }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("build_*");
  });

  it("rejects introspection", () => {
    expect(guardQuery(`query { __schema { types { name } } }`).ok).toBe(false);
  });

  it("rejects fragment definitions", () => {
    const r = guardQuery(
      `query { hubs(request: {query:{chainIds:[1]}}) { ...H } } fragment H on Hub { name }`,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects more than one operation", () => {
    expect(guardQuery(`query { hubs(request: {}) { name } } query { chains(request: {}) { name } }`).ok).toBe(false);
  });

  it("rejects oversized queries", () => {
    const r = guardQuery(`query { hubs(request: {}) { ${"name ".repeat(2000)} } }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/chars/);
  });

  it("rejects over-deep selections", () => {
    const deep = `query { reserves(request: {}) { a { b { c { d { e { f { g { h { i } } } } } } } } } }`;
    expect(guardQuery(deep).ok).toBe(false);
  });

  it("rejects syntax errors legibly", () => {
    const r = guardQuery(`query { hubs(request { name }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });

  it("keeps transaction preparation OUT of the allowlist", () => {
    for (const field of ["supply", "borrow", "withdraw", "repay"]) {
      expect(ALLOWED_ROOT_FIELDS.has(field)).toBe(false);
    }
  });
});
