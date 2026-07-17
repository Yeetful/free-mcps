// Read tools — thin shapers over the OpenSea v2 API. Each returns the
// service envelope with a compact, model-friendly payload: image URLs kept
// (the chat splash renders thumbnails), raw pagination cursors passed
// through, and everything else trimmed.

import {
  fetchAccountNfts,
  fetchBestListings,
  fetchBestOffer,
  fetchCollection,
  fetchCollectionStats,
  fetchNft,
  fetchNftEvents,
  type RawCollection,
  type RawNft,
  type RawOrder,
} from "./opensea-api";
import { chainBySlug } from "./registry";
import { fail, formatWei, isEvmAddress, ok, type OsResult } from "./util";

export interface NftSummary {
  identifier: string;
  name: string | null;
  collection: string;
  contract: string;
  standard: string;
  image_url: string | null;
  opensea_url: string | null;
  updated_at: string | null;
}

export function shapeNft(raw: RawNft): NftSummary {
  return {
    identifier: raw.identifier,
    name: raw.name ?? null,
    collection: raw.collection,
    contract: raw.contract,
    standard: raw.token_standard,
    image_url: raw.display_image_url ?? raw.image_url ?? null,
    opensea_url: raw.opensea_url ?? null,
    updated_at: raw.updated_at ?? null,
  };
}

const badChain = (chain: string) =>
  fail(400, `Unsupported chain "${chain}" — this service covers ethereum, base, and arbitrum.`);

/** NFTs owned by an account (most recently active first). */
export async function accountNfts(chain: string, address: string, limit = 20, collection?: string, next?: string): Promise<OsResult> {
  if (!chainBySlug(chain)) return badChain(chain);
  if (!isEvmAddress(address)) return fail(400, `"${address}" is not a valid EVM address.`);
  const r = await fetchAccountNfts(chain, address, Math.min(Math.max(limit, 1), 50), collection, next);
  if (!r.ok) return r;
  const d = r.data as { nfts?: RawNft[]; next?: string };
  const nfts = (d.nfts ?? []).map(shapeNft);
  return ok({
    chain,
    address,
    count: nfts.length,
    nfts,
    next: d.next ?? null,
    note: nfts.length === 0 ? "No NFTs found for this account on this chain." : undefined,
  });
}

/** One NFT: metadata, traits, owners, rarity. */
export async function nftDetail(chain: string, contract: string, identifier: string): Promise<OsResult> {
  if (!chainBySlug(chain)) return badChain(chain);
  if (!isEvmAddress(contract)) return fail(400, `"${contract}" is not a valid contract address.`);
  const r = await fetchNft(chain, contract, identifier);
  if (!r.ok) return r;
  const raw = (r.data as { nft?: RawNft }).nft;
  if (!raw) return fail(404, `NFT ${contract} #${identifier} not found on ${chain}.`);
  return ok({
    ...shapeNft(raw),
    description: raw.description ?? null,
    owners: (raw.owners ?? []).map((o) => ({ address: o.address, quantity: o.quantity })),
    rarity_rank: raw.rarity?.rank ?? null,
    traits: (raw.traits ?? []).slice(0, 40).map((t) => ({ type: t.trait_type ?? "?", value: t.value })),
  });
}

/** Collection metadata + the fee schedule listings must honor. */
export async function collectionInfo(slug: string): Promise<OsResult> {
  const r = await fetchCollection(slug);
  if (!r.ok) return r;
  const c = r.data as RawCollection;
  return ok({
    slug: c.collection,
    name: c.name,
    description: (c.description ?? "").slice(0, 400) || null,
    image_url: c.image_url ?? null,
    opensea_url: c.opensea_url ?? null,
    verified: c.safelist_status === "verified",
    category: c.category ?? null,
    total_supply: c.total_supply ?? null,
    contracts: c.contracts ?? [],
    fees: (c.fees ?? []).map((f) => ({ percent: f.fee, recipient: f.recipient, required: f.required })),
  });
}

