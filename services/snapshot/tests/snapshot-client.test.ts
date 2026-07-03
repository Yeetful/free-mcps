import { describe, it, expect } from "vitest";
import { snapshotQuery, queries, fetchProposalForVote, type SnapshotOpts } from "@/lib/snapshot";

const GRAPHQL = "https://hub.snapshot.org/graphql";

// A fake fetch that records calls and returns a canned GraphQL response.
function recordingFetch(response: { status?: number; body?: unknown; bodyText?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = response.bodyText ?? JSON.stringify(response.body ?? { data: {} });
    return new Response(text, { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function optsWith(response: Parameters<typeof recordingFetch>[0]) {
  const { impl, calls } = recordingFetch(response);
  const opts: SnapshotOpts = { fetchImpl: impl };
  return { opts, calls };
}

function bodyOf(init: RequestInit) {
  return JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
}

describe("snapshot client — request construction (no network)", () => {
  it("posts to the hub graphql endpoint with content-type json", async () => {
    const { opts, calls } = optsWith({ body: { data: {} } });
    await snapshotQuery("{ __typename }", undefined, opts);
    expect(calls[0].url).toBe(GRAPHQL);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("sends the optional api key as x-api-key only when present", async () => {
    const withKey = optsWith({ body: { data: {} } });
    await snapshotQuery("{ __typename }", undefined, { ...withKey.opts, apiKey: "k-123" });
    expect((withKey.calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("k-123");

    const noKey = optsWith({ body: { data: {} } });
    await snapshotQuery("{ __typename }", undefined, noKey.opts);
    expect((noKey.calls[0].init.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
  });

  it("listProposals: builds where{space_in,state} + first variables", async () => {
    const { opts, calls } = optsWith({ body: { data: { proposals: [] } } });
    await queries.listProposals({ space: "aave.eth", state: "active", first: 5 }, opts);
    const { query, variables } = bodyOf(calls[0].init);
    expect(query).toContain("proposals(");
    expect(variables).toEqual({ first: 5, where: { space_in: ["aave.eth"], state: "active" } });
  });

  it("listProposals: empty where when no filters, default first 10", async () => {
    const { opts, calls } = optsWith({ body: { data: { proposals: [] } } });
    await queries.listProposals({}, opts);
    expect(bodyOf(calls[0].init).variables).toEqual({ first: 10, where: {} });
  });

  it("getProposal / listVotes / getSpace / listSpaces pass their args", async () => {
    const gp = optsWith({ body: { data: { proposal: {} } } });
    await queries.getProposal("0xabc", gp.opts);
    expect(bodyOf(gp.calls[0].init).variables).toEqual({ id: "0xabc" });

    const lv = optsWith({ body: { data: { votes: [] } } });
    await queries.listVotes("0xabc", 7, lv.opts);
    expect(bodyOf(lv.calls[0].init).variables).toEqual({ proposal: "0xabc", first: 7 });

    const gs = optsWith({ body: { data: { space: {} } } });
    await queries.getSpace("ens.eth", gs.opts);
    expect(bodyOf(gs.calls[0].init).variables).toEqual({ id: "ens.eth" });

    const ls = optsWith({ body: { data: { spaces: [] } } });
    await queries.listSpaces(undefined, ls.opts);
    expect(bodyOf(ls.calls[0].init).variables).toEqual({ first: 20 });
  });
});

describe("snapshot client — response handling", () => {
  it("unwraps the graphql `data` field on success", async () => {
    const { opts } = optsWith({ body: { data: { proposals: [{ id: "0x1" }] } } });
    const r = await queries.listProposals({}, opts);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ proposals: [{ id: "0x1" }] });
  });

  it("surfaces graphql errors as a non-ok result", async () => {
    const { opts } = optsWith({ body: { errors: [{ message: "bad field" }] } });
    const r = await snapshotQuery("{ nope }", undefined, opts);
    expect(r.ok).toBe(false);
    expect(r.data).toEqual({ errors: [{ message: "bad field" }] });
  });

  it("truncates oversized payloads to a safe raw string", async () => {
    const big = { data: { rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "xxxxxxxx" })) } };
    const { opts } = optsWith({ body: big });
    const r = await snapshotQuery("{ rows }", undefined, opts);
    expect(r.truncated).toBe(true);
    const data = r.data as { note: string; preview: string };
    expect(data.note).toMatch(/truncated/i);
    expect(data.preview.length).toBeLessThanOrEqual(24_000);
  });

  it("fetchProposalForVote returns the proposal or throws when missing", async () => {
    const found = optsWith({
      body: { data: { proposal: { id: "0xabc", type: "basic", state: "active", choices: ["For", "Against"], space: { id: "x.eth" }, title: "T", end: 1 } } },
    });
    const p = await fetchProposalForVote("0xabc", found.opts);
    expect(p.type).toBe("basic");
    expect(p.space.id).toBe("x.eth");

    const missing = optsWith({ body: { data: { proposal: null } } });
    await expect(fetchProposalForVote("0xnope", missing.opts)).rejects.toThrow(/not found/i);
  });
});
