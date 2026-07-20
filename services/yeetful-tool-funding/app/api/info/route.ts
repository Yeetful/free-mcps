import { NextResponse } from "next/server";
import { loadX402DoorConfig } from "@yeetful/mcp-kit/x402";

// Free, unauthenticated discovery surface — what this service is. TWO front
// doors serve the IDENTICAL tool surface (keyless by design — publicnode RPCs
// + one QuoterV2 staticcall; callers never need a key either):
//   /mcp       free, per-IP rate limited
//   /paid/mcp  x402 pay-per-call, no throttle (only advertised when the
//              deployment actually has a pay-to wallet configured)
export async function GET() {
  const paidDoor = loadX402DoorConfig();
  return NextResponse.json({
    name: "yeetful-tool-funding",
    upstream: "publicnode RPCs (Base/Arbitrum/Ethereum) + Uniswap v3 QuoterV2 on Base for ETH/USD",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    paidDoor: paidDoor
      ? {
          mcpEndpoint: "/paid/mcp",
          model: "x402 v2 pay-per-call (USDC), no rate limit, same tools",
          priceUsd: paidDoor.priceUsd,
        }
      : null,
    tools: ["fund_and_build", "plan_funding", "scan_funding_sources", "eth_price", "chains"],
    safety:
      "Construction-only: reads balances and prices, emits ordered funding legs for the NEAR Intents MCP to build under its own deposit-address guard. Cannot sign, submit, or move funds.",
  });
}
