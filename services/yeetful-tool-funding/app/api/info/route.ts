import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (keyless by design — publicnode RPCs +
// one QuoterV2 staticcall; callers never need a key either).
export async function GET() {
  return NextResponse.json({
    name: "yeetful-tool-funding",
    upstream: "publicnode RPCs (Base/Arbitrum/Ethereum) + Uniswap v3 QuoterV2 on Base for ETH/USD",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: ["plan_funding", "scan_funding_sources", "eth_price", "chains"],
    safety:
      "Construction-only: reads balances and prices, emits ordered funding legs for the NEAR Intents MCP to build under its own deposit-address guard. Cannot sign, submit, or move funds.",
  });
}
