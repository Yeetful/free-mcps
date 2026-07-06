import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CoW Protocol MCP · Yeetful",
  description:
    "CoW Protocol over MCP — swap quotes, EIP-712 order construction (swaps + limit orders the USER signs), signed-order submission, per-address order/trade/portfolio views, solver competition data, and the official CoW docs, searchable offline. Free, no API key, no keys held.",
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
