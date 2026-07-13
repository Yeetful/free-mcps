import { describe, expect, it } from "vitest";
import { clip, fetchApr, fetchQueueWait, fetchRewards, type RewardHistory } from "@/lib/lido-api";

// Fixtures are trimmed copies of LIVE responses (probed 2026-07-13) — the
// shapes here are the pinned truth for the three Lido APIs.

const aprFixture = {
  data: {
    aprs: [
      { timeUnix: 1783858895, apr: 2.185 },
      { timeUnix: 1783945319, apr: 2.201 },
    ],
    smaApr: 2.2211428571428575,
  },
  meta: { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", chainId: 1 },
};

const rewardsFixture = {
  events: [
    {
      apr: "2.200376071665655657",
      blockTime: "1783945319",
      type: "reward",
      balance: "10360293099828",
      rewards: "624525119",
      change: "624525119",
      currencyChange: "0.000001127194837824",
    },
  ],
  totals: { ethRewards: "180464343727", currencyRewards: "0.00044182629547168" },
  averageApr: "2.486094544776637198",
  ethToStEthRatio: 0.9997190789388182,
  stETHCurrencyPrice: { eth: 1.000281, usd: 1768.73 },
  totalItems: 258,
};

const wqFixture = {
  requestInfo: { finalizationIn: 420715000, finalizationAt: "2026-07-18T12:30:23.417Z", type: "exitValidators" },
  status: "calculated",
};

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("fetchApr", () => {
  it("shapes SMA + latest + timestamp", async () => {
    const r = await fetchApr({ fetchImpl: jsonFetch(aprFixture) });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      smaAprPct: 2.2211428571428575,
      latestAprPct: 2.201,
      asOf: new Date(1783945319 * 1000).toISOString(),
    });
  });

  it("surfaces upstream failures as ok:false", async () => {
    const r = await fetchApr({ fetchImpl: jsonFetch({ error: "nope" }, 503) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it("survives a network throw with a legible message", async () => {
    const boom: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await fetchApr({ fetchImpl: boom });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("ECONNREFUSED");
  });
});

describe("fetchRewards (earnings)", () => {
  it("converts wei strings to decimal stETH and shapes totals", async () => {
    const r = await fetchRewards({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, { fetchImpl: jsonFetch(rewardsFixture) });
    expect(r.ok).toBe(true);
    const d = r.data as RewardHistory;
    expect(d.totalRewardsStEth).toBe("0.000000180464343727");
    expect(d.totalRewardsUsd).toBe(0); // rounds to cents — honest for dust
    expect(d.averageAprPct).toBe(2.486);
    expect(d.stEthUsdPrice).toBe(1768.73);
    expect(d.totalEvents).toBe(258);
    expect(d.events[0]).toEqual({
      type: "reward",
      date: new Date(1783945319 * 1000).toISOString().slice(0, 10),
      rewardStEth: "0.000000000624525119",
      balanceStEth: "0.000010360293099828",
      aprPct: 2.2,
    });
  });

  it("handles an address with no history", async () => {
    const r = await fetchRewards(
      { address: "0x2222222222222222222222222222222222222222" },
      { fetchImpl: jsonFetch({ events: [], totals: { ethRewards: "0" }, totalItems: 0 }) },
    );
    expect(r.ok).toBe(true);
    const d = r.data as RewardHistory;
    expect(d.totalEvents).toBe(0);
    expect(d.totalRewardsStEth).toBe("0");
  });

  it("surfaces the >6000-transfers 422 as legible text", async () => {
    const r = await fetchRewards(
      { address: "0x3333333333333333333333333333333333333333" },
      { fetchImpl: jsonFetch({ statusCode: 422, message: "This address has more than 6000 stETH transfers, use Rewards Module…" }, 422) },
    );
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("more than 6000 stETH transfers");
    expect(String(r.data)).toContain("position");
  });

  it("clamps limit into [1,60]", async () => {
    let seen = "";
    const spy: typeof fetch = (async (url: RequestInfo | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ events: [], totals: {}, totalItems: 0 }), { status: 200 });
    }) as typeof fetch;
    await fetchRewards({ address: "0x2222222222222222222222222222222222222222", limit: 500 }, { fetchImpl: spy });
    expect(seen).toContain("limit=60");
  });
});

describe("fetchQueueWait", () => {
  it("shapes the estimate into hours + ISO time", async () => {
    const r = await fetchQueueWait("100", { fetchImpl: jsonFetch(wqFixture) });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      estimatedWaitHours: 116.9,
      estimatedFinalizationAt: "2026-07-18T12:30:23.417Z",
      drivenBy: "exitValidators",
    });
  });
});

describe("clip", () => {
  it("passes small payloads through and truncates huge ones", () => {
    expect(clip({ a: 1 })).toEqual({ a: 1 });
    const huge = { rows: Array.from({ length: 5000 }, (_, i) => `row-${i}-xxxxxxxxxx`) };
    const clipped = clip(huge) as { note?: string; preview?: string };
    expect(clipped.note).toContain("truncated");
    expect(clipped.preview!.length).toBeLessThanOrEqual(24_000);
  });
});
