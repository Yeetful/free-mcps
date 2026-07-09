export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>NEAR Intents MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Cross-chain swaps over MCP, via the official NEAR Intents 1Click API —
        move any supported asset to any other across ~30 chains (USDC on Base →
        USDC on Arbitrum, ETH → SOL, USDC → BTC…) with a single transfer. Quote
        it, sign one deposit transaction, and solvers deliver on the
        destination chain. No bridge UI, no wrapped tokens. Free, no API key
        required to call.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://near-intents-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>how_it_works — the quote → deposit → settle → verify flow, explained for agents and users</li>
        <li>chains / tokens — every supported blockchain and swappable asset, with live USD prices</li>
        <li>quote — dry-run preview: expected output, minimum after slippage, fees, ETA (commits nothing)</li>
        <li>build_swap — the real thing: a one-time deposit address plus the single unsigned transfer the user signs</li>
        <li>submit_deposit_tx — hand 1Click the confirmed deposit hash so pickup is instant</li>
        <li>check_status / await_completion — track the swap to SUCCESS with explorer links on both chains</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — the 1Click API prices swaps and issues
        one-time deposit addresses; the build tool returns an unsigned
        transaction for the USER&apos;s wallet to sign. Unfillable swaps
        auto-refund to the origin address. No keys held, nothing submitted.
        Designed to flow into Yeetful&apos;s guardrail + sign pipeline.
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
