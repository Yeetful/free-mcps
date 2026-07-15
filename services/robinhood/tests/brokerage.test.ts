import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  API_KEY_HEADER,
  BROKERAGE_BASE,
  PRIVATE_KEY_HEADER,
  SETUP_MESSAGE,
  brokeragePaginate,
  brokerageRequest,
  maskApiKey,
  resolveCreds,
  setBrokerageClockForTests,
  setBrokerageFetchForTests,
  signRequest,
  type BrokerageCreds,
} from "@/lib/brokerage";
import {
  CONFIRM_TTL_SEC,
  buildOrder,
  canonicalOrder,
  mintConfirmToken,
  orderConfig,
  submitOrder,
  validateOrderShape,
  verifyConfirmToken,
  type OrderParams,
} from "@/lib/brokerage-orders";

// ── Docs test vector (docs.robinhood.com/crypto/trading, "Example Signature") ──
const VECTOR_SEED_B64 = "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=";
const VECTOR_API_KEY = "rh-api-6148effc-c0b1-486c-8940-a1d099456be6";
const VECTOR_TIMESTAMP = 1698708981;
const VECTOR_EXPECTED_SIGNATURE = "q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==";

const vectorCreds: BrokerageCreds = {
  apiKey: VECTOR_API_KEY,
  seed: new Uint8Array(Buffer.from(VECTOR_SEED_B64, "base64")),
  source: "env",
};

const otherCreds: BrokerageCreds = {
  apiKey: "rh-api-00000000-0000-0000-0000-000000000000",
  seed: new Uint8Array(32).fill(7),
  source: "request",
};

afterEach(() => {
  setBrokerageFetchForTests(null);
  setBrokerageClockForTests(null);
  vi.unstubAllEnvs();
});

describe("Ed25519 signing (docs test vector)", () => {
  it("reproduces the documented example signature", () => {
    // QUIRK, verified against the docs' own Python: the docs example signs the
    // f-string-interpolated Python DICT — i.e. Python dict repr (single
    // quotes, spaces after colons/commas, dict-literal key order), NOT the
    // compact JSON shown in the docs table. This proves the Ed25519 plumbing;
    // the real client always signs the exact JSON string it transmits.
    const pythonReprBody =
      "{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}";
    const headers = signRequest(vectorCreds, "POST", "/api/v1/crypto/trading/orders/", pythonReprBody, VECTOR_TIMESTAMP);
    expect(headers["x-signature"]).toBe(VECTOR_EXPECTED_SIGNATURE);
    expect(headers["x-api-key"]).toBe(VECTOR_API_KEY);
    expect(headers["x-timestamp"]).toBe(String(VECTOR_TIMESTAMP));
  });

  it("omits the body from the message entirely for body-less requests", () => {
    const withUndefined = signRequest(vectorCreds, "GET", "/api/v2/crypto/trading/accounts/", undefined, VECTOR_TIMESTAMP);
    const manual = ed25519.sign(
      new TextEncoder().encode(`${VECTOR_API_KEY}${VECTOR_TIMESTAMP}/api/v2/crypto/trading/accounts/GET`),
      vectorCreds.seed,
    );
    expect(withUndefined["x-signature"]).toBe(Buffer.from(manual).toString("base64"));
  });
});

