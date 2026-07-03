// ─────────────────────────────────────────────────────────────────────────
//  Base-chain wiring: Uniswap deployment addresses + a shared viem client +
//  the minimal ABIs this service calls. Everything here is verified two ways:
//  the addresses come from developers.uniswap.org (v3 + v4 Base deployment
//  pages, fetched 2026-07-02) AND `npm run smoke` probes each one live before
//  a deploy is called done.
// ─────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

export const CHAIN_ID = 8453;

/** Uniswap v3 on Base (developers.uniswap.org/contracts/v3/reference/deployments/base-deployments). */
export const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
export const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
export const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;

/** Uniswap v4 on Base (developers.uniswap.org/contracts/v4/deployments) — read-only in v1. */
export const V4_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b" as const;
export const V4_STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" as const;
export const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d" as const;

export const WETH = "0x4200000000000000000000000000000000000006" as const;

/** v3 fee tiers (hundredths of a bip) and v4's canonical tick spacings. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

// Inferred type (not the exported PublicClient) — the workspace hoists two
// viem copies (ours + the x402 packages') whose nominal types don't unify.
let client: ReturnType<typeof makeClient> | null = null;

function makeClient() {
  return createPublicClient({
    chain: base,
    // Multicall batching: the per-tier pool probes (getPool/slot0/liquidity ×
    // 4 tiers × v3+v4) collapse into one or two Multicall3 aggregates instead
    // of a dozen eth_calls — which is what keeps the PUBLIC Base RPC from
    // rate-limiting us. Quoter simulations can't batch (state-mutating) and
    // stay individual.
    batch: { multicall: { wait: 16 } },
    transport: http(process.env.BASE_RPC_URL || undefined, {
      retryCount: 3,
      retryDelay: 300,
    }),
  });
}

/** Shared Base RPC client. BASE_RPC_URL overrides the public endpoint. */
export function rpc() {
  if (!client) client = makeClient();
  return client;
}

/**
 * Retry a read when the free RPC rate-limits. The limiter answers with a
 * JSON-RPC error (not an HTTP failure), which viem's transport retry does NOT
 * retry — so resilience has to live here. Real reverts / unknown errors are
 * rethrown immediately.
 */
export async function readRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "";
      if (!/rate limit|429|RPC Request failed|timeout/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Minimal ABIs (only the functions we call) ───────────────────────────────

export const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable", // simulated via eth_call; never sent
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const V3_FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

export const V3_POOL_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

/** SwapRouter02: exactInputSingle has NO deadline field — the deadline rides
 *  the multicall wrapper. That's a v2-router change people trip on. */
export const SWAP_ROUTER_02_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

export const ERC20_ABI = [
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

export const WETH_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

export const V4_STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;
