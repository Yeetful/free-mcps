import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lido MCP · Yeetful",
  description:
    "Lido over MCP — stETH/wstETH staking on Ethereum with live APR, per-address position and earnings views, withdrawal-queue tracking, and construction-only stake/wrap/unwrap/withdraw/claim transactions. Free, no API key. This service never signs.",
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
