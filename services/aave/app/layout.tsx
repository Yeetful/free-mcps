import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Aave MCP · Yeetful",
  description:
    "Aave over MCP — v4 markets with live supply/borrow APYs, per-address portfolio views (positions, earnings, health factor, borrowing power), and construction-only supply/withdraw/borrow/repay transactions via the official AaveKit API. Free, no API key. This service never signs.",
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