describe("brokerageRequest header assembly + exact-body signing", () => {
  it("signs the EXACT JSON body it transmits, path including query string", async () => {
    setBrokerageClockForTests(() => 1_750_000_000);
    let captured: { url: string; headers: Record<string, string>; body?: string; method?: string } | null = null;
    setBrokerageFetchForTests(async (url, init) => {
      captured = {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
        method: init?.method,
      };
      return new Response(JSON.stringify({ ok: 1 }), { status: 201 });
    });

    const path = "/api/v2/crypto/trading/orders/?account_number=ABC123";
    const res = await brokerageRequest(vectorCreds, "POST", path, { symbol: "BTC-USD", side: "buy" });
    expect(res.ok).toBe(true);

    const c = captured!;
    expect(c.url).toBe(`${BROKERAGE_BASE}${path}`);
    expect(c.method).toBe("POST");
    expect(c.headers["x-api-key"]).toBe(VECTOR_API_KEY);
    expect(c.headers["x-timestamp"]).toBe("1750000000");
    expect(c.headers["content-type"]).toContain("application/json");
    expect(c.body).toBe('{"symbol":"BTC-USD","side":"buy"}'); // exact compact JSON on the wire

    // The signature verifies against apiKey + timestamp + path(with query) + METHOD + exact body.
    const message = `${VECTOR_API_KEY}1750000000${path}POST${c.body}`;
    const pub = ed25519.getPublicKey(vectorCreds.seed);
    expect(ed25519.verify(Buffer.from(c.headers["x-signature"], "base64"), new TextEncoder().encode(message), pub)).toBe(true);
  });

  it("sends no body and no content-type on GETs, and a fresh timestamp per call", async () => {
    let t = 1_750_000_000;
    setBrokerageClockForTests(() => t);
    const seen: string[] = [];
    setBrokerageFetchForTests(async (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push(h["x-timestamp"]);
      expect(init?.body).toBeUndefined();
      expect(h["content-type"]).toBeUndefined();
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await brokerageRequest(vectorCreds, "GET", "/api/v2/crypto/trading/accounts/");
    t += 10; // timestamps are only valid 30s — each request must re-stamp
    await brokerageRequest(vectorCreds, "GET", "/api/v2/crypto/trading/accounts/");
    expect(seen).toEqual(["1750000000", "1750000010"]);
  });

  it("surfaces auth failures with a clock/key hint", async () => {
    setBrokerageFetchForTests(async () => new Response(JSON.stringify({ type: "client_error" }), { status: 401 }));
    const res = await brokerageRequest(vectorCreds, "GET", "/api/v2/crypto/trading/accounts/");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(String(res.data)).toContain("30s");
  });
});

describe("credential resolution (multi-tenant)", () => {
  const seedB64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

  it("per-request headers take precedence over env", () => {
    vi.stubEnv("ROBINHOOD_API_KEY", "rh-api-env-key");
    vi.stubEnv("ROBINHOOD_PRIVATE_KEY", Buffer.from(new Uint8Array(32).fill(1)).toString("base64"));
    const out = resolveCreds({ requestInfo: { headers: { [API_KEY_HEADER]: "rh-api-header-key", [PRIVATE_KEY_HEADER]: seedB64 } } });
    expect("creds" in out && out.creds.apiKey).toBe("rh-api-header-key");
    expect("creds" in out && out.creds.source).toBe("request");
  });

  it("falls back to env when no headers arrive", () => {
    vi.stubEnv("ROBINHOOD_API_KEY", "rh-api-env-key");
    vi.stubEnv("ROBINHOOD_PRIVATE_KEY", seedB64);
    const out = resolveCreds({ requestInfo: { headers: {} } });
    expect("creds" in out && out.creds.apiKey).toBe("rh-api-env-key");
    expect("creds" in out && out.creds.source).toBe("env");
  });

  it("returns the bring-your-own-key setup message when neither is present", () => {
    vi.stubEnv("ROBINHOOD_API_KEY", "");
    vi.stubEnv("ROBINHOOD_PRIVATE_KEY", "");
    const out = resolveCreds(undefined);
    expect("error" in out && out.error).toBe(SETUP_MESSAGE);
    expect(SETUP_MESSAGE).toContain(API_KEY_HEADER);
    expect(SETUP_MESSAGE).toContain(PRIVATE_KEY_HEADER);
  });

  it("rejects half-provided headers and non-32-byte seeds", () => {
    const half = resolveCreds({ requestInfo: { headers: { [API_KEY_HEADER]: "rh-api-x" } } });
    expect("error" in half && half.error).toContain("BOTH");
    const badSeed = resolveCreds({ requestInfo: { headers: { [API_KEY_HEADER]: "rh-api-x", [PRIVATE_KEY_HEADER]: "dG9vc2hvcnQ=" } } });
    expect("error" in badSeed && badSeed.error).toContain("32-byte");
  });

  it("masks the api key for echoing and never exposes more", () => {
    expect(maskApiKey(VECTOR_API_KEY)).toBe("rh-api-6148e…6be6");
    expect(maskApiKey("short")).toBe("***");
  });
});

describe("pagination", () => {
  it("follows same-host next cursors and collects results", async () => {
    const pages: Record<string, unknown> = {
      "/api/v2/crypto/trading/trading_pairs/": { next: `${BROKERAGE_BASE}/api/v2/crypto/trading/trading_pairs/?cursor=2`, results: [{ symbol: "BTC-USD" }] },
      "/api/v2/crypto/trading/trading_pairs/?cursor=2": { next: null, results: [{ symbol: "ETH-USD" }] },
    };
    setBrokerageFetchForTests(async (url) => {
      const path = String(url).slice(BROKERAGE_BASE.length);
      return new Response(JSON.stringify(pages[path] ?? { results: [] }), { status: 200 });
    });
    const out = await brokeragePaginate(vectorCreds, "/api/v2/crypto/trading/trading_pairs/");
    expect(out.ok && out.results).toEqual([{ symbol: "BTC-USD" }, { symbol: "ETH-USD" }]);
    expect(out.ok && out.pages).toBe(2);
    expect(out.ok && out.truncated).toBe(false);
  });

  it("refuses to follow an off-host next URL (response-controlled)", async () => {
    setBrokerageFetchForTests(
      async () => new Response(JSON.stringify({ next: "https://evil.example.com/steal?x=1", results: [{ symbol: "BTC-USD" }] }), { status: 200 }),
    );
    const out = await brokeragePaginate(vectorCreds, "/api/v2/crypto/trading/trading_pairs/");
    expect(out.ok && out.results.length).toBe(1);
    expect(out.ok && out.truncated).toBe(true);
  });

  it("caps at maxPages and reports truncation", async () => {
    setBrokerageFetchForTests(
      async () => new Response(JSON.stringify({ next: `${BROKERAGE_BASE}/api/v2/x/?cursor=next`, results: [{}] }), { status: 200 }),
    );
    const out = await brokeragePaginate(vectorCreds, "/api/v2/x/", 3);
    expect(out.ok && out.pages).toBe(3);
    expect(out.ok && out.truncated).toBe(true);
  });
});

describe("order shape validation", () => {
  const base: OrderParams = { accountNumber: "A1", symbol: "BTC-USD", side: "buy", type: "market", assetQuantity: "0.001" };

  it("accepts each order type with its required config", () => {
    expect(validateOrderShape(base)).toBeNull();
    expect(validateOrderShape({ ...base, type: "limit", limitPrice: "50000" })).toBeNull();
    expect(validateOrderShape({ ...base, type: "limit", assetQuantity: undefined, quoteAmount: "25", limitPrice: "50000" })).toBeNull();
    expect(validateOrderShape({ ...base, type: "stop_loss", stopPrice: "40000" })).toBeNull();
    expect(validateOrderShape({ ...base, type: "stop_limit", limitPrice: "39900", stopPrice: "40000" })).toBeNull();
  });

  it("refuses malformed and over-specified configs", () => {
    expect(validateOrderShape({ ...base, symbol: "btc-usd" })).toContain("uppercase");
    expect(validateOrderShape({ ...base, assetQuantity: undefined })).toContain("assetQuantity");
    expect(validateOrderShape({ ...base, quoteAmount: "25" })).toContain("market");
    expect(validateOrderShape({ ...base, limitPrice: "50000" })).toContain("no limitPrice");
    expect(validateOrderShape({ ...base, type: "limit" })).toContain("limitPrice");
    expect(validateOrderShape({ ...base, type: "limit", quoteAmount: "25", limitPrice: "50000" })).toContain("EXACTLY ONE");
    expect(validateOrderShape({ ...base, type: "stop_limit", limitPrice: "39900" })).toContain("BOTH");
    expect(validateOrderShape({ ...base, assetQuantity: "0" })).toContain("positive");
    expect(validateOrderShape({ ...base, assetQuantity: "1e3" })).toContain("positive");
  });

  it("builds the {type}_order_config the API expects", () => {
    expect(orderConfig(base)).toEqual({ key: "market_order_config", config: { asset_quantity: "0.001" } });
    expect(orderConfig({ ...base, type: "stop_limit", limitPrice: "39900", stopPrice: "40000" })).toEqual({
      key: "stop_limit_order_config",
      config: { asset_quantity: "0.001", limit_price: "39900", stop_price: "40000", time_in_force: "gtc" },
    });
  });
});

describe("confirm token (two-step consent gate)", () => {
  const params: OrderParams = { accountNumber: "A1", symbol: "BTC-USD", side: "buy", type: "market", assetQuantity: "0.001" };

  it("round-trips: mint then verify with the exact same params + creds", () => {
    const { token, expiresAt } = mintConfirmToken(vectorCreds, params, 1_000_000);
    expect(new Date(expiresAt).getTime() / 1000).toBe(1_000_000 + CONFIRM_TTL_SEC);
    expect(verifyConfirmToken(vectorCreds, params, token, 1_000_000 + 60)).toEqual({ ok: true });
  });

  it("canonicalization makes field order irrelevant but values load-bearing", () => {
    const reordered: OrderParams = { type: "market", side: "buy", symbol: "BTC-USD", accountNumber: "A1", assetQuantity: "0.001" };
    expect(canonicalOrder(params)).toBe(canonicalOrder(reordered));
    expect(canonicalOrder(params)).not.toBe(canonicalOrder({ ...params, assetQuantity: "0.002" }));
  });

  it("refuses ANY param drift from the previewed order", () => {
    const { token } = mintConfirmToken(vectorCreds, params, 1_000_000);
    for (const mutated of [
      { ...params, assetQuantity: "0.002" },
      { ...params, side: "sell" as const },
      { ...params, symbol: "ETH-USD" },
      { ...params, accountNumber: "A2" },
    ]) {
      const out = verifyConfirmToken(vectorCreds, mutated, token, 1_000_000 + 1);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.reason).toContain("do not match");
    }
  });

  it("refuses expired tokens", () => {
    const { token } = mintConfirmToken(vectorCreds, params, 1_000_000);
    const out = verifyConfirmToken(vectorCreds, params, token, 1_000_000 + CONFIRM_TTL_SEC + 1);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain("expired");
  });

  it("refuses tokens minted under different credentials", () => {
    const { token } = mintConfirmToken(otherCreds, params, 1_000_000);
    const out = verifyConfirmToken(vectorCreds, params, token, 1_000_000 + 1);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain("credentials");
  });

  it("refuses malformed and tampered tokens", () => {
    expect(verifyConfirmToken(vectorCreds, params, "garbage", 1).ok).toBe(false);
    expect(verifyConfirmToken(vectorCreds, params, "a.b.c", 1).ok).toBe(false);
    const { token } = mintConfirmToken(vectorCreds, params, 1_000_000);
    const [payload, mac] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, exp: 9_999_999_999, h: "00" }), "utf8").toString("base64url");
    expect(verifyConfirmToken(vectorCreds, params, `${forgedPayload}.${mac}`, 1_000_000).ok).toBe(false);
    expect(verifyConfirmToken(vectorCreds, params, `${payload}.${Buffer.from("nope").toString("base64url")}`, 1_000_000).ok).toBe(false);
  });
});

