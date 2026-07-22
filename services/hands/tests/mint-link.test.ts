import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRedirect, mintIntentLink } from "../lib/mint-link";

const KEY = `yf_${"a".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YEETFUL_API_KEY;
});

describe("checkRedirect", () => {
  it("accepts a public https URL", () => {
    expect(checkRedirect("https://example.com/thanks")).toBe("https://example.com/thanks");
  });
  it("refuses http, credentials, localhost, and raw IPs", () => {
    expect(checkRedirect("http://example.com")).toBeNull();
    expect(checkRedirect("https://user:pw@example.com")).toBeNull();
    expect(checkRedirect("https://localhost/x")).toBeNull();
    expect(checkRedirect("https://10.0.0.1/x")).toBeNull();
    expect(checkRedirect("not a url")).toBeNull();
  });
});

describe("mintIntentLink — local gates (no network)", () => {
  it("refuses a too-short ask before anything else", async () => {
    await expect(mintIntentLink("hi", { apiKey: KEY })).rejects.toThrow(/plain sentence/i);
  });
  it("without a key, points at prepare_handoff instead", async () => {
    await expect(mintIntentLink("Buy $10 of AAPL")).rejects.toThrow(/prepare_handoff/);
  });
  it("refuses a malformed redirect before the network", async () => {
    await expect(mintIntentLink("Buy $10 of AAPL", { apiKey: KEY, redirectUrl: "http://x.com" })).rejects.toThrow(/https/i);
  });
});

describe("mintIntentLink — minting (fetch stubbed)", () => {
  it("POSTs the Bearer key and returns the durable link, no tx material", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ slug: "abc12345", ask: "Buy $10 of AAPL", redirectUrl: null }), { status: 200 });
    });
    const m = await mintIntentLink("Buy  $10 of\nAAPL", { apiKey: KEY, agent: "Claude", mcps: ["robinhood-free", "BAD SLUG"] });
    expect(m.linkUrl).toMatch(/\/i\/abc12345$/);
    expect(m.funnelUrl).toMatch(/\/dashboard\/links$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/intent-links$/);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0].init.body)) as { ask: string; mcps?: string[] };
    expect(body.ask).toBe("Buy $10 of AAPL"); // sanitized before the wire
    expect(body.mcps).toEqual(["robinhood-free"]); // junk slug dropped
    // The word "calldata" never appears; no address/blob hex in the payload.
    expect(JSON.stringify(m)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("falls back to YEETFUL_API_KEY from the env", async () => {
    process.env.YEETFUL_API_KEY = KEY;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ slug: "zz998877" }), { status: 200 }));
    const m = await mintIntentLink("Stake 0.05 ETH with Lido");
    expect(m.slug).toBe("zz998877");
  });

  it("surfaces the website's own refusal message (plan cap, bad key…)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Your plan carries 3 active intent links" }), { status: 402 }));
    await expect(mintIntentLink("Buy $10 of AAPL", { apiKey: KEY })).rejects.toThrow(/3 active intent links/);
  });
});
