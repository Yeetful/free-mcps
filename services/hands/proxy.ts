// Free door only: per-IP rate limit on the MCP paths (the fleet default).
import type { NextRequest } from "next/server";
import { createRateLimitProxy } from "@yeetful/mcp-kit";

const free = createRateLimitProxy();

export function proxy(req: NextRequest) {
  return free(req);
}

export const config = { matcher: ["/mcp", "/sse"] };
