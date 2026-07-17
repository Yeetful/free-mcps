// Construction-only NFT transactions. Calldata is encoded locally with viem
// from the pinned ABIs in chain.ts; ownership is verified against the REAL
// on-chain state before anything is returned; Seaport listings are assembled
// by this service from the collection's live fee schedule (the caller only
// ever supplies chain/contract/id/price). Each flow comes back as ordered
// `send_transaction` steps and/or a `sign_typed_data` artifact — the same
// contracts the uniswap/aave/lido/robinhood siblings use. Nothing here ever
// signs or submits a transaction; submit_listing merely relays an order the
// USER already signed, after re-validating it against the fee schedule.

import { encodeFunctionData } from "viem";
import { ERC1155_ABI, ERC721_ABI, SEAPORT_ABI, readRetry, rpc } from "./chain";
import {
  fetchCollection,
  fetchListingFulfillment,
  fetchNft,
  fetchOrder,
  postListing,
  type RawCollection,
  type RawNft,
  type RawOrder,
} from "./opensea-api";
import {
  OPENSEA_CONDUIT,
  OPENSEA_CONDUIT_KEY,
  OPENSEA_FEE_RECIPIENT,
  SEAPORT_1_6,
  ZERO_ADDRESS,
  chainBySlug,
  type Address,
  type OsChain,
} from "./registry";
import {
  ITEM_TYPE,
  SEAPORT_EIP712_TYPES,
  buildListingComponents,
  fulfillmentToCalldata,
  seaportDomain,
  splitPrice,
  type SeaportOrderComponents,
} from "./seaport";
import { ethToWei, fail, formatWei, isEvmAddress, ok, parseUint, sameAddress, type OsResult } from "./util";

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: string; data: string; value: string; chainId: number };
}

/** An EIP-712 payload for the USER to sign (Seaport listings). */
export interface SignTypedDataAction {
  action: "sign_typed_data";
  label: string;
  summary: string;
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: typeof SEAPORT_EIP712_TYPES;
    primaryType: "OrderComponents";
    message: SeaportOrderComponents;
  };
}

const step = (
  label: string,
  summary: string,
  tx: { to: string; data?: string; value?: bigint; chainId: number },
): SendTransactionAction => ({
  action: "send_transaction",
  label,
  summary,
  tx: { to: tx.to, data: tx.data ?? "0x", value: (tx.value ?? 0n).toString(), chainId: tx.chainId },
});

const SUBMIT_WITH =
  "Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs or submits.";

/** Max listing duration — matches the transaction layer's 31-day validity ceiling. */
const MAX_DURATION_HOURS = 24 * 30;

// ── Shared anchoring ───────────────────────────────────────────────────────

interface NftAnchor {
  standard: "erc721" | "erc1155";
  name: string;
  collection: string | null; // OpenSea slug, when the API answered
}

/**
 * Resolve standard + display name. OpenSea first (it also gives us the
 * collection slug the sell flow needs); pure on-chain probing as the
 * fallback so transfers keep working when the API is down.
 */
async function anchorNft(chain: OsChain, contract: Address, tokenId: bigint): Promise<NftAnchor | null> {
  const viaApi = await fetchNft(chain.slug, contract, tokenId.toString());
  if (viaApi.ok) {
    const raw = (viaApi.data as { nft?: RawNft }).nft;
    if (raw && (raw.token_standard === "erc721" || raw.token_standard === "erc1155")) {
      return {
        standard: raw.token_standard,
        name: raw.name ?? `#${tokenId}`,
        collection: raw.collection ?? null,
      };
    }
  }
  const client = rpc(chain.slug);
  try {
    await readRetry(() => client.readContract({ address: contract, abi: ERC721_ABI, functionName: "ownerOf", args: [tokenId] }));
    return { standard: "erc721", name: `#${tokenId}`, collection: null };
  } catch {
    /* not a (minted) 721 — try 1155 */
  }
  try {
    await readRetry(() =>
      client.readContract({ address: contract, abi: ERC1155_ABI, functionName: "balanceOf", args: [ZERO_ADDRESS, tokenId] }),
    );
    return { standard: "erc1155", name: `#${tokenId}`, collection: null };
  } catch {
    return null;
  }
}

