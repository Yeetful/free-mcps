import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData, parseEther } from "viem";
import { setRpcForTests, STETH, WSTETH, WITHDRAWAL_QUEUE, STETH_ABI, WSTETH_ABI, WITHDRAWAL_QUEUE_ABI } from "@/lib/chain";
import { builds, type SendTransactionAction } from "@/lib/tx";
import { fakeClient, wqStatus } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;

// Selectors computed independently with viem's toFunctionSelector (2026-07-13)
// — pin them so an accidental ABI edit can't silently change what users sign.
const SEL = {
  submit: "0xa1903eab",
  approve: "0x095ea7b3",
  wrap: "0xea598cb0",
  unwrap: "0xde0e9a3e",
  requestWithdrawals: "0xd6681042",
  requestWithdrawalsWstETH: "0x19aa6257",
  claimWithdrawals: "0xe3afe0a3",
};

afterEach(() => setRpcForTests(null));

const steps = (r: { data: unknown }): SendTransactionAction[] => (r.data as { steps: SendTransactionAction[] }).steps;

describe("build_stake", () => {
  it("builds submit() calldata with the exact ETH value and zero referral", async () => {
    setRpcForTests(
      fakeClient({
        balances: { [USER]: parseEther("2") },
        reads: { getCurrentStakeLimit: parseEther("150000") },
      }),
    );
    const r = await builds.stake({ user: USER, amount: "0.5" });
    expect(r.ok).toBe(true);
    const [s] = steps(r);
    expect(s.action).toBe("send_transaction");
    expect(s.tx.to).toBe(STETH);
    expect(s.tx.chainId).toBe(1);
    expect(s.tx.value).toBe(parseEther("0.5").toString());
    expect(s.tx.data.startsWith(SEL.submit)).toBe(true);
    const decoded = decodeFunctionData({ abi: STETH_ABI, data: s.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("submit");
    expect(decoded.args?.[0]).toBe("0x0000000000000000000000000000000000000000");
  });

  it("receive:'wstETH' is a plain ETH transfer to the wstETH contract", async () => {
    setRpcForTests(
      fakeClient({ balances: { [USER]: parseEther("2") }, reads: { getCurrentStakeLimit: parseEther("150000") } }),
    );
    const r = await builds.stake({ user: USER, amount: "1", receive: "wstETH" });
    const [s] = steps(r);
    expect(s.tx.to).toBe(WSTETH);
    expect(s.tx.data).toBe("0x");
    expect(s.tx.value).toBe(parseEther("1").toString());
  });

  it("refuses when the wallet can't cover the amount", async () => {
    setRpcForTests(
      fakeClient({ balances: { [USER]: parseEther("0.1") }, reads: { getCurrentStakeLimit: parseEther("150000") } }),
    );
    const r = await builds.stake({ user: USER, amount: "1" });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Insufficient ETH");
  });

  it("refuses when the amount exceeds the live stake limit", async () => {
    setRpcForTests(
      fakeClient({ balances: { [USER]: parseEther("200000") }, reads: { getCurrentStakeLimit: parseEther("150000") } }),
    );
    const r = await builds.stake({ user: USER, amount: "160000" });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("stake-rate limit");
  });

  it("refuses malformed amounts without touching the chain", async () => {
    setRpcForTests(fakeClient({ reads: {} })); // any read would throw
    for (const bad of ["", "-1", "1e18", "0", "abc"]) {
      const r = await builds.stake({ user: USER, amount: bad });
      expect(r.ok).toBe(false);
    }
  });
});

describe("build_wrap", () => {
  it("includes an EXACT approve step when allowance is short, then wrap", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          balanceOf: parseEther("10"),
          allowance: 0n,
        },
      }),
    );
    const r = await builds.wrap({ user: USER, amount: "3" });
    const list = steps(r);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("approve");
    expect(list[0].tx.to).toBe(STETH);
    const approve = decodeFunctionData({ abi: STETH_ABI, data: list[0].tx.data as `0x${string}` });
    expect(approve.functionName).toBe("approve");
    expect(approve.args?.[0]).toBe(WSTETH);
    expect(approve.args?.[1]).toBe(parseEther("3"));
    expect(list[1].tx.to).toBe(WSTETH);
    const wrap = decodeFunctionData({ abi: WSTETH_ABI, data: list[1].tx.data as `0x${string}` });
    expect(wrap.functionName).toBe("wrap");
    expect(wrap.args?.[0]).toBe(parseEther("3"));
  });

  it("skips the approve step when allowance already covers the amount", async () => {
    setRpcForTests(fakeClient({ reads: { balanceOf: parseEther("10"), allowance: parseEther("5") } }));
    const r = await builds.wrap({ user: USER, amount: "3" });
    const list = steps(r);
    expect(list).toHaveLength(1);
    expect(list[0].tx.data.startsWith(SEL.wrap)).toBe(true);
  });

  it("max:true wraps the full live balance", async () => {
    setRpcForTests(fakeClient({ reads: { balanceOf: parseEther("7"), allowance: parseEther("100") } }));
    const r = await builds.wrap({ user: USER, max: true });
    const wrap = decodeFunctionData({ abi: WSTETH_ABI, data: steps(r)[0].tx.data as `0x${string}` });
    expect(wrap.args?.[0]).toBe(parseEther("7"));
  });

  it("refuses over-balance and empty-balance max", async () => {
    setRpcForTests(fakeClient({ reads: { balanceOf: parseEther("1"), allowance: 0n } }));
    expect((await builds.wrap({ user: USER, amount: "2" })).ok).toBe(false);
    setRpcForTests(fakeClient({ reads: { balanceOf: 0n, allowance: 0n } }));
    expect((await builds.wrap({ user: USER, max: true })).ok).toBe(false);
  });
});

