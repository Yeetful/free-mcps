import { NextResponse } from "next/server";

// Free, unauthenticated discovery surface — what this service is. No payment
// block: this is a FREE Yeetful MCP (the public CoW order-book API needs no key).
export async function GET() {
  return NextResponse.json({
    name: "cow-mcp-free",
    upstream: "CoW Protocol order-book API (api.cow.fi — mainnet, gnosis, arbitrum, base, avalanche, polygon, bnb, sepolia)",
    mcpEndpoint: "/mcp",
    gated: false,
    pricing: { model: "free", rateLimit: "per-IP, see Retry-After on 429" },
    tools: [
      { name: "chains", description: "Supported networks, settlement + vault-relayer addresses, curated token symbols." },
      { name: "quote", description: "Price a swap (sell or buy kind) with human-readable amounts + network fee." },
      { name: "build_swap_order", description: "Quote + construct a ready-to-sign order: EIP-712 typed data, approval hint, appData." },
      { name: "build_limit_order", description: "Construct a limit order at YOUR price (up to 1 year, partial fills, fee-in-surplus)." },
      { name: "submit_order", description: "POST an already-signed order; returns orderUid + explorer link." },
      { name: "cancel_orders", description: "Gasless cancellation: typed data first, then submit with the user's signature." },
      { name: "order_status", description: "One order by UID: status, fill %, executed amounts, explorer link." },
      { name: "user_orders", description: "An address's open + recent orders, summarized." },
      { name: "user_trades", description: "An address's executed trades with settlement tx hashes." },
      { name: "portfolio", description: "Cross-chain CoW account view: open orders, fills, traded volume (order-book-derived)." },
      { name: "native_price", description: "The order book's token price in the chain's native currency." },
      { name: "solver_competition", description: "Which solvers bid on a settlement and who won (latest or by tx hash)." },
      { name: "api_get", description: "Read-only escape hatch to allowlisted order-book GET paths." },
      { name: "docs_search", description: "Search the bundled official CoW Protocol docs (mechanics, solvers, MEV, fees, tokenomics)." },
      { name: "docs_page", description: "Read one bundled docs page in full." },
    ],
    safety:
      "Signature-free by construction — this service NEVER holds keys. Order construction returns EIP-712 typed data for the CLIENT's wallet to sign; submission only accepts an already-produced signature; cancellation is the same two-phase pattern. Reads are public-by-address; the connected user's address arrives via Yeetful's $USER_ADDRESS context.",
  });
}
