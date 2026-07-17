import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the OpenSea API key lives server-side;
// callers never need one).
export async function GET() {
  return NextResponse.json({
    name: "opensea-mcp-free",
    upstream:
      "OpenSea API v2 (api.opensea.io) for NFT portfolios, collections, floor prices, listings, and offers across Ethereum, Base, and Arbitrum — plus direct public-RPC reads (ownership, approvals, Seaport counters) that anchor every transaction build on-chain",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "get_account_nfts", description: "NFTs a wallet owns on one chain — names, collections, image URLs, OpenSea links. The flagship read." },
      { name: "get_nft", description: "One NFT's full detail: metadata, traits, owners, rarity rank." },
      { name: "get_collection", description: "Collection metadata + the marketplace fee schedule listings must honor." },
      { name: "get_collection_stats", description: "Floor price, volume, sales, owner count." },
      { name: "get_best_listings", description: "Cheapest live listings in a collection (order hashes feed build_buy_nft)." },
      { name: "get_best_offer", description: "Highest live offer on one NFT — what selling into the bid fetches." },
      { name: "get_nft_events", description: "Recent sales/transfers/listings for one NFT." },
      { name: "build_transfer_nft", description: "Unsigned ERC-721/ERC-1155 safeTransferFrom — ownership verified on-chain first." },
      { name: "build_listing", description: "Seaport 1.6 sell order: conduit approval step if needed + an EIP-712 payload the USER signs (gasless)." },
      { name: "submit_listing", description: "Relay a USER-signed order to OpenSea after re-validating every payout recipient against the collection's fee schedule." },
      { name: "build_cancel_listing", description: "Unsigned on-chain Seaport cancel for the user's own listing." },
      { name: "build_buy_nft", description: "Unsigned purchase of a live listing — calldata re-encoded locally, target pinned to Seaport 1.6, balance-checked, optional price cap." },
    ],
    safety:
      "Signature-free by construction — reads are public-by-address; build_* tools verify ownership/balances against REAL on-chain state and return unsigned {to,data,value,chainId} transactions (or an EIP-712 order) for the USER's wallet to sign. Listings can only pay the offerer + the collection's published fee recipients — submit_listing re-checks this before relaying. No keys held, nothing signed, nothing submitted on-chain. The connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
