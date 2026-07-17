import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OpenSea NFT MCP · Yeetful",
  description:
    "OpenSea over MCP — wallet NFT portfolios with images across Ethereum/Base/Arbitrum, collection floor prices and stats, live listings and offers, plus construction-only NFT transactions: ERC-721/1155 transfers, Seaport sell listings, cancels, and guarded buys. This service never signs.",
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
