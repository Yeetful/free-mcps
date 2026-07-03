export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Uniswap MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Uniswap on Base, read straight from the contracts — live quotes across every
        v3 fee tier (QuoterV2), spot prices, v3 + v4 pool state, and deterministic
        swap-transaction building the user signs with their own wallet. No API key,
        no indexer. Pay-per-call in USDC on Base. Powered by x402.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://uniswap.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>quote — live exact-in quote across every v3 fee tier (best tier + gas)</li>
        <li>price — spot price from the most liquid pool</li>
        <li>pool_info — v3 pools per tier + canonical v4 pools (incl. native-ETH)</li>
        <li>build_swap — swap tx to sign: fresh quote → min-out → SwapRouter02 calldata, approve step included, eth_call dry-run</li>
        <li>build_wrap / build_unwrap — ETH ↔ WETH</li>
        <li>convert_amount — human amount ↔ atoms with real on-chain decimals</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Builds only — never holds keys, never signs, never submits. The swap
        recipient is always the payer. Designed to flow into Yeetful&apos;s
        guardrail + sign pipeline.
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
