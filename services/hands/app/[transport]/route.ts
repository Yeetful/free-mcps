// MCP endpoint on a CLEAN path — served at `/mcp` (Streamable HTTP) + `/sse`.
import { createCleanMcpHandler } from "@yeetful/mcp-kit";
import { registerHandsTools } from "@/lib/tools";

const handler = createCleanMcpHandler((server) => {
  registerHandsTools(server);
});

export { handler as GET, handler as POST, handler as DELETE };
