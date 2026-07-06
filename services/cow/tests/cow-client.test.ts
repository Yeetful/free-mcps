import { describe, it, expect, beforeEach } from "vitest";
import { CHAINS, clip, resolveChain, explorerOrderUrl } from "@/lib/cow";
import * as q from "@/lib/queries";

const USER = "0xd8dA6BF26964aF9D7eEd9e03E45359a2c7bA4c30";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const UID = "0x" + "ab".repeat(56);

// ── Recording mock fetch (shapes mirror the live API, probed 2026-07-06) ────

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
}
const requests: Recorded[] = [];
const fixtures = new Map<string, { status: number; data: unknown }>();

const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  requests.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const hit = [...fixtures.entries()].find(([key]) => u.includes(key));
  if (!hit) return new Response(JSON.stringify({ errorType: "NotFound" }), { status: 404 });
  return new Response(JSON.stringify(hit[1].data), {
    status: hit[1].status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const opts = { fetchImpl: mockFetch };

const QUOTE_RESPONSE = {
  quote: {
    sellToken: USDC.toLowerCase(),
    buyToken: WETH.toLowerCase(),
    receiver: null,
    sellAmount: "99790178",
    buyAmount: "57272097068364180",
    validTo: 1783344520,
    appData: '{"version":"1.3.0","metadata":{}}',
    appDataHash: "0xa872cd1c41362821123e195e2dc6a3f19502a451e1fb2a1f861131526e98fdc7",
    feeAmount: "209822",
    kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
    signingScheme: "eip712",
  },
  from: USER.toLowerCase(),
  expiration: "2026-07-06T13:00:40.810416974Z",
  id: 1234054687,
  verified: true,
};

beforeEach(() => {
  requests.length = 0;
  fixtures.clear();
});

describe("chain resolution", () => {
  it("resolves canonical names, aliases, and chain ids", () => {
    expect(resolveChain("mainnet")!.chainId).toBe(1);
    expect(resolveChain(undefined)!.chainId).toBe(1);
    expect(resolveChain("ethereum")!.chainId).toBe(1);
    expect(resolveChain("xdai")!.name).toBe("gnosis");
    expect(resolveChain("arbitrum_one")!.network).toBe("arbitrum_one");
    expect(resolveChain("BSC")!.name).toBe("bnb");
    expect(resolveChain("8453")!.name).toBe("base");
    expect(resolveChain("optimism")).toBeNull();
  });

  it("builds explorer URLs with per-chain prefixes", () => {
    expect(explorerOrderUrl(CHAINS.mainnet!, UID)).toBe(`https://explorer.cow.fi/orders/${UID}`);
    expect(explorerOrderUrl(CHAINS.gnosis!, UID)).toBe(`https://explorer.cow.fi/gc/orders/${UID}`);
  });
});

describe("quote", () => {
  it("resolves symbols, converts human units, POSTs to the right network path", async () => {
    fixtures.set("/mainnet/api/v1/quote", { status: 200, data: QUOTE_RESPONSE });
    const r = await q.quote(
      { chain: "mainnet", sellToken: "USDC", buyToken: "WETH", kind: "sell", amount: 100, from: USER },
      opts,
    );
    expect(r.ok).toBe(true);
    const sent = requests[0]!;
    expect(sent.url).toContain("https://api.cow.fi/mainnet/api/v1/quote");
    expect(sent.method).toBe("POST");
    expect(sent.body).toMatchObject({
      sellToken: USDC,
      buyToken: WETH,
      kind: "sell",
      sellAmountBeforeFee: "100000000", // 100 USDC × 10^6
      from: USER,
    });
    const data = r.data as { sell: string; buy: string; networkFee: string; quoteId: number };
    expect(data.sell).toBe("99.790178 USDC");
    expect(data.buy).toContain("WETH");
    expect(data.networkFee).toBe("0.209822 USDC");
    expect(data.quoteId).toBe(1234054687);
  });

  it("buy kind sends buyAmountAfterFee in the BUY token's decimals", async () => {
    fixtures.set("/base/api/v1/quote", { status: 200, data: QUOTE_RESPONSE });
    await q.quote({ chain: "base", sellToken: "USDC", buyToken: "WETH", kind: "buy", amount: "0.05", from: USER }, opts);
    expect(requests[0]!.body).toMatchObject({ buyAmountAfterFee: "50000000000000000", kind: "buy" });
    expect(requests[0]!.url).toContain("/base/api/v1/quote");
  });

  it("refuses unknown symbols with the known-symbol list", async () => {
    const r = await q.quote({ sellToken: "NOPE", buyToken: "WETH", kind: "sell", amount: 1, from: USER }, opts);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Unknown token symbol");
    expect(requests).toHaveLength(0);
  });

  it("refuses raw addresses without decimals on the amount side", async () => {
    const r = await q.quote(
      { sellToken: "0x" + "1".repeat(40), buyToken: "WETH", kind: "sell", amount: 1, from: USER },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Decimals");
  });
});

describe("buildSwapOrder", () => {
  it("returns order + typed data + approval + submit guidance end-to-end", async () => {
    fixtures.set("/mainnet/api/v1/quote", { status: 200, data: QUOTE_RESPONSE });
    const r = await q.buildSwapOrder(
      { chain: "mainnet", sellToken: "USDC", buyToken: "WETH", kind: "sell", amount: 100, from: USER },
      opts,
    );
    expect(r.ok).toBe(true);
    const d = r.data as {
      order: Record<string, unknown>;
      typedData: { domain: { chainId: number }; primaryType: string };
      approval: { spender: string; neededAllowance: string };
      quoteId: number;
      submit_with: string;
      fullAppData: string;
    };
    expect(d.order.sellAmount).toBe("100000000"); // fee folded
    expect(d.order.feeAmount).toBe("0");
    expect(d.typedData.primaryType).toBe("Order");
    expect(d.typedData.domain.chainId).toBe(1);
    expect(d.approval.spender).toBe("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110");
    expect(d.approval.neededAllowance).toBe("100000000");
    expect(d.quoteId).toBe(1234054687);
    expect(d.submit_with).toContain("submit_order");
    // The quote request carried the full appData JSON, so the order book's
    // fee/verification math covers the same appData the user signs.
    expect(requests[0]!.body).toMatchObject({ appData: d.fullAppData });
  });

  it("surfaces order-book errors (e.g. SellAmountDoesNotCoverFee)", async () => {
    fixtures.set("/mainnet/api/v1/quote", {
      status: 400,
      data: { errorType: "SellAmountDoesNotCoverFee", description: "fee exceeds sell amount" },
    });
    const r = await q.buildSwapOrder(
      { chain: "mainnet", sellToken: "USDC", buyToken: "WETH", kind: "sell", amount: "0.000001", from: USER },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe("buildLimitOrder", () => {
  it("converts both sides with real decimals and validates expiry", async () => {
    const r = await q.buildLimitOrder({
      chain: "mainnet",
      sellToken: "WETH",
      buyToken: "USDC",
      sellAmount: 1,
      buyAmount: 4000,
      from: USER,
      validFor: 3600,
    });
    expect(r.ok).toBe(true);
    const d = r.data as { order: Record<string, unknown>; limitPrice: string };
    expect(d.order.sellAmount).toBe("1000000000000000000");
    expect(d.order.buyAmount).toBe("4000000000");
    expect(d.order.feeAmount).toBe("0");
    expect(d.limitPrice).toContain("4000");

    const past = await q.buildLimitOrder({
      chain: "mainnet", sellToken: "WETH", buyToken: "USDC", sellAmount: 1, buyAmount: 4000, from: USER, validTo: 1000,
    });
    expect(past.ok).toBe(false);

    const tooLong = await q.buildLimitOrder({
      chain: "mainnet", sellToken: "WETH", buyToken: "USDC", sellAmount: 1, buyAmount: 4000, from: USER,
      validTo: Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 3600,
    });
    expect(tooLong.ok).toBe(false);
    expect(String(tooLong.data)).toContain("1 year");
  });
});

describe("submitOrder", () => {
  const order = {
    sellToken: USDC, buyToken: WETH, receiver: USER,
    sellAmount: "100000000", buyAmount: "56985736583022360", validTo: 1783344520,
    appData: "0xa872cd1c41362821123e195e2dc6a3f19502a451e1fb2a1f861131526e98fdc7",
    feeAmount: "0", kind: "sell", partiallyFillable: false,
    sellTokenBalance: "erc20", buyTokenBalance: "erc20",
  };

  it("POSTs the full creation body with signature + full appData and returns uid + explorer link", async () => {
    fixtures.set("/mainnet/api/v1/orders", { status: 201, data: UID });
    const r = await q.submitOrder(
      { chain: "mainnet", order, signature: "0x" + "11".repeat(65), from: USER, fullAppData: '{"version":"1.3.0","metadata":{}}', quoteId: 42 },
      opts,
    );
    expect(r.ok).toBe(true);
    expect((r.data as { orderUid: string }).orderUid).toBe(UID);
    expect((r.data as { explorerUrl: string }).explorerUrl).toBe(`https://explorer.cow.fi/orders/${UID}`);
    expect(requests[0]!.body).toMatchObject({
      signingScheme: "eip712",
      signature: "0x" + "11".repeat(65),
      from: USER,
      quoteId: 42,
      appData: '{"version":"1.3.0","metadata":{}}', // full JSON preferred
      appDataHash: order.appData, // signed hash kept alongside
    });
  });

  it("refuses incomplete orders without hitting the API", async () => {
    const r = await q.submitOrder({ order: { sellToken: USDC }, signature: "0x11", from: USER }, opts);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("missing fields");
    expect(requests).toHaveLength(0);
  });
});

describe("cancelOrders (two-phase)", () => {
  it("returns typed data when unsigned, DELETEs when signed", async () => {
    const phase1 = await q.cancelOrders({ chain: "mainnet", orderUids: [UID] }, opts);
    expect(phase1.ok).toBe(true);
    const td = (phase1.data as { typedData: { primaryType: string } }).typedData;
    expect(td.primaryType).toBe("OrderCancellations");
    expect(requests).toHaveLength(0);

    fixtures.set("/mainnet/api/v1/orders", { status: 200, data: "Cancelled" });
    const phase2 = await q.cancelOrders({ chain: "mainnet", orderUids: [UID], signature: "0x" + "22".repeat(65) }, opts);
    expect(phase2.ok).toBe(true);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.body).toMatchObject({ orderUids: [UID], signingScheme: "eip712" });
  });
});

describe("order/account reads", () => {
  it("order_status summarizes fill % and keeps the raw order", async () => {
    fixtures.set(`/v1/orders/${UID}`, {
      status: 200,
      data: {
        uid: UID, owner: USER.toLowerCase(), sellToken: USDC.toLowerCase(), buyToken: WETH.toLowerCase(),
        sellAmount: "100000000", buyAmount: "56000000000000000",
        executedSellAmountBeforeFees: "50000000", executedBuyAmount: "28100000000000000",
        validTo: 1783344520, kind: "sell", partiallyFillable: true, status: "open",
        class: "limit", creationDate: "2026-07-06T12:00:00Z",
      },
    });
    const r = await q.orderStatus({ chain: "mainnet", uid: UID }, opts);
    expect(r.ok).toBe(true);
    const d = r.data as { filledPct: number; pair: string; explorerUrl: string; status: string };
    expect(d.filledPct).toBe(50);
    expect(d.pair).toBe("USDC → WETH");
    expect(d.status).toBe("open");
    expect(d.explorerUrl).toContain(UID);
  });

  it("user_orders counts open orders", async () => {
    fixtures.set(`/v1/account/${USER}/orders`, {
      status: 200,
      data: [
        { uid: UID, sellToken: USDC, buyToken: WETH, sellAmount: "1", buyAmount: "1", validTo: 1, kind: "sell", partiallyFillable: false, status: "open" },
        { uid: UID, sellToken: WETH, buyToken: USDC, sellAmount: "1", buyAmount: "1", validTo: 1, kind: "buy", partiallyFillable: false, status: "fulfilled" },
      ],
    });
    const r = await q.userOrders({ chain: "mainnet", owner: USER, limit: 10 }, opts);
    expect(r.ok).toBe(true);
    const d = r.data as { openCount: number; returned: number };
    expect(d.openCount).toBe(1);
    expect(d.returned).toBe(2);
    expect(requests[0]!.url).toContain("limit=10&offset=0");
  });

  it("user_trades sorts newest-first and trims to `first`", async () => {
    fixtures.set("/v1/trades", {
      status: 200,
      data: Array.from({ length: 30 }, (_, i) => ({
        orderUid: UID, owner: USER, sellToken: USDC, buyToken: WETH,
        sellAmount: "1000", buyAmount: "500", txHash: `0xtx${i}`, blockNumber: 100 + i,
      })),
    });
    const r = await q.userTrades({ chain: "mainnet", owner: USER, first: 5 }, opts);
    const d = r.data as { trades: { blockNumber: number }[]; totalReturned: number; note?: string };
    expect(d.totalReturned).toBe(30);
    expect(d.trades).toHaveLength(5);
    expect(d.trades[0]!.blockNumber).toBe(129); // newest first
    expect(d.note).toContain("5 of 30");
  });

  it("portfolio aggregates orders + trades per chain, order-book-derived", async () => {
    fixtures.set(`/v1/account/${USER}/orders`, {
      status: 200,
      data: [{ uid: UID, sellToken: USDC, buyToken: WETH, sellAmount: "5", buyAmount: "1", validTo: 1, kind: "sell", partiallyFillable: false, status: "open" }],
    });
    fixtures.set("/v1/trades", {
      status: 200,
      data: [
        { orderUid: UID, owner: USER, sellToken: USDC, buyToken: WETH, sellAmount: "100", sellAmountBeforeFees: "100", buyAmount: "50", txHash: "0xt", blockNumber: 1 },
        { orderUid: UID, owner: USER, sellToken: USDC, buyToken: WETH, sellAmount: "200", sellAmountBeforeFees: "200", buyAmount: "99", txHash: "0xt2", blockNumber: 2 },
      ],
    });
    const r = await q.portfolio({ owner: USER, chains: ["mainnet", "base"] }, opts);
    expect(r.ok).toBe(true);
    const d = r.data as { chains: { chain: string; openOrders: unknown[]; tradeCount: number; totalSoldByToken: Record<string, string> }[] };
    expect(d.chains).toHaveLength(2);
    expect(d.chains[0]!.openOrders).toHaveLength(1);
    expect(d.chains[0]!.tradeCount).toBe(2);
    expect(d.chains[0]!.totalSoldByToken.USDC).toBe("300");
  });

  it("native_price resolves the symbol first", async () => {
    fixtures.set("/native_price", { status: 200, data: { price: 1.0 } });
    const r = await q.nativePrice({ chain: "mainnet", token: "WETH" }, opts);
    expect(r.ok).toBe(true);
    expect(requests[0]!.url).toContain(`/v1/token/${WETH}/native_price`);
    expect((r.data as { price: number }).price).toBe(1);
  });

  it("solver_competition hits /v2 (v1 is dead) and shapes solutions", async () => {
    fixtures.set("/v2/solver_competition/latest", {
      status: 200,
      data: {
        auctionId: 13306297,
        transactionHashes: ["0x5f44"],
        referenceScores: { "0x9548": "4930" },
        auction: { orders: ["0xaaa", "0xbbb"] },
        solutions: [{ solverAddress: "0x9548", score: "4930", ranking: 1, isWinner: true, orders: [{}] }],
      },
    });
    const r = await q.solverCompetition({ chain: "mainnet" }, opts);
    expect(r.ok).toBe(true);
    const d = r.data as { auctionId: number; ordersInAuction: number; solutions: { isWinner: boolean }[] };
    expect(d.auctionId).toBe(13306297);
    expect(d.ordersInAuction).toBe(2);
    expect(d.solutions[0]!.isWinner).toBe(true);
    expect(requests[0]!.url).toContain("/api/v2/solver_competition/latest");
  });
});

describe("plumbing", () => {
  it("clip truncates oversized payloads with a preview", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(10) })) };
    const clipped = clip(big) as { note?: string; preview?: string };
    expect(clipped.note).toContain("truncated");
    expect(clipped.preview!.length).toBeLessThanOrEqual(24_000);
    expect(clip({ small: true })).toEqual({ small: true });
  });

  it("unknown chains fail fast everywhere", async () => {
    const r = await q.userOrders({ chain: "optimism", owner: USER }, opts);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Unknown chain");
  });
});
