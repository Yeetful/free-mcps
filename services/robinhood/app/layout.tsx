import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Robinhood Chain MCP · Yeetful",
  description:
    "Robinhood Chain over MCP — tokenized stocks & ETFs with live Chainlink prices, wallet portfolio views, Morpho lending/borrowing, Uniswap v4 swap quotes, and construction-only swap/lend/borrow/bridge transactions. Free, no API key. This service never signs.",
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
