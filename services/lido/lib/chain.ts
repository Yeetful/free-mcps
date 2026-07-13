// ─────────────────────────────────────────────────────────────────────────
//  Ethereum-mainnet wiring: Lido deployment addresses + a shared viem client
//  + the minimal ABIs this service calls. The addresses come from
//  docs.lido.fi/deployed-contracts (fetched 2026-07-13) AND every one is
//  probed live by `pnpm smoke` before a deploy is called done — stETH's
//  address is additionally cross-checked against eth-api.lido.fi's response
//  meta at smoke time.
// ─────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

export const CHAIN_ID = 1;

/** Lido stETH (the rebasing liquid-staking token; also the staking entry). */
export const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as const;
/** Wrapped stETH — non-rebasing wrapper (rate accrues in stEthPerToken). */
export const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const;
/** WithdrawalQueueERC721 (unstETH) — stETH → ETH exit, request NFTs. */
export const WITHDRAWAL_QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1" as const;

// Inferred type (not the exported PublicClient) — the workspace hoists
// multiple viem copies whose nominal types don't unify.
let client: ReturnType<typeof makeClient> | null = null;

function makeClient() {
  return createPublicClient({
    chain: mainnet,
    // Multicall batching: a position read (balances + shares + rate + queue
    // ids) collapses into one Multicall3 aggregate instead of half a dozen
    // eth_calls — which is what keeps the public RPC from rate-limiting us.
    batch: { multicall: { wait: 16 } },
    // viem's default mainnet RPC (eth.merkle.io) 429s under light load
    // (observed 2026-07-13) — default to publicnode instead.
    transport: http(process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com", {
      retryCount: 3,
      retryDelay: 300,
    }),
  });
}

/** Shared mainnet RPC client. ETH_RPC_URL overrides the public endpoint. */
export function rpc() {
  if (!client) client = makeClient();
  return client;
}

/** Test seam: replace or reset the shared client. */
export function setRpcForTests(fake: unknown | null) {
  client = fake as ReturnType<typeof makeClient> | null;
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

export const STETH_ABI = [
  // Staking entry: mints stETH 1:1 for the ETH sent. _referral is metadata
  // only (no fee, no approval) — we always pass the zero address.
  { name: "submit", type: "function", stateMutability: "payable", inputs: [{ name: "_referral", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "sharesOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "getTotalPooledEther", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getTotalShares", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getCurrentStakeLimit", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const WSTETH_ABI = [
  // Locks stETH, mints wstETH. Needs a prior stETH approval to WSTETH.
  { name: "wrap", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_stETHAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  // Burns wstETH, releases stETH. No approval needed (burns caller's own).
  { name: "unwrap", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_wstETHAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "stEthPerToken", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getWstETHByStETH", type: "function", stateMutability: "view", inputs: [{ name: "_stETHAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "getStETHByWstETH", type: "function", stateMutability: "view", inputs: [{ name: "_wstETHAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const WITHDRAWAL_QUEUE_ABI = [
  // stETH → request NFTs (one per amount; each ≤ MAX, ≥ MIN). Needs a prior
  // stETH approval to the queue.
  { name: "requestWithdrawals", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_amounts", type: "uint256[]" }, { name: "_owner", type: "address" }], outputs: [{ name: "requestIds", type: "uint256[]" }] },
  // Same, funded with wstETH (approval on the wstETH token).
  { name: "requestWithdrawalsWstETH", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_amounts", type: "uint256[]" }, { name: "_owner", type: "address" }], outputs: [{ name: "requestIds", type: "uint256[]" }] },
  { name: "claimWithdrawals", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_requestIds", type: "uint256[]" }, { name: "_hints", type: "uint256[]" }], outputs: [] },
  { name: "getWithdrawalRequests", type: "function", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }], outputs: [{ name: "requestsIds", type: "uint256[]" }] },
  {
    name: "getWithdrawalStatus",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_requestIds", type: "uint256[]" }],
    outputs: [
      {
        name: "statuses",
        type: "tuple[]",
        components: [
          { name: "amountOfStETH", type: "uint256" },
          { name: "amountOfShares", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "isFinalized", type: "bool" },
          { name: "isClaimed", type: "bool" },
        ],
      },
    ],
  },
  // Claim plumbing: hints locate each request's finalization checkpoint.
  { name: "findCheckpointHints", type: "function", stateMutability: "view", inputs: [{ name: "_requestIds", type: "uint256[]" }, { name: "_firstIndex", type: "uint256" }, { name: "_lastIndex", type: "uint256" }], outputs: [{ name: "hintIds", type: "uint256[]" }] },
  { name: "getLastCheckpointIndex", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getClaimableEther", type: "function", stateMutability: "view", inputs: [{ name: "_requestIds", type: "uint256[]" }, { name: "_hints", type: "uint256[]" }], outputs: [{ name: "claimableEthValues", type: "uint256[]" }] },
  { name: "getLastRequestId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getLastFinalizedRequestId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "unfinalizedStETH", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "MIN_STETH_WITHDRAWAL_AMOUNT", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "MAX_STETH_WITHDRAWAL_AMOUNT", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** Per-request cap enforced by the queue contract (probed live: 1000 ETH). */
export const MAX_WITHDRAWAL_WEI = 1000n * 10n ** 18n;
/** Per-request floor enforced by the queue contract (probed live: 100 wei). */
export const MIN_WITHDRAWAL_WEI = 100n;
