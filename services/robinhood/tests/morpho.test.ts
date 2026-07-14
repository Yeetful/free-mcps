import { afterEach, describe, expect, it } from "vitest";
import { setRpcForTests } from "@/lib/chain";
import { accrueMarket, borrowApyFromRate, morphoReads, setFetchForTests, toAssetsDown, toAssetsUp } from "@/lib/morpho";
import { resolveToken } from "@/lib/registry";
import { fakeClient } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const MARKET_ID = `0x${"ab".repeat(32)}` as const;
const USDG = resolveToken("USDG")!;
const TSLA = resolveToken("TSLA")!;

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

/** USDG/TSLA market: 1000 USDG supplied, 600 borrowed, lltv 77%. */
const marketReads = () => ({
  idToMarketParams: {
    loanToken: USDG.address,
    collateralToken: TSLA.address,
    oracle: "0x00000000000000000000000000000000000000A1",
    irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    lltv: 770_000_000_000_000_000n,
  },
  market: {
    totalSupplyAssets: 1_000_000_000n, // 1000 USDG (6 dec)
    totalSupplyShares: 1_000_000_000n * 10n ** 6n,
    totalBorrowAssets: 600_000_000n,
    totalBorrowShares: 600_000_000n * 10n ** 6n,
    lastUpdate: nowSec(),
    fee: 0n,
  },
  borrowRateView: 1_585_489_599n, // ≈5% APR per-second WAD
  price: 300n * 10n ** 6n * 10n ** 18n, // $300/TSLA → 300e6 loan atoms per 1e18 coll atoms, ×1e36/1e18
});

afterEach(() => {
  setRpcForTests(null);
  setFetchForTests(null);
});

describe("share/interest math (mirrors morpho-blue libs)", () => {
  it("converts shares↔assets with virtual offsets and rounds debt UP", () => {
    const shares = 100_000_000n * 10n ** 6n;
    const down = toAssetsDown(shares, 600_000_000n, 600_000_000n * 10n ** 6n);
    const up = toAssetsUp(shares, 600_000_000n, 600_000_000n * 10n ** 6n);
    expect(down).toBeLessThanOrEqual(up);
    expect(Number(up)).toBeCloseTo(100_000_000, -2);
  });

  it("accrues Taylor-compounded interest onto both totals", () => {
    const rate = 3_170_979_198n; // ≈10%/yr per-second WAD
    const market = {
      totalSupplyAssets: 1_000_000_000n,
      totalSupplyShares: 1n,
      totalBorrowAssets: 1_000_000_000n,
      totalBorrowShares: 1n,
      lastUpdate: 0n,
      fee: 0n,
    };
    const after = accrueMarket(market, rate, 31_536_000); // one year
    const growth = Number(after.totalBorrowAssets) / 1e9;
    expect(growth).toBeGreaterThan(1.10); // e^0.1 ≈ 1.1052
    expect(growth).toBeLessThan(1.106);
    expect(after.totalSupplyAssets).toBe(after.totalBorrowAssets - 1_000_000_000n + 1_000_000_000n);
  });

  it("turns a per-second rate into a compounded APY", () => {
    expect(borrowApyFromRate(1_585_489_599n)).toBeCloseTo(Math.expm1(0.05), 3);
  });
});

describe("lending_position (on-chain, explicit market ids)", () => {
  it("computes supplied/debt/health from raw position state", async () => {
    const m = marketReads();
    setRpcForTests(
      fakeClient({
        reads: {
          ...m,
          position: { supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n },
        },
      }),
    );
    const res = await morphoReads.position({ user: USER, marketIds: [MARKET_ID] });
    expect(res.ok).toBe(true);
    const data = res.data as { positions: Array<{ market: string; borrowed: { amount: string }; collateral: { amount: string; asset: string }; borrowingPower: { maxBorrow: string }; healthFactor: number }> };
    expect(data.positions).toHaveLength(1);
    const p = data.positions[0];
    expect(p.market).toContain("USDG / TSLA");
    expect(p.collateral).toMatchObject({ amount: "1", asset: "TSLA" });
    expect(Number(p.borrowed.amount)).toBeCloseTo(100, 0);
    // maxBorrow = 1 TSLA × $300 × 0.77 = 231 USDG → HF ≈ 2.31
    expect(Number(p.borrowingPower.maxBorrow)).toBeCloseTo(231, 0);
    expect(p.healthFactor).toBeGreaterThan(2.2);
    expect(p.healthFactor).toBeLessThan(2.4);
  });

  it("skips empty positions", async () => {
    setRpcForTests(
      fakeClient({
        reads: { position: { supplyShares: 0n, borrowShares: 0n, collateral: 0n } },
      }),
    );
    const res = await morphoReads.position({ user: USER, marketIds: [MARKET_ID] });
    expect(res.ok).toBe(true);
    expect((res.data as { positions: unknown[] }).positions).toHaveLength(0);
  });
});

describe("lending_markets", () => {
  const apiMarket = (marketId: string, listed: boolean) => ({
    marketId,
    listed,
    lltv: "770000000000000000",
    loanAsset: { symbol: "USDG", address: USDG.address, decimals: 6 },
    collateralAsset: { symbol: "TSLA", address: TSLA.address, decimals: 18 },
    state: { supplyApy: 0.013, borrowApy: 0.021, utilization: 0.62, supplyAssetsUsd: 15.01, borrowAssetsUsd: 9.38 },
  });

  it("filters to curated markets by default, widens with includeUnlisted", async () => {
    const items = [apiMarket(`0x${"01".repeat(32)}`, true), apiMarket(`0x${"02".repeat(32)}`, false)];
    setFetchForTests(async () =>
      new Response(JSON.stringify({ data: { markets: { items } } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const curated = await morphoReads.markets({});
    expect(curated.ok).toBe(true);
    expect((curated.data as { markets: unknown[] }).markets).toHaveLength(1);

    const all = await morphoReads.markets({ includeUnlisted: true });
    expect((all.data as { markets: unknown[] }).markets).toHaveLength(2);
  });

  it("falls back to the pinned on-chain set when the API is down", async () => {
    setFetchForTests(async () => {
      throw new Error("api down");
    });
    const m = marketReads();
    setRpcForTests(fakeClient({ reads: m }));
    const res = await morphoReads.markets({});
    expect(res.ok).toBe(true);
    const data = res.data as { note: string; markets: Array<{ loan: string; borrowApy: string }> };
    expect(data.note).toContain("unreachable");
    expect(data.markets.length).toBeGreaterThan(0);
    expect(data.markets[0].loan).toBe("USDG");
    expect(Number.parseFloat(data.markets[0].borrowApy)).toBeGreaterThan(4);
  });
});
