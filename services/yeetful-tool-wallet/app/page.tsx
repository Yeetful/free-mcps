export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Yeetful Wallet MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Multichain wallet reads over MCP — the tools every DeFi conversation
        needs between the swaps: &quot;show my portfolio on Base and
        Arbitrum&quot;, &quot;do I have gas on Optimism?&quot;, &quot;did that
        transaction confirm?&quot;, &quot;what did this wallet do today?&quot;.
        Nine top EVM chains, USD-priced, live via Alchemy, spam filtered. Free,
        read-only.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://wallet-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>portfolio — every native + ERC-20 holding across 9 chains in one call, USD-priced, richest-first</li>
        <li>gas_balances — native balances everywhere (&quot;do I have gas there?&quot;)</li>
        <li>token_balance — one token, one chain, live (the post-transaction check)</li>
        <li>recent_transactions — sent + received transfers, merged newest-first, explorer links</li>
        <li>transaction_status — CONFIRMED / REVERTED / pending with confirmation count</li>
        <li>chains — Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Scroll, Gnosis</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Read-only by construction — every tool inspects public chain state;
        nothing here can sign, submit, or move funds. Pairs with action MCPs
        (Uniswap, CoW, NEAR Intents…) so the chat can show fresh balances the
        moment a transaction settles.
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
