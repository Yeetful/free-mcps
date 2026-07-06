export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>CoW Protocol MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        CoW Protocol over MCP, straight from the public order-book API — swap
        quotes, ready-to-sign EIP-712 orders (market swaps and limit orders),
        signed-order submission, per-address order/trade/portfolio views, and
        solver-competition data across 8 chains. Plus the official CoW docs,
        bundled and searchable, for &quot;how does CoW work&quot; questions.
        Free, no API key.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://cow-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>chains / quote / native_price — networks, swap pricing, solver price feed</li>
        <li>build_swap_order / build_limit_order — EIP-712 typed data the USER&apos;s wallet signs</li>
        <li>submit_order / cancel_orders — relay already-signed orders + gasless cancellations</li>
        <li>order_status / user_orders / user_trades / portfolio — the account&apos;s full order-book activity</li>
        <li>solver_competition — who bid, who won, the settlement tx</li>
        <li>api_get — read-only escape hatch to allowlisted order-book paths</li>
        <li>docs_search / docs_page — the official CoW docs, offline</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — this service never holds a key. Order
        construction returns EIP-712 typed data for the client to sign;
        submission accepts only an already-produced signature. Designed to flow
        into Yeetful&apos;s guardrail + sign pipeline.
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
