import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is the FREE sibling of x402-services/uniswap.
export async function GET() {
  return NextResponse.json({
    name: "uniswap-mcp-free",
    upstream: "Uniswap v3 + v4 contracts on Base, read directly over RPC (no API key, no indexer)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "quote", description: "Live exact-in quote across every v3 fee tier (QuoterV2)." },
      { name: "price", description: "Spot price from the most liquid v3 pool." },
      { name: "pool_info", description: "v3 pools per tier + canonical hookless v4 pools (StateView)." },
      { name: "build_swap", description: "Deterministic swap tx to sign: fresh quote → min-out → SwapRouter02 calldata + approve step + dry-run." },
      { name: "build_wrap", description: "ETH → WETH deposit tx." },
      { name: "build_unwrap", description: "WETH → ETH withdraw tx." },
      { name: "convert_amount", description: "Human amount ↔ atoms with real on-chain decimals." },
      { name: "read_contract", description: "Escape hatch: one guarded read-only eth_call against any Base contract (balances, allowances, pool state, exact-output quotes) — payable refused, responses truncated." },
    ],
    safety:
      "Builds only — never holds keys, never signs, never submits. Swap recipient is always the payer. Designed to flow into Yeetful's guardrail + sign pipeline.",
  });
}
