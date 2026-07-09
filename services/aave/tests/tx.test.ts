import { describe, it, expect } from "vitest";
import { builds } from "@/lib/tx";

// Fixtures mirror live api.v4.aave.com ExecutionPlan responses (2026-07-09).
// The per-op amount shapes are LIVE schema, not docs (withdraw is flat
// {erc20:{exact|max}}, repay nests {erc20:{value:{exact|max}}}) — these tests
// pin them so a "docs-correct" refactor can't silently break the wire format.

const USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const MAIN_SPOKE = "0x94e7A5dCbE816e498b89aB752661904E2F56c485";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_RESERVE_ID = "MTo6MHg5NGU3QTVkQ2JFODE2ZTQ5OGI4OWFCNzUyNjYxOTA0RTJGNTZjNDg1Ojo3";

const RESERVE_LOOKUP_RESPONSE = {
  reserves: [
    {
      // borrow-only leg of the same asset on another spoke — must NOT match
      id: "OTHER_SPOKE_RESERVE",
      canSupply: false,
      canBorrow: true,
      spoke: { name: "Bluechip", address: "0x973a023A77420ba610f06b3858aD991Df6d85A08" },
      asset: { underlying: { address: USDC, info: { symbol: "USDC", decimals: 6 } } },
    },
    {
      id: USDC_RESERVE_ID,
      canSupply: true,
      canBorrow: true,
      spoke: { name: "Main", address: MAIN_SPOKE },
      asset: { underlying: { address: USDC, info: { symbol: "USDC", decimals: 6 } } },
    },
  ],
};

const TX = (operations: string[] | null, data = "0xdeadbeef") => ({
  __typename: "TransactionRequest",
  to: MAIN_SPOKE,
  from: USER,
  data,
  value: "0",
  chainId: 1,
  operations,
});

interface Captured {
  query: string;
  variables: Record<string, any>;
}

function fetchStub(planByRoot: Record<string, unknown>, captured: Captured[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, any> };
    captured.push({ query: body.query, variables: body.variables });
    if (body.query.includes("reserves(")) {
      return new Response(JSON.stringify({ data: RESERVE_LOOKUP_RESPONSE }), { status: 200 });
    }
    const root = Object.keys(planByRoot).find((k) => body.query.includes(`${k}(`));
    if (!root) return new Response(JSON.stringify({ errors: [{ message: `no stub for query` }] }), { status: 200 });
    const plan = planByRoot[root];
    if (plan && typeof plan === "object" && "errors" in (plan as object)) {
      return new Response(JSON.stringify(plan), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { [root]: plan } }), { status: 200 });
  }) as typeof fetch;
}

describe("reserve resolution", () => {
  it("errors legibly when the token isn't on the requested spoke, listing where it IS", async () => {
    const fetchImpl = fetchStub({});
    const r = await builds.supply(
      { spokeAddress: "0x0000000000000000000000000000000000000001", currency: USDC, amount: "10", user: USER },
      { fetchImpl },
    );
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Main");
    expect(String(r.data)).toContain("Bluechip");
  });

  it("matches the spoke case-insensitively", async () => {
    const fetchImpl = fetchStub({ supply: TX(["SPOKE_SUPPLY"]) });
    const r = await builds.supply(
      { spokeAddress: MAIN_SPOKE.toLowerCase(), currency: USDC, amount: "10", user: USER },
      { fetchImpl },
    );
    expect(r.ok).toBe(true);
  });
});

