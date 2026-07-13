export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Lido MCP</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        Lido staking over MCP — protocol stats with live APR, per-address
        position views (stETH + wstETH balances, staked value, earnings
        history), withdrawal-queue tracking, and construction-only
        stake/wrap/unwrap/withdraw/claim transactions on Ethereum mainnet.
        Free, no API key.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>Endpoint</h2>
      <pre style={pre}>POST https://lido-mcp.yeetful.com/mcp</pre>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Tools</h2>
      <ul style={{ color: "#cdd3df" }}>
        <li>stats — staking APR (7-day SMA + latest), total ETH staked, stETH↔wstETH rate, queue state</li>
        <li>position — stETH + wstETH balances, staked value in ETH and USD, pending withdrawals for any address</li>
        <li>earnings — total staking rewards, average APR, and recent daily rebase events from Lido&apos;s reward history</li>
        <li>withdrawals — per-request queue status (pending / claimable / claimed) + wait estimate</li>
        <li>convert — ETH ↔ stETH ↔ wstETH at the live on-chain rate</li>
        <li>build_stake / build_wrap / build_unwrap / build_request_withdrawal / build_claim — unsigned transactions the user signs</li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Safety</h2>
      <p style={{ color: "#8b93a7" }}>
        Signature-free by construction — this service only reads public state
        and prepares calldata; the build_* tools return unsigned transactions
        for the USER&apos;s wallet to sign. No keys held, nothing submitted.
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
