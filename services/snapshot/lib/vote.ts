// Snapshot off-chain vote = an EIP-712 typed-data message signed by the VOTER's
// own wallet (voting power is bound to the voter's address — the server never
// signs). This module builds the canonical typed data the user signs, then
// relays the signed envelope to the Snapshot sequencer.
//
// Canon verified against @snapshot-labs/snapshot.js (sign/types.ts + Client.vote):
//   domain = { name: "snapshot", version: "0.1.4" }   (no chainId/verifyingContract)
//   Vote struct fields: from, space, timestamp, proposal, choice, reason, app, metadata
//   The `choice` field TYPE depends on the proposal `type`:
//     single-choice | basic            → uint32        (1-indexed scalar)
//     approval      | ranked-choice     → uint32[]      (1-indexed list)
//     weighted      | quadratic         → string        (JSON weight map, e.g. {"1":1,"2":2})
//   The `proposal` field is bytes32 when the id is a 0x-hash (modern), else string.

export const SNAPSHOT_DOMAIN = { name: "snapshot", version: "0.1.4" } as const;
export const SNAPSHOT_SEQUENCER =
  process.env.SNAPSHOT_SEQUENCER_URL ?? "https://seq.snapshot.org";

export type SnapshotChoice = number | number[] | Record<string, number> | string;

type ChoiceSolidityType = "uint32" | "uint32[]" | "string";

function choiceTypeFor(proposalType: string): ChoiceSolidityType {
  if (proposalType === "approval" || proposalType === "ranked-choice") return "uint32[]";
  if (proposalType === "weighted" || proposalType === "quadratic") return "string";
  return "uint32"; // single-choice, basic, and any unknown scalar default
}

function proposalFieldType(id: string): "bytes32" | "string" {
  return /^0x[0-9a-fA-F]{64}$/.test(id) ? "bytes32" : "string";
}

/** Coerce a caller-supplied choice into the exact shape its choice type needs. */
function normalizeChoice(choice: SnapshotChoice, t: ChoiceSolidityType): number | number[] | string {
  if (t === "uint32") {
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1)
      throw new Error("single-choice/basic vote needs a 1-indexed integer `choice` (e.g. 1).");
    return choice;
  }
  if (t === "uint32[]") {
    if (!Array.isArray(choice) || choice.some((c) => !Number.isInteger(c) || c < 1))
      throw new Error("approval/ranked-choice vote needs a 1-indexed integer array `choice` (e.g. [1,3]).");
    return choice;
  }
  // weighted/quadratic → JSON string weight map
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) return JSON.stringify(choice);
  throw new Error('weighted/quadratic vote needs a weight map `choice` (e.g. {"1":1,"2":2}).');
}

// Common natural-language synonyms for the canonical For/Against/Abstain labels,
// so "yes"/"approve" resolve to a "For" choice etc.
const CHOICE_SYNONYMS: Record<string, string[]> = {
  for: ["for", "yes", "yea", "yay", "aye", "approve", "approved", "support", "in favor", "in favour"],
  against: ["against", "no", "nay", "reject", "rejected", "oppose", "opposed", "disapprove"],
  abstain: ["abstain", "abstention", "neutral"],
};

/** Map free-text choice → the 1-indexed value(s) the proposal expects. Pure. */
export function resolveChoiceLabel(
  text: string,
  choices: string[],
  proposalType: string,
): number | number[] {
  const wantsArray = proposalType === "approval" || proposalType === "ranked-choice";
  if (proposalType === "weighted" || proposalType === "quadratic") {
    throw new Error("Weighted/quadratic proposals need an explicit weight map, not a label.");
  }

  const matchOne = (raw: string): number => {
    const t = raw.trim().toLowerCase();
    // "option 2" / "choice 2" / bare "2" → that 1-indexed position.
    const numMatch = t.match(/^(?:option|choice|#)?\s*(\d+)$/);
    if (numMatch) {
      const n = Number(numMatch[1]);
      if (n >= 1 && n <= choices.length) return n;
      throw new Error(`Choice ${n} is out of range (1–${choices.length}).`);
    }
    // Exact (case-insensitive) label match.
    const exact = choices.findIndex((c) => c.toLowerCase().trim() === t);
    if (exact >= 0) return exact + 1;
    // Synonym → find the choice whose label belongs to the same synonym group.
    for (const syns of Object.values(CHOICE_SYNONYMS)) {
      if (!syns.includes(t)) continue;
      const idx = choices.findIndex((c) => syns.includes(c.toLowerCase().trim()));
      if (idx >= 0) return idx + 1;
    }
    // Substring fallback (e.g. "incentive" → "[DIP] Incentive program").
    const partial = choices.findIndex((c) => c.toLowerCase().includes(t) && t.length >= 3);
    if (partial >= 0) return partial + 1;
    throw new Error(`Could not match "${raw}" to a choice. Options: ${choices.join(", ")}.`);
  };

  if (wantsArray) {
    const parts = text.split(/\s*(?:,|and|\+|&)\s*/i).filter(Boolean);
    return parts.map(matchOne);
  }
  return matchOne(text);
}

export interface VoteTypedData {
  domain: typeof SNAPSHOT_DOMAIN;
  types: { Vote: { name: string; type: string }[] };
  primaryType: "Vote";
  message: {
    from: string;
    space: string;
    timestamp: number;
    proposal: string;
    choice: number | number[] | string;
    reason: string;
    app: string;
    metadata: string;
  };
}

export interface BuildVoteArgs {
  from: string;
  space: string;
  proposalId: string;
  proposalType: string;
  choice: SnapshotChoice;
  reason?: string;
  app?: string;
  metadata?: string;
  /** Unix seconds. Injectable for deterministic tests; defaults to now. */
  timestamp?: number;
}

/** Build the EIP-712 typed data the voter signs. Pure + deterministic given a timestamp. */
export function buildVoteTypedData(args: BuildVoteArgs): VoteTypedData {
  const choiceType = choiceTypeFor(args.proposalType);
  const propType = proposalFieldType(args.proposalId);
  return {
    domain: SNAPSHOT_DOMAIN,
    types: {
      Vote: [
        { name: "from", type: "address" },
        { name: "space", type: "string" },
        { name: "timestamp", type: "uint64" },
        { name: "proposal", type: propType },
        { name: "choice", type: choiceType },
        { name: "reason", type: "string" },
        { name: "app", type: "string" },
        { name: "metadata", type: "string" },
      ],
    },
    primaryType: "Vote",
    message: {
      from: args.from,
      space: args.space,
      timestamp: args.timestamp ?? Math.floor(Date.now() / 1000),
      proposal: args.proposalId,
      choice: normalizeChoice(args.choice, choiceType),
      reason: args.reason ?? "",
      app: args.app ?? "yeetful",
      metadata: args.metadata ?? "{}",
    },
  };
}

// ── Relay a user-signed vote to the Snapshot sequencer ───────────────────────
export interface SubmitVoteArgs {
  address: string; // voter
  sig: string; // EIP-712 signature of the typed data
  typedData: Pick<VoteTypedData, "domain" | "types" | "message"> & { primaryType?: string };
}

export interface SubmitVoteResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** POST { address, sig, data } to the sequencer. Injectable fetch for tests. */
export async function submitVote(
  args: SubmitVoteArgs,
  opts?: { fetchImpl?: typeof fetch },
): Promise<SubmitVoteResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const envelope = {
    address: args.address,
    sig: args.sig,
    data: {
      domain: args.typedData.domain,
      types: args.typedData.types,
      message: args.typedData.message,
    },
  };
  const res = await doFetch(SNAPSHOT_SEQUENCER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}
