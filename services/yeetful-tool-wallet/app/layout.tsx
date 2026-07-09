import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Yeetful Wallet MCP · Yeetful",
  description:
    "Multichain wallet reads over MCP — USD-priced portfolios, gas balances, token balances, recent transactions, and transaction status across 9 top EVM chains via Alchemy. Free, read-only, no API key required to call.",
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