describe("build_unwrap", () => {
  it("builds unwrap() with the exact wstETH amount, no approve step", async () => {
    setRpcForTests(fakeClient({ reads: { balanceOf: parseEther("4") } }));
    const r = await builds.unwrap({ user: USER, amount: "2.5" });
    const list = steps(r);
    expect(list).toHaveLength(1);
    expect(list[0].tx.to).toBe(WSTETH);
    expect(list[0].tx.data.startsWith(SEL.unwrap)).toBe(true);
    const d = decodeFunctionData({ abi: WSTETH_ABI, data: list[0].tx.data as `0x${string}` });
    expect(d.args?.[0]).toBe(parseEther("2.5"));
  });
});

describe("build_request_withdrawal", () => {
  const baseReads = {
    balanceOf: parseEther("5"),
    allowance: 0n,
    stEthPerToken: parseEther("1.24"),
  };

  it("approve (to the queue) + requestWithdrawals with owner = user", async () => {
    setRpcForTests(fakeClient({ reads: baseReads }));
    const r = await builds.requestWithdrawal({ user: USER, amount: "5" });
    const list = steps(r);
    expect(list).toHaveLength(2);
    const approve = decodeFunctionData({ abi: STETH_ABI, data: list[0].tx.data as `0x${string}` });
    expect(approve.args?.[0]).toBe(WITHDRAWAL_QUEUE);
    expect(list[1].tx.to).toBe(WITHDRAWAL_QUEUE);
    expect(list[1].tx.data.startsWith(SEL.requestWithdrawals)).toBe(true);
    const req = decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: list[1].tx.data as `0x${string}` });
    expect(req.functionName).toBe("requestWithdrawals");
    expect(req.args?.[0]).toEqual([parseEther("5")]);
    expect(req.args?.[1]).toBe(USER); // ETH can only land with the user
  });

  it("splits an over-cap amount into ≤1000-stETH chunks in ONE transaction", async () => {
    setRpcForTests(fakeClient({ reads: { ...baseReads, balanceOf: parseEther("2500") } }));
    const r = await builds.requestWithdrawal({ user: USER, amount: "2500" });
    const req = decodeFunctionData({
      abi: WITHDRAWAL_QUEUE_ABI,
      data: steps(r).at(-1)!.tx.data as `0x${string}`,
    });
    expect(req.args?.[0]).toEqual([parseEther("1000"), parseEther("1000"), parseEther("500")]);
  });

  it("token:'wstETH' uses requestWithdrawalsWstETH and chunks by stETH value", async () => {
    // 1.24 rate → per-request wstETH cap = 1000/1.24 ≈ 806.45
    setRpcForTests(fakeClient({ reads: { ...baseReads, balanceOf: parseEther("1000") } }));
    const r = await builds.requestWithdrawal({ user: USER, amount: "1000", token: "wstETH" });
    const last = steps(r).at(-1)!;
    expect(last.tx.data.startsWith(SEL.requestWithdrawalsWstETH)).toBe(true);
    const req = decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: last.tx.data as `0x${string}` });
    const chunks = req.args?.[0] as bigint[];
    expect(chunks.length).toBe(2);
    expect(chunks.reduce((s, c) => s + c, 0n)).toBe(parseEther("1000"));
    // every chunk's stETH value must respect the queue cap
    for (const c of chunks) expect((c * parseEther("1.24")) / 10n ** 18n <= parseEther("1000")).toBe(true);
  });

  it("refuses dust below the queue minimum and over-balance amounts", async () => {
    setRpcForTests(fakeClient({ reads: baseReads }));
    expect((await builds.requestWithdrawal({ user: USER, amount: "0.00000000000000005" })).ok).toBe(false);
    expect((await builds.requestWithdrawal({ user: USER, amount: "6" })).ok).toBe(false);
  });
});

