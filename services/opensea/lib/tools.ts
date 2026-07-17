import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { clip, type OsResult } from "./util";
import { accountNfts, bestListings, bestOffer, collectionInfo, collectionStats, nftDetail, nftEvents } from "./reads";
import { buildBuyNft, buildCancelListing, buildListing, buildTransferNft, submitListing } from "./tx";
import { CHAIN_SLUGS } from "./registry";
import type { SeaportOrderComponents } from "./seaport";

function present(result: OsResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result.data === "string" ? result.data : `OpenSea service error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

const chainArg = z.enum(CHAIN_SLUGS).describe('Chain the NFT lives on: "ethereum", "base", or "arbitrum".');

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my NFTs" resolves to this.
const addressArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("EVM address (0x…). For the CONNECTED USER's own NFTs/actions, pass their wallet address ($USER_ADDRESS).");

const contractArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("The NFT contract address (0x…).");

const tokenIdArg = z.string().regex(/^\d+$/).describe('The token id as a decimal string, e.g. "2489".');

const slugArg = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/)
  .describe('The OpenSea collection slug, e.g. "pudgypenguins" (from get_account_nfts / get_nft `collection`).');

const orderHashArg = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("The Seaport order hash (0x…64 hex) of a live listing.");

const amount1155Arg = z
  .string()
  .regex(/^\d+$/)
  .default("1")
  .describe('Units to move/sell — only meaningful for ERC-1155 (default "1"; must be "1" for ERC-721).');

export function registerOpenseaTools(server: Server) {
  // ── Reads ────────────────────────────────────────────────────────────────

  server.registerTool(
    "get_account_nfts",
    {
      title: "NFTs owned by a wallet",
      description:
        "List the NFTs an address owns on one chain (most recently active first), with names, collection slugs, image URLs, and OpenSea links. START HERE for 'my NFTs' / 'what do I own'. Supports pagination via `next` and filtering to one collection.",
      inputSchema: {
        chain: chainArg,
        address: addressArg,
        limit: z.number().int().min(1).max(50).default(20).describe("Max NFTs to return (1–50, default 20)."),
        collection: slugArg.optional().describe("Optional: only NFTs from this collection slug."),
        next: z.string().optional().describe("Opaque pagination cursor from a previous call."),
      },
    },
    async ({ chain, address, limit, collection, next }) => present(await accountNfts(chain, address, limit, collection, next)),
  );

  server.registerTool(
    "get_nft",
    {
      title: "NFT detail",
      description: "One NFT's full detail: name, description, image, traits, current owners (with ERC-1155 quantities), and rarity rank.",
      inputSchema: { chain: chainArg, contract: contractArg, token_id: tokenIdArg },
    },
    async ({ chain, contract, token_id }) => present(await nftDetail(chain, contract, token_id)),
  );

  server.registerTool(
    "get_collection",
    {
      title: "Collection info",
      description: "Collection metadata: name, verification status, contracts, and the marketplace fee schedule every listing must honor.",
      inputSchema: { collection: slugArg },
    },
    async ({ collection }) => present(await collectionInfo(collection)),
  );

  server.registerTool(
    "get_collection_stats",
    {
      title: "Collection stats & floor price",
      description: "Floor price, total/one-day volume and sales, owner count, and average price for a collection.",
      inputSchema: { collection: slugArg },
    },
    async ({ collection }) => present(await collectionStats(collection)),
  );

  server.registerTool(
    "get_best_listings",
    {
      title: "Cheapest live listings",
      description: "The cheapest live listings in a collection (price in ETH, token id, order hash, seller). Order hashes feed build_buy_nft.",
      inputSchema: { collection: slugArg, limit: z.number().int().min(1).max(30).default(10).describe("Max listings (1–30, default 10).") },
    },
    async ({ collection, limit }) => present(await bestListings(collection, limit)),
  );

  server.registerTool(
    "get_best_offer",
    {
      title: "Best offer for an NFT",
      description: "The highest live offer on one NFT — what selling into the bid would fetch right now (usually priced in WETH).",
      inputSchema: { collection: slugArg, token_id: tokenIdArg },
    },
    async ({ collection, token_id }) => present(await bestOffer(collection, token_id)),
  );

  server.registerTool(
    "get_nft_events",
    {
      title: "NFT activity",
      description: "Recent sales, transfers, and listings for one NFT.",
      inputSchema: {
        chain: chainArg,
        contract: contractArg,
        token_id: tokenIdArg,
        limit: z.number().int().min(1).max(30).default(10).describe("Max events (1–30, default 10)."),
      },
    },
    async ({ chain, contract, token_id, limit }) => present(await nftEvents(chain, contract, token_id, limit)),
  );

  // ── Construction-only transactions ───────────────────────────────────────

  server.registerTool(
    "build_transfer_nft",
    {
      title: "Build: transfer an NFT",
      description:
        "Construct an UNSIGNED safeTransferFrom for an ERC-721 or ERC-1155 NFT (standard auto-detected, ownership verified on-chain first). Returns send_transaction steps for the USER's wallet. This service never signs.",
      inputSchema: {
        chain: chainArg,
        contract: contractArg,
        token_id: tokenIdArg,
        from: addressArg.describe("Current owner — the CONNECTED USER's wallet ($USER_ADDRESS)."),
        to: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe("Recipient address (0x…). Transfers are irreversible."),
        amount: amount1155Arg,
      },
    },
    async ({ chain, contract, token_id, from, to, amount }) => present(await buildTransferNft(chain, contract, token_id, from, to, amount)),
  );

  server.registerTool(
    "build_listing",
    {
      title: "Build: sell (list) an NFT on OpenSea",
      description:
        "Construct a fixed-price Seaport 1.6 sell listing: verifies ownership on-chain, derives the payout split from the collection's live fee schedule, and returns (a) a one-time conduit approval step if needed and (b) an EIP-712 order for the USER to sign (gasless). Publish the signed order with submit_listing.",
      inputSchema: {
        chain: chainArg,
        contract: contractArg,
        token_id: tokenIdArg,
        offerer: addressArg.describe("The seller — the CONNECTED USER's wallet ($USER_ADDRESS)."),
        price_eth: z.string().regex(/^\d+(\.\d+)?$/).describe('Asking price in ETH as a decimal string, e.g. "0.5".'),
        duration_hours: z.number().int().min(1).max(720).default(168).describe("Listing lifetime in hours (default 168 = 7 days, max 720 = 30 days)."),
        amount: amount1155Arg,
        include_creator_fees: z.boolean().default(false).describe("Also pay the collection's optional creator royalty (required fees are always included)."),
      },
    },
    async ({ chain, contract, token_id, offerer, price_eth, duration_hours, amount, include_creator_fees }) =>
      present(await buildListing(chain, contract, token_id, offerer, price_eth, duration_hours, amount, include_creator_fees)),
  );

  server.registerTool(
    "submit_listing",
    {
      title: "Submit a signed listing to OpenSea",
      description:
        "Relay a USER-signed Seaport order (from build_listing) to the OpenSea order book. Re-validates that every payout recipient is the offerer or a published fee recipient before relaying — tampered orders are refused.",
      inputSchema: {
        chain: chainArg,
        parameters: z.record(z.unknown()).describe("The signed OrderComponents message EXACTLY as returned by build_listing."),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/).describe("The user's EIP-712 signature over those parameters."),
      },
    },
    async ({ chain, parameters, signature }) => present(await submitListing(chain, parameters as unknown as SeaportOrderComponents, signature)),
  );

  server.registerTool(
    "build_cancel_listing",
    {
      title: "Build: cancel a listing",
      description:
        "Construct the on-chain Seaport cancel for one of the USER's own live listings (order fetched from OpenSea by hash; only the offerer can cancel).",
      inputSchema: {
        chain: chainArg,
        order_hash: orderHashArg,
        canceller: addressArg.describe("The listing's offerer — the CONNECTED USER's wallet ($USER_ADDRESS)."),
      },
    },
    async ({ chain, order_hash, canceller }) => present(await buildCancelListing(chain, order_hash, canceller)),
  );

  server.registerTool(
    "build_buy_nft",
    {
      title: "Build: buy a listed NFT",
      description:
        "Construct the UNSIGNED purchase of a live OpenSea listing: OpenSea supplies the fulfillment, this service re-encodes the calldata locally, pins the target to Seaport 1.6, checks the buyer's ETH balance, and enforces an optional max-price cap.",
      inputSchema: {
        chain: chainArg,
        order_hash: orderHashArg,
        buyer: addressArg.describe("The buyer — the CONNECTED USER's wallet ($USER_ADDRESS)."),
        max_price_eth: z.string().regex(/^\d+(\.\d+)?$/).optional().describe("Optional cap in ETH — refuse if the listing costs more."),
      },
    },
    async ({ chain, order_hash, buyer, max_price_eth }) => present(await buildBuyNft(chain, order_hash, buyer, max_price_eth)),
  );
}

// Kept in sync with get_account_nfts above — the Bazaar discovery extension
// validates this. The flagship read: a wallet's NFTs with images.
export const PRIMARY_TOOL = {
  name: "get_account_nfts",
  description: "List the NFTs an address owns on one chain, with images, collection slugs, and OpenSea links.",
} as const;