describe("builds.supply", () => {
  it("maps Erc20ApprovalRequired to approve → supply steps with allowance info", async () => {
    const plan = {
      __typename: "Erc20ApprovalRequired",
      reason: "Not enough approval",
      requiredAmount: { value: "10.000000", decimals: 6 },
      currentAllowance: { value: "0.000000", decimals: 6 },
      approvals: [{ byTransaction: { to: USDC, from: USER, data: "0x095ea7b3aa", value: "0", chainId: 1, operations: null } }],
      originalTransaction: TX(["SPOKE_SUPPLY"], "0x852a56a5bb"),
    };
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ supply: plan }, captured);
    const r = await builds.supply({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "10", user: USER }, { fetchImpl });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, any>;
    expect(d.steps).toHaveLength(2);
    expect(d.steps[0]).toMatchObject({ action: "send_transaction", label: "approve", tx: { to: USDC, data: "0x095ea7b3aa" } });
    expect(d.steps[1]).toMatchObject({ action: "send_transaction", label: "supply", tx: { to: MAIN_SPOKE, data: "0x852a56a5bb", chainId: 1 } });
    expect(d).toMatchObject({ requiredAllowance: "10.000000", currentAllowance: "0.000000", asset: "USDC", spoke: "Main" });
    expect(d.submit_with).toContain("SPOKE_SUPPLY");

    // wire shape: supply amount = {erc20:{value}} and the resolved reserve id
    const supplyCall = captured.find((c) => c.query.includes("supply("))!;
    expect(supplyCall.variables.request).toMatchObject({
      sender: USER,
      reserve: USDC_RESERVE_ID,
      amount: { erc20: { value: "10" } },
    });
  });

  it("labels a two-step allowance (USDT reset-then-set) distinctly", async () => {
    const plan = {
      __typename: "Erc20ApprovalRequired",
      requiredAmount: { value: "5.000000" },
      currentAllowance: { value: "1.000000" },
      approvals: [
        { byTransaction: { to: USDC, data: "0x01", value: "0", chainId: 1 } },
        { byTransaction: { to: USDC, data: "0x02", value: "0", chainId: 1 } },
      ],
      originalTransaction: TX(["SPOKE_SUPPLY"]),
    };
    const fetchImpl = fetchStub({ supply: plan });
    const r = await builds.supply({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "5", user: USER }, { fetchImpl });
    const d = r.data as Record<string, any>;
    expect(d.steps.map((s: any) => s.label)).toEqual(["approve 1/2", "approve 2/2", "supply"]);
  });

  it("surfaces InsufficientBalanceError as a legible refusal (nothing built)", async () => {
    const plan = {
      __typename: "InsufficientBalanceError",
      required: { value: "100.000000", decimals: 6 },
      available: { value: "36.772124", decimals: 6 },
    };
    const fetchImpl = fetchStub({ supply: plan });
    const r = await builds.supply({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "100", user: USER }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("100.000000");
    expect(String(r.data)).toContain("36.772124");
  });

  it("passes enableCollateral through to the request", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ supply: TX(["SPOKE_SUPPLY"]) }, captured);
    await builds.supply(
      { spokeAddress: MAIN_SPOKE, currency: USDC, amount: "10", user: USER, enableCollateral: true },
      { fetchImpl },
    );
    const call = captured.find((c) => c.query.includes("supply("))!;
    expect(call.variables.request.enableCollateral).toBe(true);
  });
});

describe("builds.withdraw", () => {
  it("uses the FLAT AmountInput shape (exact) — the live schema, not the docs", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ withdraw: TX(["SPOKE_WITHDRAW"], "0x0ad58d2fcc") }, captured);
    const r = await builds.withdraw({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "5", user: USER }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect((r.data as any).steps).toHaveLength(1);
    const call = captured.find((c) => c.query.includes("withdraw("))!;
    expect(call.variables.request.amount).toEqual({ erc20: { exact: "5" } });
  });

  it("maps max:true to {erc20:{max:true}}", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ withdraw: TX(["SPOKE_WITHDRAW"]) }, captured);
    await builds.withdraw({ spokeAddress: MAIN_SPOKE, currency: USDC, max: true, user: USER }, { fetchImpl });
    const call = captured.find((c) => c.query.includes("withdraw("))!;
    expect(call.variables.request.amount).toEqual({ erc20: { max: true } });
  });

  it("relays server-side guardrails (HF-below-1) as legible errors", async () => {
    const fetchImpl = fetchStub({
      withdraw: {
        errors: [{ message: "Bad user input - Withdrawing this amount would reduce the health factor below 1" }],
      },
    });
    const r = await builds.withdraw({ spokeAddress: MAIN_SPOKE, currency: USDC, max: true, user: USER }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("health factor below 1");
  });
});

describe("builds.borrow", () => {
  it("builds a single borrow step with the {erc20:{value}} shape", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ borrow: TX(["SPOKE_BORROW"], "0xd6bda0c0dd") }, captured);
    const r = await builds.borrow({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "5", user: USER }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect((r.data as any).steps[0]).toMatchObject({ label: "borrow", tx: { data: "0xd6bda0c0dd" } });
    const call = captured.find((c) => c.query.includes("borrow("))!;
    expect(call.variables.request.amount).toEqual({ erc20: { value: "5" } });
  });
});