describe("build_claim", () => {
  it("claims exactly the finalized-unclaimed ids with checkpoint hints", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          getWithdrawalRequests: [303n, 101n, 202n],
          // sorted → [101, 202, 303]: claimed / claimable / pending
          getWithdrawalStatus: [
            wqStatus({ amountOfStETH: parseEther("1"), isFinalized: true, isClaimed: true }),
            wqStatus({ amountOfStETH: parseEther("2"), isFinalized: true, isClaimed: false }),
            wqStatus({ amountOfStETH: parseEther("3"), isFinalized: false, isClaimed: false }),
          ],
          getLastCheckpointIndex: 42n,
          findCheckpointHints: (call: { args?: readonly unknown[] }) => {
            expect(call.args?.[0]).toEqual([202n]); // only the claimable id
            expect(call.args?.[1]).toBe(1n);
            expect(call.args?.[2]).toBe(42n);
            return [7n];
          },
          getClaimableEther: [parseEther("1.99")],
        },
      }),
    );
    const r = await builds.claim({ user: USER });
    expect(r.ok).toBe(true);
    const [s] = steps(r);
    expect(s.tx.to).toBe(WITHDRAWAL_QUEUE);
    expect(s.tx.data.startsWith(SEL.claimWithdrawals)).toBe(true);
    const d = decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: s.tx.data as `0x${string}` });
    expect(d.args?.[0]).toEqual([202n]);
    expect(d.args?.[1]).toEqual([7n]);
    expect((r.data as { claimableEth: string }).claimableEth).toBe("1.99");
  });

  it("is honest when nothing is claimable yet (pending only)", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          getWithdrawalRequests: [500n],
          getWithdrawalStatus: [wqStatus({ amountOfStETH: parseEther("1"), isFinalized: false, isClaimed: false })],
        },
      }),
    );
    const r = await builds.claim({ user: USER });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("pending finalization");
  });

  it("is honest when the address holds no requests at all", async () => {
    setRpcForTests(fakeClient({ reads: { getWithdrawalRequests: [] } }));
    const r = await builds.claim({ user: USER });
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("nothing to claim");
  });
});
