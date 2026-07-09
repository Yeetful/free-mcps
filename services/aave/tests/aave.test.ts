import { describe, it, expect } from "vitest";
import { queries, gqlRequest, clip, pct, fiat, isEvmAddress } from "@/lib/aave";

// Fixtures mirror live api.v4.aave.com responses (probed 2026-07-09). If the
// upstream shape drifts, update these from a fresh `pnpm smoke` run.

const USER = "0x71F12a5b0E60d2Ff8A87FD34E7dcff3c10c914b0";

function fetchStub(handler: (query: string, variables: Record<string, unknown>) => unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const data = handler(body.query, body.variables);
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const HUB_FIXTURE = {
  address: "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
  name: "Core",
  chain: { chainId: 1, name: "Ethereum" },
  summary: {
    totalSupplied: { current: { value: "211169551.1768", symbol: "$" } },
    totalBorrowed: { current: { value: "78504770.9555", symbol: "$" } },
    utilizationRate: { value: "0.3717617929195844309391312752", normalized: "37.17617929195844309391312752" },
  },
};

const SPOKE_FIXTURE = {
  id: "MTo6MHg5NzNhMDIzQTc3NDIwYmE2MTBmMDZiMzg1OGFEOTkxRGY2ZDg1QTA4",
  name: "Bluechip",
  address: "0x973a023A77420ba610f06b3858aD991Df6d85A08",
  chain: { chainId: 1, name: "Ethereum" },
  summary: {
    totalSupplied: { value: "28450111.0064", symbol: "$" },
    totalBorrowed: { value: "10613921.8491", symbol: "$" },
    uniqueAssets: 9,
  },
  connectedHubs: [{ hub: { name: "Core", address: "0xCca8" } }, { hub: { name: "Prime", address: "0x9438" } }],
};

const RESERVE_FIXTURE = (over: Record<string, unknown> = {}) => ({
  id: "MTo6MHg5NzNhMDIzQTc3NDIwYmE2MTBmMDZiMzg1OGFEOTkxRGY2ZDg1QTA4Ojoy",
  onChainId: "2",
  canBorrow: false,
  canSupply: true,
  canUseAsCollateral: true,
  status: { active: true, frozen: false, paused: false },
  settings: {
    collateralFactor: { value: "0.845", normalized: "84.50" },
    borrowCap: { amount: { value: "0.00000000" } },
    supplyCap: { amount: { value: "130.00000000" } },
  },
  summary: {
    supplied: { amount: { value: "62.01774621" }, exchange: { value: "3886172.5086", symbol: "$" } },
    borrowed: { amount: { value: "0.00000000" }, exchange: { value: "0", symbol: "$" } },
    supplyApy: { value: "0.0132", normalized: "1.32" },
    borrowApy: { value: "0", normalized: "0" },
  },
  spoke: { name: "Bluechip", address: "0x973a023A77420ba610f06b3858aD991Df6d85A08", chain: { chainId: 1 } },
  asset: {
    underlying: {
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      info: { name: "Coinbase WBTC", symbol: "cbBTC", decimals: 8 },
    },
  },
  ...over,
});

describe("value helpers", () => {
  it("pct converts PercentNumber to percent, preferring normalized", () => {
    expect(pct({ normalized: "4.5199", value: "0.0452" })).toBe(4.5199);
    expect(pct({ value: "0.0452" })).toBe(4.52);
    expect(pct(null)).toBeNull();
  });

  it("fiat renders ExchangeAmount as a display string", () => {
    expect(fiat({ value: "211169551.1768", symbol: "$" })).toBe("$211,169,551.18");
    expect(fiat(null)).toBeNull();
  });

  it("clip truncates oversized payloads with a note", () => {
    const big = { rows: "x".repeat(30_000) };
    const clipped = clip(big) as { note?: string; preview?: string };
    expect(clipped.note).toBeTruthy();
    expect(clipped.preview!.length).toBeLessThanOrEqual(24_000);
  });

  it("isEvmAddress accepts 0x40-hex only", () => {
    expect(isEvmAddress(USER)).toBe(true);
    expect(isEvmAddress("0x123")).toBe(false);
  });
});

describe("gqlRequest", () => {
  it("surfaces GraphQL-level errors as ok:false with joined messages", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Unknown field `amount`" }] }), { status: 200 })) as typeof fetch;
    const r = await gqlRequest("query { x }", {}, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.data).toContain("Unknown field");
  });

  it("surfaces HTTP errors with the raw body", async () => {
    const fetchImpl = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    const r = await gqlRequest("query { x }", {}, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });
});

describe("queries.markets", () => {
  it("merges hubs + spokes into one overview", async () => {
    const fetchImpl = fetchStub((query) =>
      query.includes("hubs(") ? { hubs: [HUB_FIXTURE] } : { spokes: [SPOKE_FIXTURE] },
    );
    const r = await queries.markets({}, { fetchImpl });
    expect(r.ok).toBe(true);
    const data = r.data as { hubs: any[]; spokes: any[] };
    expect(data.hubs[0]).toMatchObject({
      name: "Core",
      totalSuppliedUsd: "$211,169,551.18",
      utilizationPct: 37.1762,
    });
    expect(data.spokes[0]).toMatchObject({ name: "Bluechip", assets: 9, hubs: ["Core", "Prime"] });
  });
});

describe("queries.reserves", () => {
  it("shapes reserves with APYs and sorts by supplied USD", async () => {
    const small = RESERVE_FIXTURE({
      summary: {
        ...RESERVE_FIXTURE().summary,
        supplied: { amount: { value: "1" }, exchange: { value: "100", symbol: "$" } },
      },
      asset: { underlying: { address: "0xaaa", info: { name: "Small", symbol: "SML", decimals: 18 } } },
    });
    const fetchImpl = fetchStub(() => ({ reserves: [small, RESERVE_FIXTURE()] }));
    const r = await queries.reserves({}, { fetchImpl });
    expect(r.ok).toBe(true);
    const data = r.data as { count: number; reserves: any[] };
    expect(data.count).toBe(2);
    expect(data.reserves[0].asset.symbol).toBe("cbBTC"); // bigger pool first
    expect(data.reserves[0]).toMatchObject({
      spoke: "Bluechip",
      canSupply: true,
      active: true,
      collateralFactorPct: 84.5,
      supplyApyPct: 1.32,
      suppliedUsd: "$3,886,172.51",
    });
    expect(data.reserves[0]._usd).toBeUndefined(); // internal sort key stripped
  });

  it("filters by symbol case-insensitively", async () => {
    const fetchImpl = fetchStub(() => ({ reserves: [RESERVE_FIXTURE()] }));
    const hit = await queries.reserves({ symbols: ["cbbtc"] }, { fetchImpl });
    expect((hit.data as { count: number }).count).toBe(1);
    const miss = await queries.reserves({ symbols: ["USDC"] }, { fetchImpl });
    expect((miss.data as { count: number }).count).toBe(0);
  });
});

describe("queries.portfolio", () => {
  const positionsFixture = {
    userPositions: [
      {
        user: USER,
        createdAt: "2026-04-09T03:15:11+00:00",
        spoke: { name: "Gold", address: "0x65407b940966954b23dfA3caA5C0702bB42984DC", chain: { chainId: 1 } },
        totalSupplied: { current: { value: "126738.5482", symbol: "$" } },
        totalCollateral: { current: { value: "126738.5482", symbol: "$" } },
        totalDebt: { current: { value: "75169.1094", symbol: "$" } },
        netBalance: { current: { value: "51569.4388", symbol: "$" } },
        netApy: { value: "-0.0392126354177536507048816129", normalized: "-3.92126354177536507048816129" },
        netAccruedInterest: { value: "-182.7112", symbol: "$" },
        healthFactor: { current: "1.264534220215885597" },
        maxBorrowingPower: { value: "95053.9111", symbol: "$" },
        remainingBorrowingPower: { value: "19884.8017", symbol: "$" },
      },
    ],
  };
  const suppliesFixture = {
    userSupplies: [
      {
        isCollateral: true,
        balance: {
          amount: { value: "111.003074476699508170" },
          exchange: { value: "193496.1559", symbol: "$" },
          token: {
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            info: { name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
          },
        },
        principal: { amount: { value: "111.000000000000000000" } },
        withdrawable: { amount: { value: "111.003074476699508170" } },
        interest: { amount: { value: "0.003074476699508170" }, exchange: { value: "5.3593", symbol: "$" } },
        reserve: { spoke: { name: "Main", address: "0x94e7" }, summary: { supplyApy: { value: "0.0119", normalized: "1.19" } } },
      },
    ],
  };
  const borrowsFixture = {
    userBorrows: [
      {
        debt: {
          amount: { value: "156057.798220" },
          exchange: { value: "155911.5034", symbol: "$" },
          token: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", info: { name: "Tether USD", symbol: "USDT", decimals: 6 } },
        },
        principal: { amount: { value: "156000.000000" } },
        interest: { amount: { value: "57.798220" }, exchange: { value: "57.7440", symbol: "$" } },
        reserve: { spoke: { name: "Main", address: "0x94e7" }, summary: { borrowApy: { value: "0.0614", normalized: "6.14" } } },
      },
    ],
  };

  it("merges positions + supplies (earnings) + borrows into one account view", async () => {
    const fetchImpl = fetchStub((query) => {
      if (query.includes("userPositions(")) return positionsFixture;
      if (query.includes("userSupplies(")) return suppliesFixture;
      return borrowsFixture;
    });
    const r = await queries.portfolio({ user: USER }, { fetchImpl });
    expect(r.ok).toBe(true);
    const data = r.data as { positions: any[]; supplies: any[]; borrows: any[]; note?: string };
    expect(data.note).toBeUndefined();
    expect(data.positions[0]).toMatchObject({
      spoke: "Gold",
      healthFactor: "1.264534220215885597",
      netApyPct: -3.9213,
      remainingBorrowingPowerUsd: "$19,884.80",
    });
    expect(data.supplies[0]).toMatchObject({
      token: { symbol: "WETH" },
      earnedInterest: "0.003074476699508170",
      earnedInterestUsd: "$5.36",
      isCollateral: true,
      supplyApyPct: 1.19,
    });
    expect(data.borrows[0]).toMatchObject({
      token: { symbol: "USDT" },
      debtUsd: "$155,911.50",
      accruedInterest: "57.798220",
      borrowApyPct: 6.14,
    });
  });

  it("returns a helpful note for an address with no positions", async () => {
    const fetchImpl = fetchStub((query) => {
      if (query.includes("userPositions(")) return { userPositions: [] };
      if (query.includes("userSupplies(")) return { userSupplies: [] };
      return { userBorrows: [] };
    });
    const r = await queries.portfolio({ user: USER }, { fetchImpl });
    const data = r.data as { note?: string; positions: any[] };
    expect(data.positions).toHaveLength(0);
    expect(data.note).toMatch(/balances/);
  });
});

describe("queries.balances", () => {
  it("shapes wallet balances with best supply APY, drops zero balances", async () => {
    const fetchImpl = fetchStub(() => ({
      userBalances: [
        {
          info: { name: "USDe", symbol: "USDe", decimals: 18 },
          totalAmount: { value: "4150.523362533240672484" },
          exchange: { value: "4146.6325", symbol: "$" },
          balances: [{ __typename: "Erc20Amount", token: { address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3" } }],
          highestSupplyApy: { value: "0.0123", normalized: "1.23" },
        },
        {
          info: { name: "Ether", symbol: "ETH", decimals: 18 },
          totalAmount: { value: "0.711188856623834507" },
          exchange: { value: "1239.7162", symbol: "$" },
          balances: [{ __typename: "NativeAmount" }],
          highestSupplyApy: { value: "0.0119", normalized: "1.19" },
        },
        {
          info: { name: "Dust", symbol: "DST", decimals: 18 },
          totalAmount: { value: "0" },
          exchange: { value: "0", symbol: "$" },
          balances: [],
          highestSupplyApy: { value: "0", normalized: "0" },
        },
      ],
    }));
    const r = await queries.balances({ user: USER }, { fetchImpl });
    const data = r.data as { balances: any[] };
    expect(data.balances).toHaveLength(2); // dust dropped
    expect(data.balances[0]).toMatchObject({ symbol: "USDe", usd: "$4,146.63", bestSupplyApyPct: 1.23, native: false });
    expect(data.balances[1]).toMatchObject({ symbol: "ETH", native: true, address: null });
  });
});

describe("queries.activities", () => {
  it("flattens the activity union into typed rows", async () => {
    const fetchImpl = fetchStub(() => ({
      activities: {
        items: [
          {
            __typename: "BorrowActivity",
            timestamp: "2026-07-08T17:46:59+00:00",
            txHash: "0xd4df",
            spoke: { name: "Main" },
            borrowed: { amount: { value: "99000.000000" }, token: { info: { symbol: "USDT" } } },
          },
          {
            __typename: "SupplyActivity",
            timestamp: "2026-07-08T17:28:47+00:00",
            txHash: "0xede0",
            spoke: { name: "Main" },
            supplied: { amount: { value: "111.000000000000000000" }, token: { info: { symbol: "WETH" } } },
          },
        ],
        pageInfo: { next: "cursor123" },
      },
    }));
    const r = await queries.activities({ user: USER }, { fetchImpl });
    const data = r.data as { activities: any[]; nextCursor: string };
    expect(data.activities[0]).toMatchObject({ type: "BORROW", amount: "99000.000000", symbol: "USDT" });
    expect(data.activities[1]).toMatchObject({ type: "SUPPLY", symbol: "WETH" });
    expect(data.nextCursor).toBe("cursor123");
  });
});
