import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (Lido's public APIs + public RPC reads
// need no key).
export async function GET() {
  return NextResponse.json({
    name: "lido-mcp-free",
    upstream:
      "Lido on Ethereum mainnet — official contracts (stETH, wstETH, Withdrawal Queue) read via public RPC, plus Lido's public APIs (eth-api.lido.fi APR, reward-history-backend.lido.fi earnings, wq-api.lido.fi queue wait times)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "stats", description: "Protocol snapshot: staking APR (7-day SMA + latest), total ETH staked, stETH↔wstETH rate, stake limit, withdrawal-queue state." },
      { name: "position", description: "Full Lido position for an address: stETH + wstETH balances, total staked value in ETH and USD, pending withdrawal requests." },
      { name: "earnings", description: "Staking earnings for an address from Lido's reward history: total rewards in stETH and USD, average APR, recent daily rebase events." },
      { name: "withdrawals", description: "Withdrawal requests for an address with per-request status (pending / finalized-claimable / claimed) plus the queue's current wait estimate." },
      { name: "convert", description: "Rate helper: convert an amount between ETH, stETH, and wstETH at the live on-chain rate." },
      { name: "build_stake", description: "Prepare an unsigned stake transaction — ETH into stETH (or straight to wstETH)." },
      { name: "build_wrap", description: "Prepare unsigned wrap transactions — stETH into wstETH (approve step included when allowance is short)." },
      { name: "build_unwrap", description: "Prepare an unsigned unwrap transaction — wstETH back to stETH." },
      { name: "build_request_withdrawal", description: "Prepare unsigned withdrawal-queue request transactions — stETH (or wstETH) into a claimable NFT; ETH arrives after finalization." },
      { name: "build_claim", description: "Prepare an unsigned claim transaction for every finalized withdrawal request an address holds — the ETH lands in their wallet." },
    ],
    safety:
      "Signature-free by construction — this service only reads public state and PREPARES calldata; build_* tools return unsigned {to,data,value,chainId} transactions for the USER's wallet to sign. No keys held, nothing submitted. Account data is public-by-address; the connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
