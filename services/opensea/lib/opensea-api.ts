// OpenSea REST API v2 surface (api.opensea.io). Every call needs an API key
// (OPENSEA_API_KEY) — reads fail honestly when it's missing rather than
// guessing. Response shapes below are the LIVE probed truth (validated
// 2026-07-17), pinned by fixtures in tests/.

import { fail, type OsResult } from "./util";

const API_BASE = () => process.env.OPENSEA_API_URL ?? "https://api.opensea.io/api/v2";

// Injectable seam for tests — production uses global fetch.
let fetchImpl: typeof fetch | null = null;
export function setFetchForTests(fake: typeof fetch | null) {
  fetchImpl = fake;
}

function apiKey(): string | null {
  return process.env.OPENSEA_API_KEY || null;
}

const NO_KEY_MSG =
  "OPENSEA_API_KEY is not set on this service, so OpenSea reads are unavailable. Nothing was fetched.";

async function request(path: string, init?: RequestInit): Promise<OsResult> {
  const key = apiKey();
  if (!key) return fail(401, NO_KEY_MSG);
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API_BASE()}${path}`, {
      ...init,
      headers: { accept: "application/json", "x-api-key": key, ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch (e) {
    return fail(502, `OpenSea API unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail = typeof parsed === "string" ? parsed.slice(0, 400) : JSON.stringify(parsed).slice(0, 400);
    return fail(res.status, `OpenSea API error (HTTP ${res.status}): ${detail}`);
  }
  return { ok: true, status: res.status, data: parsed };
}

const getJson = (path: string) => request(path);
const postJson = (path: string, body: unknown) =>
  request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── Raw shapes (the fields we actually consume) ────────────────────────────

export interface RawNft {
  identifier: string;
  collection: string;
  contract: string;
  token_standard: string; // "erc721" | "erc1155"
  name: string | null;
  description?: string | null;
  image_url?: string | null;
  display_image_url?: string | null;
  opensea_url?: string | null;
  metadata_url?: string | null;
  updated_at?: string;
  traits?: { trait_type?: string; value?: unknown }[] | null;
  owners?: { address: string; quantity: number }[] | null;
  rarity?: { rank?: number | null } | null;
}

export interface RawCollectionFee {
  fee: number; // percent, e.g. 1.0 = 1%
  recipient: string;
  required: boolean;
}

export interface RawCollection {
  collection: string;
  name: string;
  description?: string | null;
  image_url?: string | null;
  owner?: string;
  safelist_status?: string;
  category?: string;
  opensea_url?: string;
  fees?: RawCollectionFee[];
  required_zone?: string | null;
  contracts?: { address: string; chain: string }[];
  total_supply?: number;
}

export interface RawOrder {
  order_hash: string;
  chain: string;
  price?: { current?: { currency?: string; decimals?: number; value?: string } };
  protocol_data?: { parameters?: Record<string, unknown>; signature?: string | null };
  protocol_address?: string;
  expiration_time?: number;
  remaining_quantity?: number;
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** NFTs owned by an account on one chain, most recently updated first. */
export function fetchAccountNfts(chain: string, address: string, limit: number, collection?: string, next?: string) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (collection) params.set("collection", collection);
  if (next) params.set("next", next);
  return getJson(`/chain/${chain}/account/${address}/nfts?${params}`);
}

/** Single NFT: metadata, traits, owners, rarity. */
export function fetchNft(chain: string, contract: string, identifier: string) {
  return getJson(`/chain/${chain}/contract/${contract}/nfts/${identifier}`);
}

/** Collection metadata + marketplace fees (the sell-flow anchor). */
export function fetchCollection(slug: string) {
  return getJson(`/collections/${slug}`);
}

/** Collection stats: floor price, volume, owners, sales. */
export function fetchCollectionStats(slug: string) {
  return getJson(`/collections/${slug}/stats`);
}

/** Cheapest live listings in a collection. */
export function fetchBestListings(slug: string, limit: number) {
  return getJson(`/listings/collection/${slug}/best?limit=${limit}`);
}

/** Best (highest) live offer for one NFT. */
export function fetchBestOffer(slug: string, identifier: string) {
  return getJson(`/offers/collection/${slug}/nfts/${identifier}/best`);
}

/** Recent events (sales/transfers/listings) for one NFT. */
export function fetchNftEvents(chain: string, contract: string, identifier: string, limit: number) {
  return getJson(`/events/chain/${chain}/contract/${contract}/nfts/${identifier}?limit=${limit}`);
}

/** One order (listing) by hash — the cancel-flow anchor. */
export function fetchOrder(chain: string, protocolAddress: string, orderHash: string) {
  return getJson(`/orders/chain/${chain}/protocol/${protocolAddress}/${orderHash}`);
}

// ── Writes (relay only — the USER signed, we just forward) ────────────────

/** Submit a signed Seaport listing to the OpenSea order book. */
export function postListing(chain: string, parameters: Record<string, unknown>, signature: string, protocolAddress: string) {
  return postJson(`/orders/${chain}/seaport/listings`, {
    parameters,
    signature,
    protocol_address: protocolAddress,
  });
}

/** Ask OpenSea for the exact fulfillment transaction for a live listing. */
export function fetchListingFulfillment(chain: string, orderHash: string, protocolAddress: string, fulfiller: string) {
  return postJson(`/listings/fulfillment_data`, {
    listing: { hash: orderHash, chain, protocol_address: protocolAddress },
    fulfiller: { address: fulfiller },
  });
}
