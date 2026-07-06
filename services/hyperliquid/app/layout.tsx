import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hyperliquid MCP · Yeetful",
  description:
    "Hyperliquid over MCP — live perp + spot markets, orderbooks, funding, and per-address portfolio views (positions, balances, open orders, fills) straight from the public Hyperliquid API, plus real-time settlement watching over WebSocket. Free, no API key.",
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