/** On-chain ownership check. Returns an error string, or null when owned. */
async function verifyOwnership(chain: OsChain, contract: Address, tokenId: bigint, owner: Address, standard: "erc721" | "erc1155", units: bigint): Promise<string | null> {
  const client = rpc(chain.slug);
  if (standard === "erc721") {
    const actual = await readRetry(() =>
      client.readContract({ address: contract, abi: ERC721_ABI, functionName: "ownerOf", args: [tokenId] }),
    );
    if (!sameAddress(actual, owner)) return `That NFT is owned by ${actual}, not ${owner}.`;
    return null;
  }
  const balance = await readRetry(() =>
    client.readContract({ address: contract, abi: ERC1155_ABI, functionName: "balanceOf", args: [owner, tokenId] }),
  );
  if (balance < units) return `${owner} holds ${balance} of that ERC-1155 token — fewer than the ${units} requested.`;
  return null;
}

/** An approval step for the OpenSea conduit — only when not already granted. */
async function conduitApprovalIfNeeded(chain: OsChain, contract: Address, owner: Address, standard: "erc721" | "erc1155"): Promise<SendTransactionAction | null> {
  const client = rpc(chain.slug);
  const abi = standard === "erc721" ? ERC721_ABI : ERC1155_ABI;
  const approved = await readRetry(() =>
    client.readContract({ address: contract, abi, functionName: "isApprovedForAll", args: [owner, OPENSEA_CONDUIT] }),
  );
  if (approved) return null;
  return step(
    "Approve OpenSea",
    `Let OpenSea's conduit transfer items from this collection when a sale settles. One-time per collection; revocable any time with setApprovalForAll(operator, false).`,
    {
      to: contract,
      data: encodeFunctionData({ abi, functionName: "setApprovalForAll", args: [OPENSEA_CONDUIT, true] }),
      chainId: chain.chainId,
    },
  );
}

// ── build_transfer_nft ─────────────────────────────────────────────────────

export async function buildTransferNft(chainSlug: string, contract: string, tokenId: string, from: string, to: string, amount: string): Promise<OsResult> {
  const chain = chainBySlug(chainSlug);
  if (!chain) return fail(400, `Unsupported chain "${chainSlug}". Nothing was built.`);
  if (!isEvmAddress(contract)) return fail(400, `"${contract}" is not a valid contract address. Nothing was built.`);
  if (!isEvmAddress(from) || !isEvmAddress(to)) return fail(400, "from/to must be valid EVM addresses (0x…40 hex). Nothing was built.");
  if (sameAddress(from, to)) return fail(400, "from and to are the same address — nothing to transfer. Nothing was built.");
  if (sameAddress(to, ZERO_ADDRESS)) return fail(400, "Refusing to transfer to the zero address (that burns the NFT). Nothing was built.");
  const id = parseUint(tokenId);
  if (id === null) return fail(400, `"${tokenId}" is not a valid token id. Nothing was built.`);
  const units = parseUint(amount);
  if (units === null || units < 1n) return fail(400, `"${amount}" is not a valid amount. Nothing was built.`);

  const anchor = await anchorNft(chain, contract, id);
  if (!anchor) return fail(404, `Could not resolve ${contract} #${tokenId} on ${chain.name} as ERC-721 or ERC-1155. Nothing was built.`);
  if (anchor.standard === "erc721" && units !== 1n) {
    return fail(400, "ERC-721 tokens are unique — amount must be 1. Nothing was built.");
  }

  const notOwned = await verifyOwnership(chain, contract, id, from, anchor.standard, units);
  if (notOwned) return fail(403, `${notOwned} Nothing was built.`);

  const data =
    anchor.standard === "erc721"
      ? encodeFunctionData({ abi: ERC721_ABI, functionName: "safeTransferFrom", args: [from, to, id] })
      : encodeFunctionData({ abi: ERC1155_ABI, functionName: "safeTransferFrom", args: [from, to, id, units, "0x"] });

  const what = anchor.standard === "erc1155" && units > 1n ? `${units}× ${anchor.name}` : anchor.name;
  return ok({
    operation: "transfer_nft",
    chain: chain.slug,
    standard: anchor.standard,
    contract,
    token_id: tokenId,
    name: anchor.name,
    from,
    to,
    amount: units.toString(),
    steps: [
      step(`Transfer ${anchor.name}`, `Send ${what} (${anchor.standard.toUpperCase()}) to ${to} on ${chain.name}. Transfers are irreversible — double-check the recipient.`, {
        to: contract,
        data,
        chainId: chain.chainId,
      }),
    ],
    submit_with: SUBMIT_WITH,
  });
}

