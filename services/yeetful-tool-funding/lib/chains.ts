// The chains the funding planner scans and plans across — the intersection
// of Yeetful's first-class chains and NEAR Intents' buildable EVM origins.
// Robinhood Chain (4663) is deliberately absent: its funding rides the LiFi
// plan on the robinhood MCP, not intents legs.
//
// KEYLESS by design: balance reads go to publicnode RPCs (viem's default
// public endpoints 429 in bursts — probed live 2026-07-16 when a rate-limited
// Base RPC hid a $15k balance), and the ETH/USD probe is one QuoterV2
// staticcall on Base. Importers need no API key to call this service.

import { createPublicClient, http, type PublicClient } from "viem";
import { base, arbitrum, mainnet } from "viem/chains";

export interface FundingChain {
  chainId: number;
  /** The word NEAR Intents' build_swap + Yeetful's chat grammar accept. */
  word: string;
  key: string;
  usdc: { address: `0x${string}`; decimals: number };
  /** ETH kept back on a SOURCE chain so the transfer itself can be signed. */
  gasReserveEth: number;
  /** Minimum native ETH before an ERC-20 source on this chain is signable. */
  minGasToSendEth: number;
  /** Native ETH the DESTINATION wallet needs to sign a follow-up action. */
  destGasFloorEth: number;
}

export const FUNDING_CHAINS: FundingChain[] = [
  {
    chainId: 8453,
    word: "Base",
    key: "base",
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    gasReserveEth: 0.0002,
    minGasToSendEth: 0.00003,
    destGasFloorEth: 0.0002,
  },
  {
    chainId: 42161,
    word: "Arbitrum",
    key: "arbitrum",
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    gasReserveEth: 0.0002,
    minGasToSendEth: 0.00003,
    destGasFloorEth: 0.0002,
  },
  {
    chainId: 1,
    word: "Ethereum",
    key: "ethereum",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    gasReserveEth: 0.002,
    minGasToSendEth: 0.001,
    destGasFloorEth: 0.003,
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
    // viem's chain-parameterized client vs the bare PublicClient type — the
    // usual generic mismatch; the cast is the documented escape hatch.
    client = createPublicClient({ chain, transport: http(RPC[chainId]) }) as unknown as PublicClient;
    clients.set(chainId, client);
  }
  return client;
}

export function fundingChainOf(input: string | number): FundingChain | null {
  const raw = String(input).trim().toLowerCase();
  return (
    FUNDING_CHAINS.find(
      (c) => String(c.chainId) === raw || c.key === raw || c.word.toLowerCase() === raw || (raw === "eth" && c.chainId === 1) || (raw === "mainnet" && c.chainId === 1) || (raw === "arb" && c.chainId === 42161),
    ) ?? null
  );
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

/** USD per 1 ETH via Uniswap v3 WETH→USDC on Base (best of the two liquid
 *  fee tiers). Null when the probe fails — callers refuse to plan blind. */
export async function ethUsd(): Promise<number | null> {
  const client = clientFor(8453);
  if (!client) return null;
  const usdc = FUNDING_CHAINS[0].usdc;
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
