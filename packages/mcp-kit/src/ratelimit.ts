import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-IP sliding-window rate limit for the free MCP services.
 *
 * A paid x402 service has a natural throttle — every call costs USDC. A free
 * service has none, so this proxy is the front door. In-memory and therefore
 * per-instance (fine for basic abuse protection on Vercel; a determined
 * attacker across many instances is a CDN/WAF problem, not an app problem).
 *
 * Usage in a service's `proxy.ts` (Next 16: proxy.ts IS the middleware):
 *
 *   import { createRateLimitProxy } from "@yeetful/mcp-kit";
 *   export const proxy = createRateLimitProxy();
 *   export const config = { matcher: ["/mcp", "/sse"] };
 */
export function createRateLimitProxy(
  opts: { limitPerMinute?: number } = {},
): (req: NextRequest) => NextResponse | undefined {
  const limit =
    opts.limitPerMinute ??
    Number(process.env.RATE_LIMIT_PER_MINUTE || "") ??
    60;
  const effective = Number.isFinite(limit) && limit > 0 ? limit : 60;
  const WINDOW_MS = 60_000;
  const hits = new Map<string, number[]>();

  return function rateLimitProxy(req: NextRequest): NextResponse | undefined {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const now = Date.now();

    const windowStart = now - WINDOW_MS;
    const prior = hits.get(ip)?.filter((t) => t > windowStart) ?? [];
    if (prior.length >= effective) {
      hits.set(ip, prior);
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `Free tier is limited to ${effective} requests/minute per IP. Back off and retry.`,
          retryAfterSeconds: Math.ceil((prior[0]! + WINDOW_MS - now) / 1000),
        },
        { status: 429, headers: { "Retry-After": String(Math.ceil((prior[0]! + WINDOW_MS - now) / 1000)) } },
      );
    }
    prior.push(now);
    hits.set(ip, prior);

    // Opportunistic cleanup so the map doesn't grow unbounded.
    if (hits.size > 10_000) {
      for (const [key, times] of hits) {
        if (times.every((t) => t <= windowStart)) hits.delete(key);
      }
    }
    return undefined; // fall through to the MCP handler
  };
}