// ── build_listing (sell) ───────────────────────────────────────────────────

export async function buildListing(
  chainSlug: string,
  contract: string,
  tokenId: string,
  offerer: string,
  priceEth: string,
  durationHours: number,
  amount: string,
  includeCreatorFees: boolean,
): Promise<OsResult> {
  const chain = chainBySlug(chainSlug);
  if (!chain) return fail(400, `Unsupported chain "${chainSlug}". Nothing was built.`);
  if (!isEvmAddress(contract) || !isEvmAddress(offerer)) return fail(400, "contract/offerer must be valid EVM addresses. Nothing was built.");
  const id = parseUint(tokenId);
  if (id === null) return fail(400, `"${tokenId}" is not a valid token id. Nothing was built.`);
  const units = parseUint(amount);
  if (units === null || units < 1n) return fail(400, `"${amount}" is not a valid amount. Nothing was built.`);
  const priceWei = ethToWei(priceEth);
  if (priceWei === null) return fail(400, `"${priceEth}" is not a valid ETH price. Nothing was built.`);
  if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > MAX_DURATION_HOURS) {
    return fail(400, `duration_hours must be between 1 and ${MAX_DURATION_HOURS} (30 days). Nothing was built.`);
  }

  const anchor = await anchorNft(chain, contract, id);
  if (!anchor) return fail(404, `Could not resolve ${contract} #${tokenId} on ${chain.name}. Nothing was built.`);
  if (anchor.standard === "erc721" && units !== 1n) return fail(400, "ERC-721 tokens are unique — amount must be 1. Nothing was built.");
  if (!anchor.collection) {
    return fail(502, "OpenSea doesn't index this NFT (no collection slug), so its fee schedule can't be fetched and a compliant listing can't be built. Nothing was built.");
  }

  const notOwned = await verifyOwnership(chain, contract, id, offerer, anchor.standard, units);
  if (notOwned) return fail(403, `${notOwned} Nothing was built.`);

  const col = await fetchCollection(anchor.collection);
  if (!col.ok) return fail(col.status, `Could not fetch the collection fee schedule (required to build a valid listing): ${col.data}. Nothing was built.`);
  const collection = col.data as RawCollection;
  const fees = collection.fees ?? [];

  const counter = await readRetry(() =>
    rpc(chain.slug).readContract({ address: SEAPORT_1_6, abi: SEAPORT_ABI, functionName: "getCounter", args: [offerer] }),
  );

  const startTime = Math.floor(Date.now() / 1000) - 120; // small back-date absorbs clock skew
  const endTime = startTime + 120 + Math.floor(durationHours * 3600);

  let components: SeaportOrderComponents;
  try {
    components = buildListingComponents({
      offerer,
      token: contract,
      identifier: id.toString(),
      standard: anchor.standard,
      amount: units.toString(),
      priceWei,
      fees,
      includeOptionalFees: includeCreatorFees,
      requiredZone: collection.required_zone ?? null,
      counter: counter.toString(),
      startTime,
      endTime,
    });
  } catch (e) {
    return fail(400, `${e instanceof Error ? e.message : String(e)}. Nothing was built.`);
  }

  const { sellerWei, splits } = splitPrice(priceWei, fees, includeCreatorFees);
  const approval = await conduitApprovalIfNeeded(chain, contract, offerer, anchor.standard);

  const sign: SignTypedDataAction = {
    action: "sign_typed_data",
    label: `List ${anchor.name} for ${formatWei(priceWei)} ETH`,
    summary:
      `Sign a Seaport 1.6 sell order: ${units > 1n ? `${units}× ` : ""}${anchor.name} at ${formatWei(priceWei)} ETH on ${chain.name}, ` +
      `expiring in ${durationHours}h. You receive ${formatWei(sellerWei)} ETH after fees. Signing costs no gas; the order only executes if a buyer pays full price.`,
    typedData: {
      domain: seaportDomain(chain.chainId),
      types: SEAPORT_EIP712_TYPES,
      primaryType: "OrderComponents",
      message: components,
    },
  };

  return ok({
    operation: "list_nft",
    chain: chain.slug,
    standard: anchor.standard,
    contract,
    token_id: tokenId,
    name: anchor.name,
    collection: anchor.collection,
    price_eth: formatWei(priceWei),
    seller_proceeds_eth: formatWei(sellerWei),
    fees: splits.map((s) => ({ recipient: s.recipient, percent: s.basisPoints / 100, amount_eth: formatWei(s.amountWei) })),
    expires_at: new Date(endTime * 1000).toISOString(),
    steps: approval ? [approval] : [],
    sign,
    then: `After the user signs, call submit_listing with { chain: "${chain.slug}", parameters: <the signed message exactly as returned here>, signature: <the 0x signature> } to publish on OpenSea.`,
    submit_with: SUBMIT_WITH,
  });
}

