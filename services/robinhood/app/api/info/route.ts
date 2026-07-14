import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (public RPC reads + Chainlink + Morpho's
// public API need no key).
export async function GET() {
  return NextResponse.json({
    name: "robinhood-mcp-free",
    upstream:
      "Robinhood Chain (chain id 4663, Arbitrum Orbit L2) — tokenized stock/ETF contracts and Chainlink feeds read via public RPC, Morpho lending markets (blue-api.morpho.org discovery + on-chain state), Uniswap v4 quoter, and the canonical Arbitrum bridge contracts",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "chain_info", description: "Chain facts: stack, RPC/explorer, and where trading (Uniswap v4), lending (Morpho), and the bridge live." },
      { name: "stock_tokens", description: "Directory of tokenized stocks/ETFs (AAPL, TSLA, SPY, …) + money tokens (USDG, USDe, WETH) with addresses and feeds." },
      { name: "token_info", description: "One token in depth: live Chainlink price, supply, corporate-action multiplier state (ERC-8056)." },
      { name: "prices", description: "Batch Chainlink USD prices — staleness-checked, corporate-action multiplier included." },
      { name: "portfolio", description: "Whole-wallet view: ETH + every known token with USD values and a total." },
      { name: "lending_markets", description: "Morpho markets: loan/collateral pair, supply & borrow APY, utilization, LLTV, size." },
      { name: "lending_position", description: "A wallet's Morpho position from on-chain state: supplied, collateral, debt with accrued interest, health factor." },
      { name: "build_lend", description: "Prepare unsigned supply transactions — lend an asset into a Morpho market (approve step when needed)." },
      { name: "build_supply_collateral", description: "Prepare unsigned collateral-posting transactions for a Morpho market." },
      { name: "build_borrow", description: "Prepare an unsigned borrow — fails closed on borrowing power, liquidity, and thin health factors." },
      { name: "build_repay", description: "Prepare unsigned repay transactions — 'max' clears the debt exactly by shares." },
      { name: "build_withdraw", description: "Prepare an unsigned withdrawal of supplied assets ('max' empties the position)." },
      { name: "build_withdraw_collateral", description: "Prepare an unsigned collateral withdrawal — refuses anything that would endanger outstanding debt." },
      { name: "quote", description: "Live Uniswap v4 swap quote (stocks quote against USDG) with a Chainlink divergence cross-check." },
      { name: "build_swap", description: "Prepare an unsigned guard-verified Uniswap v4 swap chain (exact-amount Permit2 approvals + one Universal Router call)." },
      { name: "bridge_info", description: "Canonical-bridge overview: routes, timing, contracts, and what needs the bridge UI." },
      { name: "build_bridge_deposit", description: "Prepare an unsigned L1 transaction bridging ETH into Robinhood Chain (arrives in minutes)." },
      { name: "build_bridge_withdraw", description: "Prepare an unsigned withdrawal start back to Ethereum (~7-day challenge period + L1 claim)." },
    ],
    safety:
      "Signature-free by construction — this service only reads public state and PREPARES calldata; build_* tools return unsigned {to,data,value,chainId} transactions for the USER's wallet to sign (bridge deposits are chainId 1, everything else 4663). Swap builds are re-decoded and guard-verified against the quote before they're returned; lending builds fail closed on health factor. No keys held, nothing submitted. The connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
