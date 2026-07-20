import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { NextRequest } from "next/server";

// base-sepolia so the public x402.org facilitator advertises the exact scheme
// the v2 proxy needs to emit a challenge; envelope shape identical to mainnet.
// (Same pattern as x402-services' payment-gate tests.)
beforeAll(() => {
  process.env.PAYMENT_ADDRESS ??= "0x66268791B55e1F5fA585D990326519F101407257";
  process.env.X402_NETWORK ??= "base-sepolia";
  process.env.X402_PRICE_USD ??= "0.02";
});

describe("funding paid door (x402 v2 at /paid/mcp)", () => {
  it("returns HTTP 402 with a v2 PAYMENT-REQUIRED challenge on /paid/mcp", async () => {
    const { proxy } = await import("@/proxy");

    const req = new NextRequest("https://funding.test/paid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const res = await proxy(req);
    expect(res).toBeDefined();
    expect(res!.status).toBe(402);

    const header = res!.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const challenge = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));

    expect(challenge.x402Version).toBe(2);
    expect(challenge.resource?.url).toBe("https://funding.test/paid/mcp");

    const accept = challenge.accepts[0];
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:84532");

    // Bazaar discovery advertises the composite, schema present.
    const bazaar = challenge.extensions?.bazaar;
    expect(bazaar?.info).toBeTruthy();
    expect(bazaar?.schema).toBeTruthy();
    expect(JSON.stringify(bazaar)).toContain("fund_and_build");
  });

  it("leaves the FREE door untouched — /mcp falls through with no challenge", async () => {
    const { proxy } = await import("@/proxy");

    const req = new NextRequest("https://funding.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.1" },
    });

    expect(await proxy(req)).toBeUndefined();
  });
});

describe("unconfigured paid door fails CLOSED", () => {
  const saved = process.env.PAYMENT_ADDRESS;
  afterEach(() => {
    process.env.PAYMENT_ADDRESS = saved;
  });

  it("503s with a pointer to the free door when PAYMENT_ADDRESS is unset", async () => {
    delete process.env.PAYMENT_ADDRESS;
    const { createPaidDoorProxy } = await import("@yeetful/mcp-kit/x402");
    const gate = createPaidDoorProxy({ routeKey: "/paid/:transport", description: "test" });

    const res = await gate(
      new NextRequest("https://funding.test/paid/mcp", { method: "POST" }),
    );
    expect(res?.status).toBe(503);
    const body = await res!.json();
    expect(body.error).toBe("paid_door_unconfigured");
    expect(body.message).toContain("/mcp");
  });
});
