// Keyless multichain read layer — ported from services/yeetful-tool-funding/
// lib/chains.ts (the proven publicnode + QuoterV2 pattern; see that file for
// the 429 war story). Kept self-contained: fleet services stay thin and never
// import across app boundaries.

import { createPublicClient, http, type PublicClient } from "viem";
import { base, arbitrum, mainnet } from "viem/chains";

export interface ScanChain {
  chainId: number;
  word: string;
  key: string;
  usdc: { address: `0x${string}`; decimals: number };
  /** ETH kept back on a source chain so a transfer itself stays signable. */
  gasReserveEth: number;
  /** Minimum native ETH before an ERC-20 balance on this chain is movable. */
  minGasToSendEth: number;
}

export const SCAN_CHAINS: ScanChain[] = [
  {
    chainId: 8453,
    word: "Base",
    key: "base",
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    gasReserveEth: 0.0002,
    minGasToSendEth: 0.00003,
  },
  {
    chainId: 42161,
    word: "Arbitrum",
    key: "arbitrum",
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    gasReserveEth: 0.0002,
    minGasToSendEth: 0.00003,
  },
  {
    chainId: 1,
    word: "Ethereum",
    key: "ethereum",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    gasReserveEth: 0.002,
    minGasToSendEth: 0.001,
  },
];

const RPC: Record<number, string> = {
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  1: "https://ethereum-rpc.publicnode.com",
};

const VIEM_CHAINS = { 8453: base, 42161: arbitrum, 1: mainnet } as const;

const clients = new Map<number, PublicClient>();

export function clientFor(chainId: number): PublicClient | null {
  const chain = VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS];
  if (!chain) return null;
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({ chain, transport: http(RPC[chainId]) }) as unknown as PublicClient;
    clients.set(chainId, client);
  }
  return client;
}

// ── ETH/USD probe: one QuoterV2 staticcall on Base (keyless) ────────────────

const BASE_QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
const BASE_WETH = "0x4200000000000000000000000000000000000006" as const;

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
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

/** USD per 1 ETH via Uniswap v3 WETH→USDC on Base. Null when the probe
 *  fails — callers report ETH unpriced rather than guessing. */
export async function ethUsd(): Promise<number | null> {
  const client = clientFor(8453);
  if (!client) return null;
  const usdc = SCAN_CHAINS[0].usdc;
  let best = 0;
  for (const fee of [500, 3000]) {
    try {
      const { result } = await client.simulateContract({
        address: BASE_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: BASE_WETH, tokenOut: usdc.address, amountIn: BigInt(1e18), fee, sqrtPriceLimitX96: BigInt(0) }],
      });
      const out = Number(result[0]) / 10 ** usdc.decimals;
      if (out > best) best = out;
    } catch {
      /* tier has no pool / probe failed — try the next */
    }
  }
  return best > 0 ? best : null;
}
