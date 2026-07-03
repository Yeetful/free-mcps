export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Snapshot DAO MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Browse Snapshot DAO proposals and votes, and build an EIP-712 vote the user
        signs with their own wallet. Pay-per-call in USDC on Base. No API key.
        Powered by x402.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://snapshot.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>list_proposals — recent/active DAO proposals (filter by space + state)</li>
        <li>get_proposal — full proposal detail (body, choices, scores, type)</li>
        <li>list_votes — votes cast on a proposal, by voting power</li>
        <li>get_space — DAO space metadata</li>
        <li>list_spaces — browse DAO spaces</li>
        <li>prepare_vote — build the EIP-712 vote for the voter to sign</li>
        <li>submit_vote — relay the signed vote to Snapshot</li>
      </ul>

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
