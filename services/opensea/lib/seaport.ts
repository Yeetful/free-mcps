// ─────────────────────────────────────────────────────────────────────────
//  Seaport 1.6 order construction — pure functions, no I/O. The service
//  (not the model, not the caller) computes every consideration split from
//  the collection's live fee schedule, so a listing can only ever pay out
//  to the offerer + OpenSea's published fee recipients.
// ─────────────────────────────────────────────────────────────────────────

import { encodeFunctionData, parseAbiItem, type AbiFunction, type AbiParameter } from "viem";
import {
  OPENSEA_CONDUIT_KEY,
  SEAPORT_1_6,
  ZERO_ADDRESS,
  ZERO_HASH,
  type Address,
} from "./registry";
import type { RawCollectionFee } from "./opensea-api";

// Seaport enums (the subset we emit).
export const ITEM_TYPE = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3 } as const;
export const ORDER_TYPE = { FULL_OPEN: 0, FULL_RESTRICTED: 2 } as const;

export interface SeaportOfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

/** OrderComponents as both the EIP-712 message and the create-listing POST body. */
export interface SeaportOrderComponents {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
  [key: string]: unknown;
}

/** EIP-712 types for a Seaport OrderComponents signature. */
export const SEAPORT_EIP712_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

export function seaportDomain(chainId: number) {
  return { name: "Seaport", version: "1.6", chainId, verifyingContract: SEAPORT_1_6 };
}

/** A 32-byte random salt (hex string, decimal-safe as uint256 via BigInt). */
export function randomSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex).toString();
}

export interface FeeSplit {
  recipient: string;
  basisPoints: number;
  amountWei: bigint;
}

/**
 * Split a total price across the collection's fee schedule. Required fees
 * always apply; optional (creator) fees only when includeOptional. Fee
 * amounts floor; the offerer keeps the remainder — so the splits always sum
 * to exactly priceWei.
 */
export function splitPrice(priceWei: bigint, fees: RawCollectionFee[], includeOptional: boolean): { sellerWei: bigint; splits: FeeSplit[] } {
  const splits: FeeSplit[] = [];
  let feeTotal = 0n;
  for (const f of fees) {
    if (!f.required && !includeOptional) continue;
    const basisPoints = Math.round(f.fee * 100);
    if (basisPoints <= 0) continue;
    const amountWei = (priceWei * BigInt(basisPoints)) / 10_000n;
    if (amountWei <= 0n) continue;
    splits.push({ recipient: f.recipient, basisPoints, amountWei });
    feeTotal += amountWei;
  }
  return { sellerWei: priceWei - feeTotal, splits };
}

export interface BuildOrderInput {
  offerer: Address;
  token: Address;
  identifier: string;
  standard: "erc721" | "erc1155";
  /** Units offered (always "1" for ERC-721). */
  amount: string;
  priceWei: bigint;
  fees: RawCollectionFee[];
  includeOptionalFees: boolean;
  /** Collection-required zone, or null → open order. */
  requiredZone: string | null;
  counter: string;
  startTime: number;
  endTime: number;
}

/** Assemble the full OrderComponents for a fixed-price native-ETH listing. */
export function buildListingComponents(input: BuildOrderInput): SeaportOrderComponents {
  const { sellerWei, splits } = splitPrice(input.priceWei, input.fees, input.includeOptionalFees);
  if (sellerWei <= 0n) throw new Error("Fees consume the entire price");

  const consideration: SeaportConsiderationItem[] = [
    {
      itemType: ITEM_TYPE.NATIVE,
      token: ZERO_ADDRESS,
      identifierOrCriteria: "0",
      startAmount: sellerWei.toString(),
      endAmount: sellerWei.toString(),
      recipient: input.offerer,
    },
    ...splits.map((s) => ({
      itemType: ITEM_TYPE.NATIVE,
      token: ZERO_ADDRESS,
      identifierOrCriteria: "0",
      startAmount: s.amountWei.toString(),
      endAmount: s.amountWei.toString(),
      recipient: s.recipient,
    })),
  ];

  return {
    offerer: input.offerer,
    zone: input.requiredZone ?? ZERO_ADDRESS,
    offer: [
      {
        itemType: input.standard === "erc721" ? ITEM_TYPE.ERC721 : ITEM_TYPE.ERC1155,
        token: input.token,
        identifierOrCriteria: input.identifier,
        startAmount: input.amount,
        endAmount: input.amount,
      },
    ],
    consideration,
    orderType: input.requiredZone ? ORDER_TYPE.FULL_RESTRICTED : ORDER_TYPE.FULL_OPEN,
    startTime: String(input.startTime),
    endTime: String(input.endTime),
    zoneHash: ZERO_HASH,
    salt: randomSalt(),
    conduitKey: OPENSEA_CONDUIT_KEY,
    counter: input.counter,
  };
}

// ── Fulfillment calldata (buys) ────────────────────────────────────────────

/**
 * OpenSea's fulfillment_data returns the function SIGNATURE (unnamed tuple
 * types) plus input_data as NAMED objects in ABI field order. Re-encode
 * locally with viem: walk the parsed ABI inputs and convert each named
 * object to positional values (JSON preserves insertion order, and the
 * probed responses emit fields in exact ABI order).
 */
export function fulfillmentToCalldata(functionSig: string, inputData: Record<string, unknown>): `0x${string}` {
  const abiFn = parseAbiItem(`function ${functionSig}`) as AbiFunction;
  const values = Object.values(inputData);
  if (values.length !== abiFn.inputs.length) {
    throw new Error(`fulfillment input arity mismatch: got ${values.length}, ABI wants ${abiFn.inputs.length}`);
  }
  const args = abiFn.inputs.map((param, i) => coerceAbiValue(param, values[i]));
  return encodeFunctionData({ abi: [abiFn], functionName: abiFn.name, args });
}

function coerceAbiValue(param: AbiParameter, value: unknown): unknown {
  if (param.type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new Error(`expected array for ${param.type}`);
    const inner = { ...param, type: param.type.slice(0, -2) } as AbiParameter;
    return value.map((v) => coerceAbiValue(inner, v));
  }
  if (param.type === "tuple") {
    const components = (param as { components?: AbiParameter[] }).components ?? [];
    if (typeof value !== "object" || value === null) throw new Error("expected object for tuple");
    const values = Object.values(value as Record<string, unknown>);
    if (values.length !== components.length) {
      throw new Error(`tuple arity mismatch: got ${values.length}, ABI wants ${components.length}`);
    }
    return components.map((c, i) => coerceAbiValue(c, values[i]));
  }
  if (/^u?int\d*$/.test(param.type)) return BigInt(String(value));
  if (param.type === "bool") return Boolean(value);
  return value; // address, bytes, bytes32, string — pass through as-is
}
