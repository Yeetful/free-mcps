import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

describe("uniswap free front door (rate limit, NO payment gate)", () => {
  it("lets a normal request fall through to the MCP handler (no 402)", async () => {
    const { proxy } = await import("@/proxy");

    const req = new NextRequest("https://uniswap-free.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
    });

    const res = proxy(req);
    expect(res).toBeUndefined(); // undefined = fall through, no challenge
  });

  it("returns 429 with Retry-After once the per-IP limit is exceeded", async () => {
    const { createRateLimitProxy } = await import("@yeetful/mcp-kit");
    const limited = createRateLimitProxy({ limitPerMinute: 3 });

    const mk = () =>
      new NextRequest("https://uniswap-free.test/mcp", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

    for (let i = 0; i < 3; i++) expect(limited(mk())).toBeUndefined();

    const blocked = limited(mk());
    expect(blocked).toBeDefined();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
    const body = await blocked!.json();
    expect(body.error).toBe("rate_limited");
  });

  it("rate-limits per IP, not globally", async () => {
    const { createRateLimitProxy } = await import("@yeetful/mcp-kit");
    const limited = createRateLimitProxy({ limitPerMinute: 1 });

    const reqA = new NextRequest("https://uniswap-free.test/mcp", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.3" },
    });
    const reqB = new NextRequest("https://uniswap-free.test/mcp", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.4" },
    });

    expect(limited(reqA)).toBeUndefined();
    expect(limited(reqB)).toBeUndefined(); // different IP, own bucket
  });
});
