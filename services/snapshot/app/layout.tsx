import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Snapshot DAO MCP · Yeetful",
  description:
    "Snapshot DAO governance over MCP — browse proposals/votes and build an EIP-712 vote to sign. Pay-per-call in USDC on Base. No API key. Powered by x402.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0a0c10",
          color: "#e6e9ef",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
