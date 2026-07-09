import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the 1Click JWT is a server-side env that
// waives 1Click's keyless 0.2% fee; callers never need a key).
export async function GET() {
  return NextResponse.json({
    name: "near-intents-mcp-free",
    upstream: "NEAR Intents 1Click API — the official cross-chain intents swap API (1click.chaindefuser.com)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "how_it_works", description: "The full swap flow (quote → deposit → settle → verify), supported origin chains, and safety rules — start here." },
      { name: "chains", description: "Every supported blockchain with token counts and whether deposits can be built there (EVM) or quote-only." },
      { name: "tokens", description: "Search the supported-asset list by chain/symbol — assetId, contract, decimals, live USD price." },
      { name: "quote", description: "Dry-run preview of any cross-chain swap: expected output, minimum after slippage, fees, ETA. Commits nothing." },
      { name: "build_swap", description: "Execute: real quote + one-time deposit address + the single unsigned transfer the user signs. Solvers deliver on the destination chain automatically." },
      { name: "submit_deposit_tx", description: "Notify 1Click of the confirmed deposit transaction hash for instant pickup." },
      { name: "check_status", description: "One status poll by deposit address — state explained, both chains' tx hashes with explorer links." },
      { name: "await_completion", description: "Watch a swap (≤45s per call) until SUCCESS / REFUNDED / FAILED, then report the outcome." },
    ],
    safety:
      "Signature-free by construction — 1Click prices swaps and issues one-time deposit addresses; build_swap returns an unsigned {to,data,value,chainId} transfer for the USER's wallet to sign, and unfillable swaps auto-refund to the origin address. No keys held, nothing submitted. The connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