// ── submit_listing (relay) ─────────────────────────────────────────────────

/**
 * Relay a USER-signed listing to OpenSea — after re-deriving the allowed
 * payout set from the collection's live fee schedule and refusing any order
 * that pays anyone else. Defense against a tampered `parameters` between
 * build and submit.
 */
export async function submitListing(chainSlug: string, parameters: SeaportOrderComponents, signature: string): Promise<OsResult> {
  const chain = chainBySlug(chainSlug);
  if (!chain) return fail(400, `Unsupported chain "${chainSlug}". Nothing was submitted.`);
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 130) {
    return fail(400, "signature must be the 0x EIP-712 signature from the user's wallet. Nothing was submitted.");
  }
  const offer = parameters?.offer;
  if (!Array.isArray(offer) || offer.length !== 1) return fail(400, "Listing must offer exactly one NFT item. Nothing was submitted.");
  const item = offer[0];
  if (item.itemType !== ITEM_TYPE.ERC721 && item.itemType !== ITEM_TYPE.ERC1155) {
    return fail(400, "Offer item must be ERC-721 or ERC-1155. Nothing was submitted.");
  }
  if (parameters.conduitKey?.toLowerCase() !== OPENSEA_CONDUIT_KEY.toLowerCase()) {
    return fail(400, "conduitKey is not the OpenSea conduit — refusing to relay. Nothing was submitted.");
  }
  if (!isEvmAddress(parameters.offerer) || !isEvmAddress(item.token)) {
    return fail(400, "offerer/token must be valid addresses. Nothing was submitted.");
  }

  // Re-derive who may be paid: the offerer + the collection's live fee
  // recipients (+ OpenSea's protocol wallet). Anything else → refuse.
  const nft = await fetchNft(chain.slug, item.token, item.identifierOrCriteria);
  if (!nft.ok) return fail(nft.status, `Could not resolve the listed NFT to re-check its fee schedule: ${nft.data}. Nothing was submitted.`);
  const slug = (nft.data as { nft?: RawNft }).nft?.collection;
  if (!slug) return fail(502, "OpenSea returned no collection for the listed NFT. Nothing was submitted.");
  const col = await fetchCollection(slug);
  if (!col.ok) return fail(col.status, `Could not fetch the collection fee schedule: ${col.data}. Nothing was submitted.`);
  const collection = col.data as RawCollection;

  const allowed = new Set<string>([
    parameters.offerer.toLowerCase(),
    OPENSEA_FEE_RECIPIENT.toLowerCase(),
    ...(collection.fees ?? []).map((f) => f.recipient.toLowerCase()),
  ]);
  for (const c of parameters.consideration ?? []) {
    if (c.itemType !== ITEM_TYPE.NATIVE) {
      return fail(400, "Listing consideration must be native ETH only. Nothing was submitted.");
    }
    if (!allowed.has(c.recipient?.toLowerCase?.() ?? "")) {
      return fail(403, `Consideration recipient ${c.recipient} is neither the offerer nor a published fee recipient of "${slug}" — refusing to relay. Nothing was submitted.`);
    }
  }
  const zone = parameters.zone?.toLowerCase?.() ?? "";
  const requiredZone = collection.required_zone?.toLowerCase() ?? null;
  if (zone !== ZERO_ADDRESS && zone !== requiredZone) {
    return fail(400, "Order zone is neither open (zero) nor the collection's required zone — refusing to relay. Nothing was submitted.");
  }

  const r = await postListing(chain.slug, parameters as Record<string, unknown>, signature, SEAPORT_1_6);
  if (!r.ok) return r;
  const order = (r.data as { order?: RawOrder }).order;
  return ok({
    operation: "listing_submitted",
    chain: chain.slug,
    order_hash: order?.order_hash ?? null,
    opensea_url: `https://opensea.io/assets/${chain.slug}/${item.token}/${item.identifierOrCriteria}`,
    note: "The listing is live on OpenSea. Cancel any time with build_cancel_listing (an on-chain transaction).",
  });
}

