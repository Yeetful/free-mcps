const pre: React.CSSProperties = {
  background: "#11141b",
  border: "1px solid #232838",
  borderRadius: 8,
  padding: "10px 14px",
  overflowX: "auto",
  color: "#cdd3df",
};

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Yeetful Hands</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Give your agent hands that can&apos;t steal. One MCP URL and any agent —
        Claude Desktop, Claude Code, OpenClaw, your own — can scan a wallet&apos;s
        movable money, plan an action Yeetful knows how to build (stock buys on
        Robinhood Chain, swaps, recurring buys, stop-losses, staking, votes),
        and hand its human ONE link where the guarded build happens and their
        own wallet signs. This service never returns calldata, artifacts, or
        addresses: the agent plans, Yeetful&apos;s deterministic builders rebuild,
        the human stays the only signer.
      </p>
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>Connect</h2>
      <pre style={pre}>
        <code>claude mcp add --transport http yeetful-hands https://hands-mcp.yeetful.com/mcp</code>
      </pre>
      <p style={{ color: "#8b93a7" }}>
        Tools: <code>what_yeetful_can_do</code> · <code>scan_wallet</code> ·{" "}
        <code>prepare_handoff</code> · <code>plan_stock_buy</code>. Free +
        rate-limited; discovery at <code>/api/info</code>. By{" "}
        <a href="https://yeetful.com" style={{ color: "#7dd3a8" }}>
          yeetful.com
        </a>
        .
      </p>
    </main>
  );
}