describe("builds.repay", () => {
  it("uses the NESTED value shape and quotes max repay through approval steps", async () => {
    const plan = {
      __typename: "Erc20ApprovalRequired",
      requiredAmount: { value: "0.353536", decimals: 6 },
      currentAllowance: { value: "0.000000", decimals: 6 },
      approvals: [{ byTransaction: { to: USDC, data: "0x095ea7b3ee", value: "0", chainId: 1 } }],
      originalTransaction: TX(["SPOKE_REPAY"], "0xb1e8f8efff"),
    };
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ repay: plan }, captured);
    const r = await builds.repay({ spokeAddress: MAIN_SPOKE, currency: USDC, max: true, user: USER }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect((r.data as any).steps.map((s: any) => s.label)).toEqual(["approve", "repay"]);
    const call = captured.find((c) => c.query.includes("repay("))!;
    expect(call.variables.request.amount).toEqual({ erc20: { value: { max: true } } });
  });

  it("exact repay nests {erc20:{value:{exact}}}", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ repay: TX(["SPOKE_REPAY"]) }, captured);
    await builds.repay({ spokeAddress: MAIN_SPOKE, currency: USDC, amount: "0.1", user: USER }, { fetchImpl });
    const call = captured.find((c) => c.query.includes("repay("))!;
    expect(call.variables.request.amount).toEqual({ erc20: { value: { exact: "0.1" } } });
  });
});

describe("builds.setCollateral", () => {
  it("builds the multicall toggle step with batch changes", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub(
      { setUserSuppliesAsCollateral: TX(["SPOKE_SET_USER_USING_AS_COLLATERAL"], "0xac9650d8aa") },
      captured,
    );
    const r = await builds.setCollateral(
      { spokeAddress: MAIN_SPOKE, currency: USDC, enable: true, user: USER },
      { fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect((r.data as any).steps[0].label).toBe("set_collateral");
    const call = captured.find((c) => c.query.includes("setUserSuppliesAsCollateral("))!;
    expect(call.variables.request.changes).toEqual([{ reserve: USDC_RESERVE_ID, enableCollateral: true }]);
  });
});

describe("builds.preview", () => {
  const PREVIEW = {
    __typename: "PreviewUserPosition",
    healthFactor: { __typename: "HealthFactorVariation", current: "1.300426712399046576", after: "1.114712914415545511" },
    netApy: { current: { value: "0.0206", normalized: "2.06" }, after: { value: "0.0177", normalized: "1.77" } },
    netCollateral: { current: { value: "400.3606", symbol: "$" }, after: { value: "300.3911", symbol: "$" } },
    remainingBorrowingPower: { current: { value: "180.2706", symbol: "$" }, after: { value: "80.3011", symbol: "$" } },
    reserveRates: {
      supplyApy: { current: { value: "0.0217", normalized: "2.17" }, after: { value: "0.0217", normalized: "2.17" } },
      borrowApy: { current: { value: "0.0323", normalized: "3.23" }, after: { value: "0.0324", normalized: "3.24" } },
    },
  };

  it("shapes a borrow preview with before/after health factor", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ preview: PREVIEW }, captured);
    const r = await builds.preview(
      { action: "borrow", spokeAddress: MAIN_SPOKE, currency: USDC, amount: "100", user: USER },
      { fetchImpl },
    );
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, any>;
    expect(d.healthFactor).toMatchObject({ current: "1.300426712399046576", after: "1.114712914415545511" });
    expect(d.remainingBorrowingPowerUsd).toEqual({ current: "180.2706", after: "80.3011" });
    // preview mirrors the op's own amount shape — borrow = {erc20:{value}}
    const call = captured.find((c) => c.query.includes("preview("))!;
    expect(call.variables.request.action.borrow.amount).toEqual({ erc20: { value: "100" } });
  });

  it("renders after:null on a full repay as infinite health factor", async () => {
    const fetchImpl = fetchStub({
      preview: { ...PREVIEW, healthFactor: { __typename: "HealthFactorVariation", current: "5.64", after: null } },
    });
    const r = await builds.preview(
      { action: "repay", spokeAddress: MAIN_SPOKE, currency: USDC, max: true, user: USER },
      { fetchImpl },
    );
    expect((r.data as any).healthFactor.after).toBe("∞ (no debt)");
  });

  it("mirrors withdraw's flat amount shape in the preview action", async () => {
    const captured: Captured[] = [];
    const fetchImpl = fetchStub({ preview: PREVIEW }, captured);
    await builds.preview(
      { action: "withdraw", spokeAddress: MAIN_SPOKE, currency: USDC, amount: "100", user: USER },
      { fetchImpl },
    );
    const call = captured.find((c) => c.query.includes("preview("))!;
    expect(call.variables.request.action.withdraw.amount).toEqual({ erc20: { exact: "100" } });
  });
});
