import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the official AaveKit API needs no key).
export async function GET() {
  return NextResponse.json({
    name: "aave-mcp-free",
    upstream: "AaveKit GraphQL API — the official Aave v4 API (api.v4.aave.com/graphql)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "markets", description: "Aave v4 hubs + spokes: TVL, utilization, which markets exist." },
      { name: "reserves", description: "Pool list with live supply/borrow APYs, caps, collateral factors — filterable by spoke or symbol." },
      { name: "portfolio", description: "Full account view for an address: positions, supplies with earned interest, borrows, health factor, borrowing power." },
      { name: "balances", description: "Aave-listed tokens a wallet holds, with the best available supply APY for each." },
      { name: "activities", description: "Supply/borrow/repay/withdraw history for an address." },
      { name: "preview", description: "Simulate an action first: health factor now vs after, borrowing power, rates — nothing built or signed." },
      { name: "build_supply", description: "Prepare an unsigned supply (deposit) transaction — approve step included when allowance is short." },
      { name: "build_withdraw", description: "Prepare an unsigned withdraw transaction (partial or max)." },
      { name: "build_borrow", description: "Prepare an unsigned borrow transaction against supplied collateral." },
      { name: "build_repay", description: "Prepare an unsigned repay transaction (partial or full) — approve step included when needed." },
      { name: "build_collateral_toggle", description: "Prepare an unsigned transaction enabling/disabling a supplied token as collateral." },
      { name: "check_transaction", description: "Confirm a sent transaction has been indexed by Aave (completes multi-step flows)." },
      { name: "graphql_query", description: "Read-only escape hatch to the full AaveKit query surface (allowlisted root fields)." },
    ],
    safety:
      "Signature-free by construction — the AaveKit API only reads state and PREPARES calldata; build_* tools return unsigned {to,data,value,chainId} transactions for the USER's wallet to sign. No keys held, nothing submitted. Account data is public-by-address; the connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
