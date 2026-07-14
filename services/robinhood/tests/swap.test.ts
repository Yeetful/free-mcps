import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { UNIVERSAL_ROUTER_ABI, setRpcForTests } from "@/lib/chain";
import { PERMIT2, UNIVERSAL_ROUTER, resolveToken } from "@/lib/registry";
import { guardV4Build, swap } from "@/lib/swap";
import type { SendTransactionAction } from "@/lib/tx";
import { fakeClient, feedRound, type FakeCall } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;
const USDG = resolveToken("USDG")!;
const AAPL = resolveToken("AAPL")!;

/** Quoter fake: the 0.30% pool answers best, the 1% pool worse, others empty. */
const quoterSim = (c: FakeCall) => {
  const params = (c.args as [{ poolKey: { fee: number } }])[0];
  if (params.poolKey.fee === 3000) return [2n * 10n ** 18n, 100_000n]; // 2 AAPL
  if (params.poolKey.fee === 10_000) return [19n * 10n ** 17n, 100_000n]; // 1.9 AAPL
  throw new Error("no pool");
};

function swapFake(opts: { balance?: bigint; erc20Allowance?: bigint; permit2Allowance?: [bigint, bigint, bigint] } = {}) {
  return fakeClient({
    reads: {
      balanceOf: opts.balance ?? 1_000_000_000n, // 1000 USDG
      allowance: (c: FakeCall) =>
        c.address.toLowerCase() === PERMIT2.toLowerCase()
          ? (opts.permit2Allowance ?? [0n, 0n, 0n])
          : (opts.erc20Allowance ?? 0n),
      latestRoundData: (c: FakeCall) =>
        c.address.toLowerCase() === USDG.feed!.toLowerCase() ? feedRound(1) : feedRound(250),
    },
    simulations: { quoteExactInputSingle: quoterSim },
  });
}

afterEach(() => setRpcForTests(null));

describe("quote", () => {
  it("scans the no-hook keys, picks the best pool, and cross-checks Chainlink", async () => {
    setRpcForTests(swapFake());
    const res = await swap.quote({ sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { buy: string; pool: { fee: string }; feedCheck: { divergence: string; warning?: string } };
    expect(data.buy).toContain("2 AAPL");
    expect(data.pool.fee).toBe("0.3%"); // best amountOut won, not first-hit
    // exec 0.004 AAPL/USDG vs Chainlink 1/250 → 0% divergence, no warning
    expect(Number.parseFloat(data.feedCheck.divergence)).toBeLessThan(0.1);
    expect(data.feedCheck.warning).toBeUndefined();
  });

  it("404s a pair no pool quotes", async () => {
    setRpcForTests(fakeClient({ simulations: { quoteExactInputSingle: () => { throw new Error("no pool"); } }, reads: {} }));
    const res = await swap.quote({ sellToken: "AAPL", buyToken: "TSLA", amount: "1" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("USDG");
  });
});

describe("build_swap", () => {
  it("builds approve→Permit2→swap with exact amounts and passes its own guard", async () => {
    setRpcForTests(swapFake());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(true);
    const data = res.data as { steps: SendTransactionAction[]; minimumOut: string; guard: string };
    expect(data.steps).toHaveLength(3);
    expect(data.guard).toContain("passed");
    expect(data.minimumOut).toContain("1.98 AAPL"); // 2 AAPL − 1% default slippage

    const swapStep = data.steps[2];
    expect(swapStep.tx.to.toLowerCase()).toBe(UNIVERSAL_ROUTER.toLowerCase());
    expect(swapStep.tx.value).toBe("0");
    const dec = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: swapStep.tx.data as `0x${string}` });
    expect(dec.functionName).toBe("execute");
    expect(dec.args[0]).toBe("0x10"); // the single V4_SWAP command
  });

  it("skips approvals the live allowances already cover", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    setRpcForTests(swapFake({ erc20Allowance: 10n ** 12n, permit2Allowance: [10n ** 12n, future, 0n] }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect((res.data as { steps: unknown[] }).steps).toHaveLength(1);
  });

  it("refuses over-balance honestly", async () => {
    setRpcForTests(swapFake({ balance: 100_000_000n }));
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    expect(res.ok).toBe(false);
    expect(res.data).toContain("Insufficient USDG");
  });
});

describe("the guard (fail-closed)", () => {
  async function builtSteps(): Promise<{ steps: SendTransactionAction[] }> {
    setRpcForTests(swapFake());
    const res = await swap.build({ user: USER, sellToken: "USDG", buyToken: "AAPL", amount: "500" });
    return res.data as { steps: SendTransactionAction[] };
  }

  const exp = (over: Partial<Parameters<typeof guardV4Build>[1]> = {}) => ({
    sellToken: USDG.address,
    buyToken: AAPL.address,
    amountIn: 500_000_000n,
    minOut: (2n * 10n ** 18n * 9900n) / 10_000n,
    poolKey: {
      currency0: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? USDG.address : AAPL.address) as `0x${string}`,
      currency1: (USDG.address.toLowerCase() < AAPL.address.toLowerCase() ? AAPL.address : USDG.address) as `0x${string}`,
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    },
    permit2Expiration: 0, // overridden per test
    ...over,
  });

  it("refuses a swap addressed to a different router", async () => {
    const { steps } = await builtSteps();
    const tampered = steps.map((s, i) =>
      i === steps.length - 1 ? { ...s, tx: { ...s.tx, to: "0x000000000000000000000000000000000000dEaD" } } : s,
    );
    const verdict = guardV4Build(tampered, exp());
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("pinned Universal Router");
  });

  it("refuses when the amounts don't match the quote", async () => {
    const { steps } = await builtSteps();
    const verdict = guardV4Build(steps, exp({ amountIn: 999_000_000n }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("amount");
  });

  it("refuses native value on the swap", async () => {
    const { steps } = await builtSteps();
    const tampered = steps.map((s, i) => (i === steps.length - 1 ? { ...s, tx: { ...s.tx, value: "1" } } : s));
    const verdict = guardV4Build(tampered, exp({ amountIn: 500_000_000n }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("zero native value");
  });
});
