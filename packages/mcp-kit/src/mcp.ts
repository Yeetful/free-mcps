import { createMcpHandler } from "mcp-handler";

/**
 * Create the MCP route handler on a CLEAN path.
 *
 * Placed at `app/[transport]/route.ts` with an empty basePath, the handler is
 * served at `/mcp` (Streamable HTTP) and `/sse` — i.e. `uniswap.yeetful.com/mcp`,
 * NOT the doubled `/api/mcp/mcp`. The `[transport]` segment is what mcp-handler
 * uses to pick the transport, so the visible single `/mcp` is the transport
 * name, not a redundant prefix.
 *
 * Re-export the result as GET/POST/DELETE from the route file.
 */
export function createCleanMcpHandler(
  register: Parameters<typeof createMcpHandler>[0],
  opts: { maxDuration?: number; verboseLogs?: boolean } = {},
) {
  return createMcpHandler(
    register,
    {},
    {
      // Empty basePath → the route lives at app/[transport] → public `/mcp`.
      basePath: "",
      maxDuration: opts.maxDuration ?? 60,
      verboseLogs: opts.verboseLogs ?? process.env.NODE_ENV !== "production",
    },
  );
}
