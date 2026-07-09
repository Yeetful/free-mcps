import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the Alchemy key is a server-side env;
// callers never need one).
export async function GET() {
  return NextResponse.json({
    name: "yeetful-tool-wallet",
    upstream: "Alchemy Data API + per-chain RPC (server-side key) across 9 top EVM chains",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "chains", description: "The covered chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Scroll, Gnosis)." },
      { name: "portfolio", description: "Every native + ERC-20 holding across the covered chains in one call, USD-priced, spam-filtered, sorted richest-first — returns a structured payload the Yeetful chat renders as a rich card." },
      { name: "gas_balances", description: "Native gas balance on every covered chain — 'do I have gas there?' before building a transaction." },
      { name: "token_balance", description: "One token's live balance on one chain — the precise post-transaction check." },
      { name: "recent_transactions", description: "Latest sent + received transfers across chains, merged newest-first with explorer links." },
      { name: "transaction_status", description: "CONFIRMED / REVERTED / pending for a tx hash, with confirmation count and explorer link." },
    ],
    safety:
      "Read-only by construction — every tool inspects public chain state via Alchemy; nothing here can sign, submit, or move funds. The connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