// ── build_cancel_listing ───────────────────────────────────────────────────

export async function buildCancelListing(chainSlug: string, orderHash: string, canceller: string): Promise<OsResult> {
  const chain = chainBySlug(chainSlug);
  if (!chain) return fail(400, `Unsupported chain "${chainSlug}". Nothing was built.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderHash)) return fail(400, "order_hash must be a 0x…64-hex order hash. Nothing was built.");
  if (!isEvmAddress(canceller)) return fail(400, "canceller must be a valid EVM address. Nothing was built.");

  const r = await fetchOrder(chain.slug, SEAPORT_1_6, orderHash);
  if (!r.ok) return fail(r.status, `Could not fetch that order from OpenSea: ${r.data}. Nothing was built.`);
  const order = (r.data as { order?: RawOrder }).order;
  const params = order?.protocol_data?.parameters as SeaportOrderComponents | undefined;
  if (!params) return fail(404, "OpenSea returned no order parameters for that hash. Nothing was built.");
  if (!sameAddress(params.offerer, canceller)) {
    return fail(403, `That order was created by ${params.offerer} — only its offerer can cancel it (Seaport enforces this on-chain too). Nothing was built.`);
  }
  if (params.counter == null) {
    return fail(502, "OpenSea's order data is missing the counter, so an exact cancel can't be encoded. Nothing was built.");
  }

  const components = {
    offerer: params.offerer as Address,
    zone: params.zone as Address,
    offer: (params.offer ?? []).map((o) => ({
      itemType: Number(o.itemType),
      token: o.token as Address,
      identifierOrCriteria: BigInt(o.identifierOrCriteria),
      startAmount: BigInt(o.startAmount),
      endAmount: BigInt(o.endAmount),
    })),
    consideration: (params.consideration ?? []).map((c) => ({
      itemType: Number(c.itemType),
      token: c.token as Address,
      identifierOrCriteria: BigInt(c.identifierOrCriteria),
      startAmount: BigInt(c.startAmount),
      endAmount: BigInt(c.endAmount),
      recipient: c.recipient as Address,
    })),
    orderType: Number(params.orderType),
    startTime: BigInt(params.startTime),
    endTime: BigInt(params.endTime),
    zoneHash: params.zoneHash as `0x${string}`,
    salt: BigInt(params.salt),
    conduitKey: params.conduitKey as `0x${string}`,
    counter: BigInt(String(params.counter)),
  };

  const item = params.offer?.[0];
  return ok({
    operation: "cancel_listing",
    chain: chain.slug,
    order_hash: orderHash,
    token: item?.token ?? null,
    token_id: item?.identifierOrCriteria ?? null,
    steps: [
      step("Cancel listing", `Cancel this Seaport listing on-chain so it can never be filled. Small gas cost; takes effect on confirmation.`, {
        to: SEAPORT_1_6,
        data: encodeFunctionData({ abi: SEAPORT_ABI, functionName: "cancel", args: [[components]] }),
        chainId: chain.chainId,
      }),
    ],
    submit_with: SUBMIT_WITH,
  });
}

// ── build_buy_nft ──────────────────────────────────────────────────────────

export async function buildBuyNft(chainSlug: string, orderHash: string, buyer: string, maxPriceEth?: string): Promise<OsResult> {
  const chain = chainBySlug(chainSlug);
  if (!chain) return fail(400, `Unsupported chain "${chainSlug}". Nothing was built.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderHash)) return fail(400, "order_hash must be a 0x…64-hex order hash. Nothing was built.");
  if (!isEvmAddress(buyer)) return fail(400, "buyer must be a valid EVM address. Nothing was built.");
  let maxWei: bigint | null = null;
  if (maxPriceEth !== undefined) {
    maxWei = ethToWei(maxPriceEth);
    if (maxWei === null) return fail(400, `"${maxPriceEth}" is not a valid max price. Nothing was built.`);
  }

  const r = await fetchListingFulfillment(chain.slug, orderHash, SEAPORT_1_6, buyer);
  if (!r.ok) return fail(r.status, `OpenSea could not produce fulfillment data (the listing may be gone): ${r.data}. Nothing was built.`);
  const tx = (r.data as { fulfillment_data?: { transaction?: { function?: string; to?: string; value?: number | string; input_data?: Record<string, unknown> } } })
    .fulfillment_data?.transaction;
  if (!tx?.function || !tx.to || tx.input_data == null) {
    return fail(502, "OpenSea's fulfillment response was missing the transaction. Nothing was built.");
  }
  if (!sameAddress(tx.to, SEAPORT_1_6)) {
    return fail(403, `Fulfillment target ${tx.to} is not the pinned Seaport 1.6 — refusing to build. Nothing was built.`);
  }
  const value = BigInt(String(tx.value ?? 0));
  if (value <= 0n) return fail(502, "Fulfillment came back with a zero price — refusing to build blind. Nothing was built.");
  if (maxWei !== null && value > maxWei) {
    return fail(409, `The listing costs ${formatWei(value)} ETH, above your ${formatWei(maxWei)} ETH cap. Nothing was built.`);
  }

  const balance = await readRetry(() => rpc(chain.slug).getBalance({ address: buyer }));
  if (balance < value) {
    return fail(403, `Buying needs ${formatWei(value)} ETH but ${buyer} holds ${formatWei(balance)} ETH on ${chain.name} (plus gas). Nothing was built.`);
  }

  let data: `0x${string}`;
  try {
    data = fulfillmentToCalldata(tx.function, tx.input_data);
  } catch (e) {
    return fail(502, `Could not re-encode OpenSea's fulfillment locally (${e instanceof Error ? e.message : String(e)}) — refusing to forward opaque calldata. Nothing was built.`);
  }

  return ok({
    operation: "buy_nft",
    chain: chain.slug,
    order_hash: orderHash,
    price_eth: formatWei(value),
    steps: [
      step(`Buy for ${formatWei(value)} ETH`, `Fill this OpenSea listing at exactly ${formatWei(value)} ETH via Seaport 1.6 on ${chain.name}. The NFT transfers to your wallet in the same transaction.`, {
        to: SEAPORT_1_6,
        data,
        value,
        chainId: chain.chainId,
      }),
    ],
    note: "Listings can be filled or cancelled by others at any moment — if this transaction reverts, re-run build_buy_nft for a fresh quote.",
    submit_with: SUBMIT_WITH,
  });
}
