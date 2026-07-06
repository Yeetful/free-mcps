import { describe, it, expect } from "vitest";
import { guardQuery, ALLOWED_ROOT_FIELDS } from "@/lib/graphql-guard";
import { queries, type SnapshotOpts } from "@/lib/snapshot";

function recordingFetch(responses: { body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = responses[Math.min(i++, responses.length - 1)].body ?? { data: {} };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function bodyOf(init: RequestInit) {
  return JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
}

describe("graphql-guard — what passes", () => {
  it("accepts a plain read query on an allowlisted root field", () => {
    expect(guardQuery(`{ proposals(first: 5) { id title } }`)).toEqual({ ok: true });
  });

  it("accepts a named operation with variables (the follows example)", () => {
    const q = `query($f: String!) { follows(where: { follower: $f }) { space { id name } created } }`;
    expect(guardQuery(q, { f: "0xabc" })).toEqual({ ok: true });
  });

  it("accepts multiple allowlisted root fields in one query", () => {
    expect(guardQuery(`{ spaces(first: 3) { id } proposals(first: 3) { id } }`)).toEqual({ ok: true });
  });

  it("accepts first ≤ 100, literal or via variables", () => {
    expect(guardQuery(`{ votes(first: 100, where: { proposal: "0x1" }) { id } }`)).toEqual({ ok: true });
    expect(guardQuery(`query($n: Int!) { votes(first: $n) { id } }`, { n: 100 })).toEqual({ ok: true });
  });
});

describe("graphql-guard — what's rejected", () => {
  const errOf = (q: string, v?: Record<string, unknown>) => {
    const r = guardQuery(q, v);
    return r.ok ? null : r.error;
  };

  it("rejects mutations and subscriptions (read-only)", () => {
    expect(errOf(`mutation { anything }`)).toMatch(/read-only/i);
    expect(errOf(`subscription { anything }`)).toMatch(/read-only/i);
  });

  it("rejects multiple operations", () => {
    expect(errOf(`query A { proposals { id } } query B { spaces { id } }`)).toMatch(/one operation/i);
  });

  it("rejects fragment definitions and spreads", () => {
    expect(errOf(`query { proposals { ...F } } fragment F on Proposal { id }`)).toMatch(/fragment/i);
    expect(errOf(`{ ...F }`)).toMatch(/fragment/i);
  });

  it("rejects non-allowlisted root fields, naming the available ones", () => {
    const err = errOf(`{ secrets { key } }`);
    expect(err).toMatch(/not exposed/i);
    expect(err).toContain("proposals");
  });

  it("rejects introspection but allows __typename", () => {
    expect(errOf(`{ __schema { types { name } } }`)).toMatch(/introspection/i);
    expect(guardQuery(`{ __typename proposals(first: 1) { id } }`)).toEqual({ ok: true });
  });

  it("rejects first > 100, literal or via variables", () => {
    expect(errOf(`{ proposals(first: 5000) { id } }`)).toMatch(/max of 100/i);
    expect(errOf(`query($n: Int!) { proposals(first: $n) { id } }`, { n: 500 })).toMatch(/max of 100/i);
  });

  it("rejects over-deep and oversized queries, and syntax errors", () => {
    // depth 7: a > b > c > d > e > f > g
    expect(errOf(`{ proposals { space { strategies { params { a { b { c } } } } } } }`)).toMatch(/depth/i);
    expect(errOf(`{ proposals(first: 1) { ${"id ".repeat(2000)} } }`)).toMatch(/chars/i);
    expect(errOf(`{ proposals( { id }`)).toMatch(/syntax/i);
  });

  it("allowlist stays governance-shaped (sanity pin)", () => {
    for (const f of ["proposals", "votes", "spaces", "follows", "vp", "users"]) {
      expect(ALLOWED_ROOT_FIELDS.has(f)).toBe(true);
    }
  });
});

describe("listProposals follower join (no network)", () => {
  const FOLLOWS = {
    body: { data: { follows: [{ space: { id: "aave.eth" } }, { space: { id: "ens.eth" } }, { space: { id: "aave.eth" } }] } },
  };

  it("resolves followed spaces then scopes proposals to space_in (deduped)", async () => {
    const { impl, calls } = recordingFetch([FOLLOWS, { body: { data: { proposals: [{ id: "0x1" }] } } }]);
    const opts: SnapshotOpts = { fetchImpl: impl };
    const r = await queries.listProposals({ follower: "0x" + "a".repeat(40), state: "active" }, opts);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0].init).query).toContain("follows(");
    expect(bodyOf(calls[1].init).variables).toEqual({
      first: 10,
      where: { state: "active", space_in: ["aave.eth", "ens.eth"] },
    });
  });

  it("returns an honest empty result when the address follows nothing", async () => {
    const { impl, calls } = recordingFetch([{ body: { data: { follows: [] } } }]);
    const r = await queries.listProposals({ follower: "0x" + "b".repeat(40) }, { fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1); // never fires the proposals query
    expect(r.data).toMatchObject({ proposals: [], note: expect.stringMatching(/follows no spaces/i) });
  });

  it("intersects follower scope with an explicit space filter", async () => {
    const { impl, calls } = recordingFetch([FOLLOWS, { body: { data: { proposals: [] } } }]);
    await queries.listProposals({ follower: "0x" + "c".repeat(40), space: "ens.eth" }, { fetchImpl: impl });
    expect(bodyOf(calls[1].init).variables.where).toEqual({ space_in: ["ens.eth"] });

    const miss = recordingFetch([FOLLOWS]);
    const r = await queries.listProposals(
      { follower: "0x" + "c".repeat(40), space: "not-followed.eth" },
      { fetchImpl: miss.impl },
    );
    expect(miss.calls).toHaveLength(1);
    expect(r.data).toMatchObject({ proposals: [], note: expect.stringMatching(/does not follow/i) });
  });

  it("propagates a failed follows lookup instead of querying unscoped", async () => {
    const { impl, calls } = recordingFetch([{ body: { errors: [{ message: "rate limited" }] } }]);
    const r = await queries.listProposals({ follower: "0x" + "d".repeat(40) }, { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
