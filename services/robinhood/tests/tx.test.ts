import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { MORPHO_ABI, TOKEN_ABI, INBOX_ABI, ARB_SYS_ABI, setL1RpcForTests, setRpcForTests } from "@/lib/chain";
import { ARB_SYS, L1_INBOX, MORPHO, resolveToken } from "@/lib/registry";
import { builds, type SendTransactionAction } from "@/lib/tx";
import { fakeClient, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const DEST = "0x2222222222222222222222222222222222222222" as const;
const MARKET_ID = `0x${"ab".repeat(32)}`;
const USDG = resolveToken("USDG")!;
const TSLA = resolveToken("TSLA")!;

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

interface MarketFakeOpts {
  usdgBalance?: bigint;
  usdgAllowance?: bigint;
  tslaBalance?: bigint;
  position?: { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
}

/** USDG/TSLA market (1000 supplied / 600 borrowed, lltv 77%, TSLA at $300). */
function marketFake(opts: MarketFakeOpts = {}) {
  return fakeClient({
    reads: {
      idToMarketParams: {
        loanToken: USDG.address,
        collateralToken: TSLA.address,
        oracle: "0x00000000000000000000000000000000000000A1",
        irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
        lltv: 770_000_000_000_000_000n,
      },
      market: {
        totalSupplyAssets: 1_000_000_000n,
        totalSupplyShares: 1_000_000_000n * 10n ** 6n,
        totalBorrowAssets: 600_000_000n,
        totalBorrowShares: 600_000_000n * 10n ** 6n,
        lastUpdate: nowSec(),
        fee: 0n,
      },
      borrowRateView: 0n, // no drift → assertions are exact
      price: 300n * 10n ** 6n * 10n ** 18n,
      position: opts.position ?? { supplyShares: 0n, borrowShares: 0n, collateral: 0n },
      balanceOf: (c: FakeCall) =>
        c.address.toLowerCase() === USDG.address.toLowerCase() ? (opts.usdgBalance ?? 0n) : (opts.tslaBalance ?? 0n),
      allowance: () => opts.usdgAllowance ?? 0n,
      decimals: (c: FakeCall) => (c.address.toLowerCase() === USDG.address.toLowerCase() ? 6 : 18),
    },
  });
}

afterEach(() => {
  setRpcForTests(null);
  setL1RpcForTests(null);
});

const stepsOf = (data: unknown) => (data as { steps: SendTransactionAction[] }).steps;

describe("build_lend", () => {
  it("builds approve (exact) + supply when the allowance is short", async () => {
    setRpcForTests(marketFake({ usdgBalance: 200_000_000n, usdgAllowance: 0n }));
    const res = await builds.lend({ user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    expect(steps).toHaveLength(2);

    const approve = decodeFunctionData({ abi: TOKEN_ABI, data: steps[0].tx.data as `0x${string}` });
    expect(approve.functionName).toBe("approve");
    expect(approve.args).toEqual([MORPHO, 100_000_000n]); // exactly 100 USDG at 6 decimals
    expect(steps[0].tx.to.toLowerCase()).toBe(USDG.address.toLowerCase());

    const supply = decodeFunctionData({ abi: MORPHO_ABI, data: steps[1].tx.data as `0x${string}` });
    expect(supply.functionName).toBe("supply");
    expect(supply.args![1]).toBe(100_000_000n);
    expect(supply.args![3]).toBe(USER);
    expect(steps[1].tx).toMatchObject({ to: MORPHO, value: "0", chainId: 4663 });
  });

  it("skips the approve step when the live allowance covers it", async () => {
    setRpcForTests(marketFake({ usdgBalance: 200_000_000n, usdgAllowance: 500_000_000n }));
    const res = await builds.lend({ user: USER, marketId: MARKET_ID, amount: "100" });
    expect(stepsOf(res.data)).toHaveLength(1);
  });

  it("refuses over-balance honestly", async () => {
    setRpcForTests(marketFake({ usdgBalance: 50_000_000n }));
    const res = await builds.lend({ user: USER, marketId: MARKET_ID, amount: "100" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("Insufficient USDG");
    expect(res.data).toContain("Nothing was built");
  });
});

describe("build_borrow (fails closed on health)", () => {
  const withCollateral = { supplyShares: 0n, borrowShares: 0n, collateral: 10n ** 18n }; // 1 TSLA = $300

  it("refuses with no collateral posted", async () => {
    setRpcForTests(marketFake({}));
    const res = await builds.borrow({ user: USER, marketId: MARKET_ID, amount: "50" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("No collateral");
  });

  it("refuses a borrow beyond the collateral's power", async () => {
    setRpcForTests(marketFake({ position: withCollateral }));
    // max borrow = 300 × 0.77 = 231 USDG
    const res = await builds.borrow({ user: USER, marketId: MARKET_ID, amount: "250" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("borrowing power");
  });

  it("builds a safe borrow with the health factor stated", async () => {
    setRpcForTests(marketFake({ position: withCollateral }));
    const res = await builds.borrow({ user: USER, marketId: MARKET_ID, amount: "50" });
    expect(res.ok).toBe(true);
    const data = res.data as { healthFactorAfter: number; steps: SendTransactionAction[] };
    expect(data.healthFactorAfter).toBeCloseTo(4.62, 1); // 231 / 50
    const borrow = decodeFunctionData({ abi: MORPHO_ABI, data: data.steps[0].tx.data as `0x${string}` });
    expect(borrow.functionName).toBe("borrow");
    expect(borrow.args![1]).toBe(50_000_000n);
    expect(borrow.args![4]).toBe(USER); // receiver is the user, always
  });
});

describe("build_repay / build_withdraw ('max' = shares mode)", () => {
  const withDebt = { supplyShares: 0n, borrowShares: 100_000_000n * 10n ** 6n, collateral: 10n ** 18n };

  it("repays 'max' by shares so the debt clears exactly", async () => {
    setRpcForTests(marketFake({ position: withDebt, usdgBalance: 200_000_000n }));
    const res = await builds.repay({ user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    const repay = decodeFunctionData({ abi: MORPHO_ABI, data: steps[steps.length - 1].tx.data as `0x${string}` });
    expect(repay.functionName).toBe("repay");
    expect(repay.args![1]).toBe(0n); // assets 0…
    expect(repay.args![2]).toBe(withDebt.borrowShares); // …shares exact
  });

  it("refuses a partial repay above the live debt", async () => {
    setRpcForTests(marketFake({ position: withDebt, usdgBalance: 500_000_000n }));
    const res = await builds.repay({ user: USER, marketId: MARKET_ID, amount: "150" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("exceeds the current debt");
  });

  it("withdraws 'max' supplied assets by shares", async () => {
    setRpcForTests(marketFake({ position: { supplyShares: 100_000_000n * 10n ** 6n, borrowShares: 0n, collateral: 0n } }));
    const res = await builds.withdraw({ user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(true);
    const withdraw = decodeFunctionData({ abi: MORPHO_ABI, data: stepsOf(res.data)[0].tx.data as `0x${string}` });
    expect(withdraw.functionName).toBe("withdraw");
    expect(withdraw.args![1]).toBe(0n);
    expect(withdraw.args![2]).toBe(100_000_000n * 10n ** 6n);
  });

  it("refuses withdrawing collateral out from under a debt", async () => {
    setRpcForTests(marketFake({ position: withDebt }));
    const res = await builds.withdrawCollateral({ user: USER, marketId: MARKET_ID, amount: "max" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("under-collateralized");
  });
});

describe("bridge builds", () => {
  it("deposit: one L1 transaction (chainId 1) carrying the ETH as value", async () => {
    setL1RpcForTests(fakeClient({ balances: { [USER.toLowerCase()]: 10n ** 18n } }));
    const res = await builds.bridgeDeposit({ user: USER, amount: "0.5" });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    expect(steps).toHaveLength(1);
    expect(steps[0].tx).toMatchObject({ to: L1_INBOX, value: (5n * 10n ** 17n).toString(), chainId: 1 });
    const dec = decodeFunctionData({ abi: INBOX_ABI, data: steps[0].tx.data as `0x${string}` });
    expect(dec.functionName).toBe("depositEth");
  });

  it("deposit: refuses over the live L1 balance", async () => {
    setL1RpcForTests(fakeClient({ balances: { [USER.toLowerCase()]: 10n ** 17n } }));
    const res = await builds.bridgeDeposit({ user: USER, amount: "0.5" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("Insufficient ETH on Ethereum");
  });

  it("withdraw: ArbSys withdrawEth on 4663 to the given destination", async () => {
    setRpcForTests(fakeClient({ balances: { [USER.toLowerCase()]: 10n ** 18n } }));
    const res = await builds.bridgeWithdraw({ user: USER, amount: "0.25", destination: DEST });
    expect(res.ok).toBe(true);
    const steps = stepsOf(res.data);
    expect(steps[0].tx).toMatchObject({ to: ARB_SYS, value: (25n * 10n ** 16n).toString(), chainId: 4663 });
    const dec = decodeFunctionData({ abi: ARB_SYS_ABI, data: steps[0].tx.data as `0x${string}` });
    expect(dec.functionName).toBe("withdrawEth");
    expect(dec.args).toEqual([DEST]);
    expect((res.data as { note: string }).note).toContain("7-day");
  });
});
