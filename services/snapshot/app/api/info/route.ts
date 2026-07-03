import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is the FREE sibling of x402-services/snapshot.
export async function GET() {
  return NextResponse.json({
    name: "snapshot-mcp-free",
    upstream: "Snapshot (hub.snapshot.org)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "list_proposals", description: "Recent DAO proposals (filter by space + state)." },
      { name: "get_proposal", description: "Full detail for one proposal." },
      { name: "list_votes", description: "Votes cast on a proposal, by voting power." },
      { name: "get_space", description: "DAO space metadata." },
      { name: "list_spaces", description: "Browse DAO spaces." },
      { name: "prepare_vote", description: "Build the EIP-712 vote for the user to sign." },
      { name: "submit_vote", description: "Relay a user-signed vote to the Snapshot sequencer." },
    ],
    safety:
      "The vote is an EIP-712 message signed by the VOTER's own wallet — the server never signs, never holds keys. Designed to flow into Yeetful's guardrail + sign pipeline.",
  });
}
