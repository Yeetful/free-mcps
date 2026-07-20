// The PAID door — the x402 packaging of this exact service. Served at
// `/paid/mcp` (+ `/paid/sse`), gated per-call by proxy.ts's x402 v2 challenge.
// It registers the IDENTICAL tool surface as the free door — payment buys the
// un-throttled door, not different tools, so the tiers can never drift.
import { createCleanMcpHandler } from "@yeetful/mcp-kit";
import { registerFundingTools } from "@/lib/tools";

const handler = createCleanMcpHandler(
  (server) => {
    registerFundingTools(server);
  },
  { basePath: "/paid" },
);

export { handler as GET, handler as POST, handler as DELETE };
