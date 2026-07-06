// EIP-712 order construction — the heart of the service, and deliberately
// signature-FREE: this module produces typed data for the CLIENT's wallet to
// sign (eth_signTypedData_v4 / viem signTypedData). No key ever touches this
// service.
//
// Verified against the CoW docs (bundled corpus: cow-protocol/reference/core/
// signing_schemes) and the live order-book API 2026-07-06:
// - domain {name:"Gnosis Protocol", version:"v2", chainId, verifyingContract}
//   with the SAME settlement contract 0x9008…ab41 on every chain.
// - Order type fields in the exact order below; `kind` / `sellTokenBalance` /
//   `buyTokenBalance` are EIP-712 `string` members holding "sell"/"buy"/
//   "erc20" — eth_signTypedData hashes string members itself (encodeData
//   keccak-hashes dynamic types), so the typed data carries the plain strings.
// - appData in the signed struct is bytes32 = keccak256(UTF-8 bytes of the
//   full appData JSON string) — confirmed by the openapi ("assumed to be set
//   to the keccak256 hash of the UTF-8 encoded bytes of this string") and by
//   a live /quote echo of appDataHash.
// - feeAmount is signed as 0: "When creating an order, this should be set to
//   zero as fees are now computed dynamically by solvers" (openapi). Quotes
//   still return the estimated network fee — it gets folded into sellAmount.

import { keccak256, toBytes } from "viem";
import {
  SETTLEMENT_CONTRACT,
  VAULT_RELAYER,
  type ChainInfo,
  type QuoteSide,
} from "./cow";

// The canonical minimal appData document. Its hash was cross-checked live:
// POST /quote with this exact string echoed the same appDataHash the local
// keccak256 computes (0xa872cd1c…fdc7).
export const DEFAULT_APP_DATA = '{"version":"1.3.0","metadata":{}}';

/** keccak256 of the UTF-8 bytes of the appData JSON string. */
export function appDataHash(fullAppData: string): string {
  return keccak256(toBytes(fullAppData));
}

/** Validate + normalize a caller-supplied appData JSON string. */
export function normalizeAppData(raw?: string): { fullAppData: string; hash: string } | { error: string } {
  const fullAppData = raw ?? DEFAULT_APP_DATA;
  if (fullAppData.length > 1000) {
    return { error: "appData JSON is limited to 1000 bytes by the order book." };
  }
  try {
    const parsed = JSON.parse(fullAppData);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "appData must encode a JSON object." };
    }
  } catch {
    return { error: "appData must be a valid JSON string, e.g. '{\"version\":\"1.3.0\",\"metadata\":{}}'." };
  }
  return { fullAppData, hash: appDataHash(fullAppData) };
}

// ── EIP-712 shapes ───────────────────────────────────────────────────────────

export const ORDER_TYPE = [
  { name: "sellToken", type: "address" },
  { name: "buyToken", type: "address" },
  { name: "receiver", type: "address" },
  { name: "sellAmount", type: "uint256" },
  { name: "buyAmount", type: "uint256" },
  { name: "validTo", type: "uint32" },
  { name: "appData", type: "bytes32" },
  { name: "feeAmount", type: "uint256" },
  { name: "kind", type: "string" },
  { name: "partiallyFillable", type: "bool" },
  { name: "sellTokenBalance", type: "string" },
  { name: "buyTokenBalance", type: "string" },
] as const;

// Included so raw eth_signTypedData_v4 payloads validate (viem/ethers ignore it).
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export interface OrderMessage {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string; // bytes32 hash
  feeAmount: string; // always "0" for new orders
  kind: "sell" | "buy";
  partiallyFillable: boolean;
  sellTokenBalance: "erc20";
  buyTokenBalance: "erc20";
}

export function orderTypedData(chain: ChainInfo, message: OrderMessage) {
  return {
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: chain.chainId,
      verifyingContract: SETTLEMENT_CONTRACT,
    },
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      Order: ORDER_TYPE,
    },
    primaryType: "Order" as const,
    message,
  };
}

