import { describe, it, expect } from "vitest";
import { buildVoteTypedData, submitVote, resolveChoiceLabel, SNAPSHOT_DOMAIN } from "@/lib/vote";

const HASH = "0x" + "a".repeat(64); // a bytes32-shaped proposal id
const FROM = "0x1111111111111111111111111111111111111111";
const TS = 1_700_000_000;

function choiceField(td: ReturnType<typeof buildVoteTypedData>) {
  return td.types.Vote.find((f) => f.name === "choice")!.type;
}
function proposalField(td: ReturnType<typeof buildVoteTypedData>) {
  return td.types.Vote.find((f) => f.name === "proposal")!.type;
}

describe("buildVoteTypedData — EIP-712 type selection", () => {
  it("uses the canonical snapshot domain", () => {
    const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: 1, timestamp: TS });
    expect(td.domain).toEqual(SNAPSHOT_DOMAIN);
    expect(td.primaryType).toBe("Vote");
  });

  it("single-choice / basic → choice uint32, scalar message", () => {
    for (const type of ["single-choice", "basic"]) {
      const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: type, choice: 2, timestamp: TS });
      expect(choiceField(td)).toBe("uint32");
      expect(td.message.choice).toBe(2);
      expect(td.message.timestamp).toBe(TS);
      expect(td.message.app).toBe("yeetful");
    }
  });

  it("approval / ranked-choice → choice uint32[]", () => {
    for (const type of ["approval", "ranked-choice"]) {
      const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: type, choice: [1, 3], timestamp: TS });
      expect(choiceField(td)).toBe("uint32[]");
      expect(td.message.choice).toEqual([1, 3]);
    }
  });

  it("weighted / quadratic → choice string (JSON weight map)", () => {
    const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "weighted", choice: { "1": 1, "2": 2 }, timestamp: TS });
    expect(choiceField(td)).toBe("string");
    expect(td.message.choice).toBe('{"1":1,"2":2}');
  });

  it("proposal field is bytes32 for a hash id, string otherwise", () => {
    const hashTd = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: 1, timestamp: TS });
    expect(proposalField(hashTd)).toBe("bytes32");
    const strTd = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: "QmLegacyId", proposalType: "basic", choice: 1, timestamp: TS });
    expect(proposalField(strTd)).toBe("string");
  });

  it("rejects a malformed choice for the proposal type", () => {
    expect(() => buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: [1] as never, timestamp: TS })).toThrow();
    expect(() => buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "approval", choice: 1 as never, timestamp: TS })).toThrow();
    expect(() => buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: 0, timestamp: TS })).toThrow();
  });
});

describe("resolveChoiceLabel — free-text → 1-indexed choice", () => {
  const basic = ["For", "Against", "Abstain"];
  it("matches exact labels case-insensitively", () => {
    expect(resolveChoiceLabel("For", basic, "basic")).toBe(1);
    expect(resolveChoiceLabel("against", basic, "single-choice")).toBe(2);
    expect(resolveChoiceLabel("ABSTAIN", basic, "basic")).toBe(3);
  });
  it("maps synonyms (yes/no/approve/reject)", () => {
    expect(resolveChoiceLabel("yes", basic, "basic")).toBe(1);
    expect(resolveChoiceLabel("approve", basic, "basic")).toBe(1);
    expect(resolveChoiceLabel("no", basic, "basic")).toBe(2);
    expect(resolveChoiceLabel("reject", basic, "basic")).toBe(2);
  });
  it("parses option/number forms", () => {
    expect(resolveChoiceLabel("option 2", basic, "basic")).toBe(2);
    expect(resolveChoiceLabel("3", basic, "basic")).toBe(3);
  });
  it("approval/ranked → number[] from a label list", () => {
    const opts = ["Alpha", "Bravo", "Charlie"];
    expect(resolveChoiceLabel("Alpha, Charlie", opts, "approval")).toEqual([1, 3]);
    expect(resolveChoiceLabel("Bravo and Alpha", opts, "ranked-choice")).toEqual([2, 1]);
  });
  it("substring fallback", () => {
    expect(resolveChoiceLabel("incentive", ["Keep current", "Incentive program"], "basic")).toBe(2);
  });
  it("throws on no match, out-of-range, and weighted", () => {
    expect(() => resolveChoiceLabel("banana", basic, "basic")).toThrow();
    expect(() => resolveChoiceLabel("option 9", basic, "basic")).toThrow(/range/i);
    expect(() => resolveChoiceLabel("For", basic, "weighted")).toThrow(/weight/i);
  });
});

describe("submitVote — sequencer envelope", () => {
  it("POSTs { address, sig, data:{domain,types,message} } to the sequencer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "0xreceipt", ipfs: "Qm…" }), { status: 200 });
    }) as unknown as typeof fetch;

    const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: 1, timestamp: TS });
    const r = await submitVote({ address: FROM, sig: "0xdeadbeef", typedData: td }, { fetchImpl: impl });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: "0xreceipt", ipfs: "Qm…" });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.address).toBe(FROM);
    expect(sent.sig).toBe("0xdeadbeef");
    expect(sent.data.domain).toEqual(SNAPSHOT_DOMAIN);
    expect(sent.data.message.proposal).toBe(HASH);
    expect(sent.data.types.Vote).toBeTruthy();
  });

  it("returns ok:false when the sequencer rejects", async () => {
    const impl = (async () => new Response("bad sig", { status: 400 })) as unknown as typeof fetch;
    const td = buildVoteTypedData({ from: FROM, space: "x.eth", proposalId: HASH, proposalType: "basic", choice: 1, timestamp: TS });
    const r = await submitVote({ address: FROM, sig: "0x", typedData: td }, { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
