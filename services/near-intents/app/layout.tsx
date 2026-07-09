import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NEAR Intents MCP · Yeetful",
  description:
    "Cross-chain swaps over MCP via the official NEAR Intents 1Click API — quote any asset to any other across ~30 chains, build the single deposit transfer the user signs, and track the swap to delivery with explorer links. Free, no bridge UI. This service never signs.",
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