/** Floor price, volume, owner counts. */
export async function collectionStats(slug: string): Promise<OsResult> {
  const r = await fetchCollectionStats(slug);
  if (!r.ok) return r;
  const d = r.data as {
    total?: { floor_price?: number; floor_price_symbol?: string; volume?: number; sales?: number; num_owners?: number; market_cap?: number; average_price?: number };
    intervals?: { interval?: string; volume?: number; sales?: number; average_price?: number }[];
  };
  const day = (d.intervals ?? []).find((i) => i.interval === "one_day");
  return ok({
    slug,
    floor_price: d.total?.floor_price ?? null,
    floor_price_symbol: d.total?.floor_price_symbol ?? "ETH",
    total_volume: d.total?.volume ?? null,
    total_sales: d.total?.sales ?? null,
    num_owners: d.total?.num_owners ?? null,
    average_price: d.total?.average_price ?? null,
    one_day: day ? { volume: day.volume ?? null, sales: day.sales ?? null, average_price: day.average_price ?? null } : null,
  });
}

function shapeOrder(o: RawOrder) {
  const params = (o.protocol_data?.parameters ?? {}) as {
    offerer?: string;
    offer?: { token?: string; identifierOrCriteria?: string }[];
    endTime?: string;
  };
  const priceWei = o.price?.current?.value ?? null;
  return {
    order_hash: o.order_hash,
    chain: o.chain,
    price_eth: priceWei ? formatWei(BigInt(priceWei)) : null,
    price_currency: o.price?.current?.currency ?? "ETH",
    offerer: params.offerer ?? null,
    token: params.offer?.[0]?.token ?? null,
    identifier: params.offer?.[0]?.identifierOrCriteria ?? null,
    expires_at: params.endTime ? new Date(Number(params.endTime) * 1000).toISOString() : null,
  };
}

/** Cheapest live listings in a collection. */
export async function bestListings(slug: string, limit = 10): Promise<OsResult> {
  const r = await fetchBestListings(slug, Math.min(Math.max(limit, 1), 30));
  if (!r.ok) return r;
  const d = r.data as { listings?: RawOrder[] };
  const listings = (d.listings ?? []).map(shapeOrder);
  return ok({ slug, count: listings.length, listings });
}

/** Best live offer for one NFT (what a "sell now" would fetch). */
export async function bestOffer(slug: string, identifier: string): Promise<OsResult> {
  const r = await fetchBestOffer(slug, identifier);
  if (!r.ok) {
    if (r.status === 404) return ok({ slug, identifier, offer: null, note: "No live offers for this NFT." });
    return r;
  }
  const o = r.data as RawOrder & { price?: { currency?: string; decimals?: number; value?: string } };
  // The best-offer endpoint prices at the top level (WETH, 18 dec), not under `current`.
  const flat = o.price && "value" in o.price ? (o.price as { currency?: string; value?: string }) : null;
  const priceWei = o.price?.current?.value ?? flat?.value ?? null;
  return ok({
    slug,
    identifier,
    offer: {
      order_hash: o.order_hash,
      price: priceWei ? formatWei(BigInt(priceWei)) : null,
      currency: o.price?.current?.currency ?? flat?.currency ?? "WETH",
    },
  });
}

/** Recent sales/transfers/listings for one NFT. */
export async function nftEvents(chain: string, contract: string, identifier: string, limit = 10): Promise<OsResult> {
  if (!chainBySlug(chain)) return badChain(chain);
  if (!isEvmAddress(contract)) return fail(400, `"${contract}" is not a valid contract address.`);
  const r = await fetchNftEvents(chain, contract, identifier, Math.min(Math.max(limit, 1), 30));
  if (!r.ok) return r;
  const d = r.data as {
    asset_events?: {
      event_type?: string;
      event_timestamp?: number;
      from_address?: string;
      to_address?: string;
      seller?: string;
      buyer?: string;
      payment?: { quantity?: string; symbol?: string; decimals?: number };
      quantity?: number;
    }[];
  };
  const events = (d.asset_events ?? []).map((e) => ({
    type: e.event_type ?? "?",
    at: e.event_timestamp ? new Date(e.event_timestamp * 1000).toISOString() : null,
    from: e.from_address ?? e.seller ?? null,
    to: e.to_address ?? e.buyer ?? null,
    quantity: e.quantity ?? 1,
    payment:
      e.payment?.quantity && e.payment.decimals != null
        ? `${(Number(e.payment.quantity) / 10 ** e.payment.decimals).toFixed(4)} ${e.payment.symbol ?? ""}`.trim()
        : null,
  }));
  return ok({ chain, contract, identifier, count: events.length, events });
}
