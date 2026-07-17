// ─────────────────────────────────────────────────────────────────────────
//  RPC wiring + the minimal ABIs this service calls. One lazily-built
//  public client per supported chain (ethereum/base/arbitrum), env-
//  overridable, defaulting to publicnode (viem's default mainnet RPC 429s
//  under light load — same lesson as the lido sibling).
// ─────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from "viem";
import { mainnet, base, arbitrum } from "viem/chains";
import { chainBySlug, type OsChain } from "./registry";

const VIEM_CHAINS = { ethereum: mainnet, base, arbitrum } as const;

// Inferred types (not the exported PublicClient) — the workspace hoists
// multiple viem copies whose nominal types don't unify.
const clients = new Map<string, ReturnType<typeof makeClient>>();

function makeClient(chain: OsChain) {
  return createPublicClient({
    chain: VIEM_CHAINS[chain.slug],
    batch: { multicall: { wait: 16 } },
    transport: http(process.env[chain.rpcEnv] || chain.publicRpc, { retryCount: 3, retryDelay: 300 }),
  });
}

/** Shared client for an OpenSea chain slug. Throws on unsupported slugs. */
export function rpc(slug: string) {
  const chain = chainBySlug(slug);
  if (!chain) throw new Error(`Unsupported chain: ${slug}`);
  let client = clients.get(slug);
  if (!client) {
    client = makeClient(chain);
    clients.set(slug, client);
  }
  return client;
}

/** Test seam: replace (or reset with null) the shared client for a chain. */
export function setRpcForTests(slug: string, fake: unknown | null) {
  if (fake === null) clients.delete(slug);
  else clients.set(slug, fake as ReturnType<typeof makeClient>);
}

/**
 * Retry a read when the free RPC rate-limits. The limiter answers with a
 * JSON-RPC error (not an HTTP failure), which viem's transport retry does
 * NOT cover — so wrap reads in one app-level retry with a short backoff.
 */
export async function readRetry<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastError;
}

// ── ABIs (minimal, hand-pinned) ────────────────────────────────────────────

export const ERC721_ABI = [
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "safeTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const ERC1155_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "safeTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// OrderComponents mirrors Seaport 1.6 exactly — cancel() takes the full
// original components (counter included) or the cancel silently no-ops.
const ORDER_COMPONENTS = [
  { name: "offerer", type: "address" },
  { name: "zone", type: "address" },
  {
    name: "offer",
    type: "tuple[]",
    components: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ],
  },
  {
    name: "consideration",
    type: "tuple[]",
    components: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
  },
  { name: "orderType", type: "uint8" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "zoneHash", type: "bytes32" },
  { name: "salt", type: "uint256" },
  { name: "conduitKey", type: "bytes32" },
  { name: "counter", type: "uint256" },
] as const;

export const SEAPORT_ABI = [
  {
    name: "getCounter",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "offerer", type: "address" }],
    outputs: [{ name: "counter", type: "uint256" }],
  },
  {
    name: "cancel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orders", type: "tuple[]", components: ORDER_COMPONENTS }],
    outputs: [{ name: "cancelled", type: "bool" }],
  },
] as const;
