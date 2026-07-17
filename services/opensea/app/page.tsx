export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>OpenSea NFT MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        OpenSea over MCP — the NFTs a wallet owns (with images) across
        Ethereum, Base, and Arbitrum, collection floor prices and stats, live
        listings and best offers, and construction-only NFT transactions:
        ERC-721/1155 transfers, Seaport 1.6 sell listings, cancels, and
        guarded buys. Free — the OpenSea API key lives server-side.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://opensea-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>get_account_nfts — a wallet&apos;s NFTs with names, collections, image URLs, OpenSea links</li>
        <li>get_nft / get_nft_events — one NFT&apos;s detail, traits, owners, rarity + recent activity</li>
        <li>get_collection / get_collection_stats — metadata, fee schedule, floor price, volume</li>
        <li>get_best_listings / get_best_offer — cheapest live listings + the top bid on one NFT</li>
        <li>build_transfer_nft — unsigned ERC-721/1155 safeTransferFrom, ownership verified on-chain</li>
        <li>build_listing → submit_listing — Seaport sell order the user signs (gasless), relayed after fee-schedule re-validation</li>
        <li>build_cancel_listing / build_buy_nft — on-chain cancel + guarded purchase of live listings</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — reads are public-by-address; every
        build verifies ownership and balances against real on-chain state and
        returns unsigned transactions (or an EIP-712 order) for the
        USER&apos;s wallet to sign. Listings can only pay the seller plus the
        collection&apos;s published fee recipients. No keys held, nothing
        submitted. Designed to flow into Yeetful&apos;s guardrail + sign
        pipeline.
      </p>

      <p style={{ color: "#8b93a7", marginTop: 24 }}>
        Service metadata: <a style={{ color: "#34e0a1" }} href="/api/info">/api/info</a>
      </p>
    </main>
  );
}

const pre: React.CSSProperties = {
  background: "#11141b",
  border: "1px solid #222836",
  borderRadius: 8,
  padding: "10px 14px",
  overflowX: "auto",
};
