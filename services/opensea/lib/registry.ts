// ─────────────────────────────────────────────────────────────────────────
//  Pinned addresses + supported chains. Every pin here is verified live by
//  `pnpm smoke` (bytecode present, getCounter answers) before a deploy is
//  called done. The planner/model NEVER supplies these — asks reference
//  chains by OpenSea slug and the service resolves everything else.
//
//  Seaport 1.6 + the OpenSea conduit deploy at the SAME address on every
//  chain OpenSea supports (CREATE2), so the pins are chain-independent.
// ─────────────────────────────────────────────────────────────────────────

export type Address = `0x${string}`;

/** Seaport 1.6 — the only protocol this service builds against. */
export const SEAPORT_1_6: Address = "0x0000000000000068F116a894984e2DB1123eB395";

/** The OpenSea conduit NFT approvals are granted to (what setApprovalForAll targets). */
export const OPENSEA_CONDUIT: Address = "0x1E0049783F008A0085193E00003D00cd54003c71";

/** Conduit key stamped into every order so Seaport routes transfers through the conduit above. */
export const OPENSEA_CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000" as const;

/**
 * OpenSea's protocol fee wallet. The collections API returns required fees
 * with their recipients; submit_listing additionally allowlists THIS address
 * so a tampered consideration can't smuggle value to a stranger.
 */
export const OPENSEA_FEE_RECIPIENT: Address = "0x0000a26b00c1f0Df003000390027140000fAa719";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** Chains this service serves — the OpenSea slug is the tool-facing name. */
export interface OsChain {
  slug: "ethereum" | "base" | "arbitrum";
  chainId: number;
  name: string;
  rpcEnv: string;
  publicRpc: string;
  explorer: string;
}

export const CHAINS: OsChain[] = [
  {
    slug: "ethereum",
    chainId: 1,
    name: "Ethereum",
    rpcEnv: "ETH_RPC_URL",
    publicRpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
  },
  {
    slug: "base",
    chainId: 8453,
    name: "Base",
    rpcEnv: "BASE_RPC_URL",
    publicRpc: "https://base-rpc.publicnode.com",
    explorer: "https://basescan.org",
  },
  {
    slug: "arbitrum",
    chainId: 42161,
    name: "Arbitrum",
    rpcEnv: "ARBITRUM_RPC_URL",
    publicRpc: "https://arbitrum-one-rpc.publicnode.com",
    explorer: "https://arbiscan.io",
  },
];

export const CHAIN_SLUGS = CHAINS.map((c) => c.slug) as [OsChain["slug"], ...OsChain["slug"][]];

export function chainBySlug(slug: string): OsChain | null {
  return CHAINS.find((c) => c.slug === slug) ?? null;
}