describe("build → submit flow (fake API)", () => {
  function fakeApi(overrides: { pairStatus?: string; apiTradable?: boolean } = {}) {
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    setBrokerageFetchForTests(async (url, init) => {
      const path = String(url).slice(BROKERAGE_BASE.length);
      calls.push({ method: init?.method ?? "GET", path, body: init?.body as string | undefined });
      if (path.startsWith("/api/v2/crypto/trading/accounts/"))
        return new Response(JSON.stringify({ results: [{ account_number: "ACCT-9", status: "active", buying_power: "1000" }] }), { status: 200 });
      if (path.startsWith("/api/v2/crypto/trading/trading_pairs/"))
        // Real v2 shape (live-verified): min_order_amount is USD, max_order_size asset units.
        return new Response(
          JSON.stringify({
            results: [
              {
                asset_code: "BTC",
                quote_code: "USD",
                symbol: "BTC-USD",
                status: overrides.pairStatus ?? "tradable",
                is_api_tradable: overrides.apiTradable ?? true,
                min_order_amount: "0.1",
                max_order_size: "100",
                asset_increment: "0.00000001",
              },
            ],
          }),
          { status: 200 },
        );
      if (path.startsWith("/api/v2/crypto/trading/estimated_price/")) {
        // Real v2 shape (live-verified): side-named price field + fee-tier totals, numbers not strings.
        const qty = Number(new URL(`${BROKERAGE_BASE}${path}`).searchParams.get("quantity") ?? "0");
        return new Response(
          JSON.stringify({
            results: [
              { symbol: "BTC-USD", side: "ask", quantity: qty, fee_ratio: 0.0095, est_fee: 100000 * qty * 0.0095, ask: 100000, est_total_cost: 100000 * qty * 1.0095 },
            ],
          }),
          { status: 200 },
        );
      }
      if (path.startsWith("/api/v2/crypto/trading/orders/") && init?.method === "POST")
        return new Response(JSON.stringify({ id: "497f6eca-6276-4993-bfeb-53cbbbba6f08", state: "open" }), { status: 201 });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    return calls;
  }

  const args = { symbol: "BTC-USD", side: "buy" as const, type: "market" as const, assetQuantity: "0.001" };

  it("build returns a preview + token and PLACES NOTHING", async () => {
    setBrokerageClockForTests(() => 2_000_000_000);
    const calls = fakeApi();
    const res = await buildOrder(vectorCreds, args);
    expect(res.ok).toBe(true);
    const d = res.data as { estimate: { estNotionalUsd: number; estFeeUsd?: number }; confirmToken: string; nextStep: string; order: Record<string, unknown> };
    expect(d.estimate.estNotionalUsd).toBe(100.95); // fee-tier-inclusive est_total_cost
    expect(d.estimate.estFeeUsd).toBe(0.95);
    expect(d.confirmToken).toContain(".");
    expect(d.nextStep).toContain("REAL MONEY");
    expect(d.order).toEqual({ symbol: "BTC-USD", side: "buy", type: "market", market_order_config: { asset_quantity: "0.001" } });
    expect(calls.every((c) => c.method === "GET")).toBe(true); // read-only step
  });

  it("build fails closed on non-tradable pairs and size limits", async () => {
    setBrokerageClockForTests(() => 2_000_000_000);
    fakeApi({ pairStatus: "halted" });
    const halted = await buildOrder(vectorCreds, args);
    expect(halted.ok).toBe(false);
    expect(String(halted.data)).toContain("halted");

    fakeApi();
    const tooBig = await buildOrder(vectorCreds, { ...args, assetQuantity: "500" });
    expect(tooBig.ok).toBe(false);
    expect(String(tooBig.data)).toContain("maximum order size");

    fakeApi({ apiTradable: false });
    const notApi = await buildOrder(vectorCreds, args);
    expect(notApi.ok).toBe(false);
    expect(String(notApi.data)).toContain("is_api_tradable");

    fakeApi();
    const dust = await buildOrder(vectorCreds, { ...args, assetQuantity: "0.0000001" }); // $0.01 < $0.10 min_order_amount
    expect(dust.ok).toBe(false);
    expect(String(dust.data)).toContain("minimum order amount");
  });

  it("submit places the order only with the matching token, minting a UUID client_order_id", async () => {
    setBrokerageClockForTests(() => 2_000_000_000);
    const calls = fakeApi();
    const built = await buildOrder(vectorCreds, args);
    const token = (built.data as { confirmToken: string }).confirmToken;

    const res = await submitOrder(vectorCreds, { ...args, confirmToken: token });
    expect(res.ok).toBe(true);
    expect((res.data as { placed: boolean }).placed).toBe(true);

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v2/crypto/trading/orders/?account_number=ACCT-9");
    const body = JSON.parse(post.body!) as { client_order_id: string; market_order_config: { asset_quantity: string } };
    expect(body.client_order_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.market_order_config).toEqual({ asset_quantity: "0.001" });
  });

  it("submit refuses on param mismatch and on expiry — never places", async () => {
    setBrokerageClockForTests(() => 2_000_000_000);
    const calls = fakeApi();
    const built = await buildOrder(vectorCreds, args);
    const token = (built.data as { confirmToken: string }).confirmToken;

    const drift = await submitOrder(vectorCreds, { ...args, assetQuantity: "0.01", confirmToken: token });
    expect(drift.ok).toBe(false);
    expect(String(drift.data)).toContain("do not match");

    setBrokerageClockForTests(() => 2_000_000_000 + CONFIRM_TTL_SEC + 1);
    const stale = await submitOrder(vectorCreds, { ...args, confirmToken: token });
    expect(stale.ok).toBe(false);
    expect(String(stale.data)).toContain("expired");

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
