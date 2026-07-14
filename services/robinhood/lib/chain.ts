// ─────────────────────────────────────────────────────────────────────────
//  RPC wiring + the minimal ABIs this service calls. Two clients:
//    · rpc()   — Robinhood Chain (4663). ROBINHOOD_RPC_URL overrides the
//                chain's public endpoint (rate-limited; Alchemy's
//                robinhood-mainnet slug is the production choice).
//    · l1Rpc() — Ethereum mainnet, used ONLY by the bridge deposit builder
//                (balance check + the L1 Inbox transaction target).
//  Every address probed live by `pnpm smoke` before a deploy is called done.
// ─────────────────────────────────────────────────────────────────────────

import { createPublicClient, defineChain, http } from "viem";
import { mainnet } from "viem/chains";
import { CHAIN_ID, EXPLORER, PUBLIC_RPC } from "./registry";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: "Robinhood Chain Explorer", url: EXPLORER } },
});

// Inferred types (not the exported PublicClient) — the workspace hoists
// multiple viem copies whose nominal types don't unify.
let client: ReturnType<typeof makeClient> | null = null;
let l1Client: ReturnType<typeof makeL1Client> | null = null;

function rpcUrl(): string {
  if (process.env.ROBINHOOD_RPC_URL) return process.env.ROBINHOOD_RPC_URL;
  if (process.env.ALCHEMY_API_KEY) return `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  return PUBLIC_RPC;
}

function makeClient() {
  return createPublicClient({
    chain: robinhoodChain,
    // Multicall batching: a portfolio read (~30 balanceOf + a dozen feeds)
    // collapses into a couple of Multicall3 aggregates instead of dozens of
    // eth_calls — which is what keeps the public RPC from rate-limiting us.
    batch: { multicall: { wait: 16 } },
    transport: http(rpcUrl(), { retryCount: 3, retryDelay: 300 }),
  });
}

function makeL1Client() {
  return createPublicClient({
    chain: mainnet,
    batch: { multicall: { wait: 16 } },
    // viem's default mainnet RPC (eth.merkle.io) 429s under light load —
    // default to publicnode instead (same lesson the lido sibling learned).
    transport: http(process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com", {
      retryCount: 3,
      retryDelay: 300,
    }),
  });
}

/** Shared Robinhood Chain client. */
export function rpc() {
  if (!client) client = makeClient();
  return client;
}

/** Shared Ethereum L1 client (bridge deposits only). */
export function l1Rpc() {
  if (!l1Client) l1Client = makeL1Client();
  return l1Client;
}

/** Test seams: replace or reset the shared clients. */
export function setRpcForTests(fake: unknown | null) {
  client = fake as ReturnType<typeof makeClient> | null;
}
export function setL1RpcForTests(fake: unknown | null) {
  l1Client = fake as ReturnType<typeof makeL1Client> | null;
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

/** ERC-20 + the ERC-8056 Scaled-UI extension Robinhood stock tokens implement. */
export const TOKEN_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  // ERC-8056 (corporate-action scaling). Not every token exposes every view —
  // callers treat reverts as "extension absent" and fail soft.
  { name: "uiMultiplier", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "newUIMultiplier", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "effectiveAt", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "oraclePaused", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;

/** Chainlink AggregatorV3 proxy. */
export const FEED_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { name: "description", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** Every Robinhood feed heartbeats at 86400s; allow slack before calling it stale. */
export const FEED_STALE_AFTER_SEC = 86_400 + 3_600;

// ── Morpho (Blue) ───────────────────────────────────────────────────────────

export const MARKET_PARAMS_COMPONENTS = [
  { name: "loanToken", type: "address" },
  { name: "collateralToken", type: "address" },
  { name: "oracle", type: "address" },
  { name: "irm", type: "address" },
  { name: "lltv", type: "uint256" },
] as const;

export const MORPHO_ABI = [
  { name: "idToMarketParams", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "", type: "tuple", components: MARKET_PARAMS_COMPONENTS }] },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "supplyShares", type: "uint256" },
          { name: "borrowShares", type: "uint128" },
          { name: "collateral", type: "uint128" },
        ],
      },
    ],
  },
  { name: "supply", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "supplyCollateral", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [] },
  { name: "withdrawCollateral", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [] },
  { name: "borrow", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
  { name: "repay", type: "function", stateMutability: "nonpayable", inputs: [{ name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }, { name: "onBehalf", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ name: "", type: "uint256" }, { name: "", type: "uint256" }] },
] as const;

/** Morpho market oracle: price of 1 collateral token in loan tokens, scaled so
 *  collateralValueInLoanAtoms = collateralAtoms × price / 1e36. */
export const MORPHO_ORACLE_ABI = [
  { name: "price", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const IRM_ABI = [
  {
    name: "borrowRateView",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "marketParams", type: "tuple", components: MARKET_PARAMS_COMPONENTS },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Uniswap v4 (quote + Universal Router + Permit2) ────────────────────────

export const V4_QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable", // simulated via eth_call; never sent
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const UNIVERSAL_ROUTER_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const PERMIT2_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

// ── Canonical bridge ────────────────────────────────────────────────────────

/** Nitro Delayed Inbox: depositEth() credits msg.sender's address on the L2. */
export const INBOX_ABI = [
  { name: "depositEth", type: "function", stateMutability: "payable", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** ArbSys precompile: withdrawEth(destination) burns L2 ETH into an L2→L1 exit. */
export const ARB_SYS_ABI = [
  { name: "withdrawEth", type: "function", stateMutability: "payable", inputs: [{ name: "destination", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
