export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Aave MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Aave v4 over MCP, via the official AaveKit API — hubs, spokes, and
        reserves with live supply/borrow APYs, per-address portfolio views
        (positions, earned interest, health factor, borrowing power), wallet
        balances with the best available yield, and construction-only
        supply/withdraw/borrow/repay transactions. Free, no API key.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://aave-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>markets / reserves — hubs, spokes, and every pool with live APYs, caps, collateral factors</li>
        <li>portfolio — positions, supplies + earned interest, borrows, health factor for any address</li>
        <li>balances — what a wallet holds that Aave lists, with the best supply APY for each</li>
        <li>activities — supply/borrow/repay/withdraw history</li>
        <li>preview — health factor + borrowing power AFTER a hypothetical action, before building it</li>
        <li>build_supply / build_withdraw / build_borrow / build_repay / build_collateral_toggle — unsigned transactions the user signs</li>
        <li>check_transaction — confirm a sent transaction has been indexed</li>
        <li>graphql_query — read-only escape hatch to the full AaveKit query surface</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — the AaveKit API only reads state and
        prepares calldata; the build_* tools return unsigned transactions for
        the USER&apos;s wallet to sign. No keys held, nothing submitted.
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