/** Typed data for the off-chain OrderCancellations struct (DELETE /v1/orders). */
export function cancellationTypedData(chain: ChainInfo, orderUids: string[]) {
  return {
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: chain.chainId,
      verifyingContract: SETTLEMENT_CONTRACT,
    },
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      OrderCancellations: [{ name: "orderUids", type: "bytes[]" }],
    },
    primaryType: "OrderCancellations" as const,
    message: { orderUids },
  };
}

// ── Amount math (bigint, no floats) ─────────────────────────────────────────

const BPS = 10_000n;

/** Reduce an amount by `bps` basis points (floor). */
export const minusBps = (amount: bigint, bps: number): bigint => (amount * (BPS - BigInt(bps))) / BPS;
/** Increase an amount by `bps` basis points (ceil-ish via floor on the product). */
export const plusBps = (amount: bigint, bps: number): bigint => (amount * (BPS + BigInt(bps))) / BPS;

export interface BuiltOrder {
  order: OrderMessage;
  typedData: ReturnType<typeof orderTypedData>;
  fullAppData: string;
  approval: { token: string; spender: string; neededAllowance: string };
  quoteId: number | null;
}

/**
 * Turn a /quote response into a signable order:
 * - fold the quoted network fee into sellAmount and sign feeAmount = 0,
 * - apply slippage to the non-fixed side (sell order → accept slightly less
 *   buy; buy order → offer slightly more sell).
 */
export function orderFromQuote(
  chain: ChainInfo,
  quote: QuoteSide,
  quoteId: number | null,
  args: { receiver?: string; from: string; slippageBps?: number; fullAppData: string; appDataHash: string },
): BuiltOrder {
  const slippageBps = args.slippageBps ?? 50;
  const feeInclusiveSell = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  const sellAmount = quote.kind === "buy" ? plusBps(feeInclusiveSell, slippageBps) : feeInclusiveSell;
  const buyAmount = quote.kind === "sell" ? minusBps(BigInt(quote.buyAmount), slippageBps) : BigInt(quote.buyAmount);

  const order: OrderMessage = {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver: quote.receiver ?? args.receiver ?? args.from,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo: quote.validTo,
    appData: args.appDataHash,
    feeAmount: "0",
    kind: quote.kind,
    partiallyFillable: quote.partiallyFillable ?? false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
  return {
    order,
    typedData: orderTypedData(chain, order),
    fullAppData: args.fullAppData,
    approval: { token: order.sellToken, spender: VAULT_RELAYER, neededAllowance: order.sellAmount },
    quoteId,
  };
}

/** Build a limit order from explicit amounts (price set by the user). */
export function limitOrder(
  chain: ChainInfo,
  args: {
    sellToken: string;
    buyToken: string;
    sellAmountAtoms: string;
    buyAmountAtoms: string;
    from: string;
    receiver?: string;
    validTo: number;
    partiallyFillable?: boolean;
    fullAppData: string;
    appDataHash: string;
  },
): BuiltOrder {
  const order: OrderMessage = {
    sellToken: args.sellToken,
    buyToken: args.buyToken,
    receiver: args.receiver ?? args.from,
    sellAmount: args.sellAmountAtoms,
    buyAmount: args.buyAmountAtoms,
    validTo: args.validTo,
    appData: args.appDataHash,
    // Limit orders are signed with feeAmount 0 — the fee is taken from
    // surplus when a solver executes at a better-than-limit price.
    feeAmount: "0",
    kind: "sell",
    partiallyFillable: args.partiallyFillable ?? false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
  return {
    order,
    typedData: orderTypedData(chain, order),
    fullAppData: args.fullAppData,
    approval: { token: order.sellToken, spender: VAULT_RELAYER, neededAllowance: order.sellAmount },
    quoteId: null,
  };
}
