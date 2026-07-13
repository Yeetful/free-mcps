import { afterEach, describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { setRpcForTests } from "@/lib/chain";
import { reads } from "@/lib/reads";
import { fakeClient, wqStatus } from "./fake-rpc";

const USER = "0x1111111111111111111111111111111111111111" as const;

afterEach(() => setRpcForTests(null));

// APIs are down in these tests (fetch fails) — reads must fail SOFT on price
// and APR while the on-chain truth still comes through.
const deadFetch: typeof fetch = (async () => {
  throw new Error("offline");
}) as typeof fetch;

describe("position", () => {
  it("composes balances + wstETH-as-stETH + withdrawal summary; price fails soft", async () => {
    setRpcForTests(
      fakeClient({
        balances: { [USER]: parseEther("1.5") },
        reads: {
          balanceOf: (c: { address: string }) =>
            c.address === "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" ? parseEther("10") : parseEther("2"),
          sharesOf: parseEther("9.5"),
          stEthPerToken: parseEther("1.25"),
          getWithdrawalRequests: [900n],
          getWithdrawalStatus: [wqStatus({ amountOfStETH: parseEther("3"), isFinalized: false, isClaimed: false })],
        },
      }),
    );
    const r = await reads.position(USER, { fetchImpl: deadFetch });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, any>;
    expect(d.hasPosition).toBe(true);
    expect(d.eth.balance).toBe("1.5");
    expect(d.eth.usd).toBeNull(); // price API down → fail-soft, not fail
    expect(d.stEth.balance).toBe("10");
    expect(d.wstEth.balance).toBe("2");
    expect(d.wstEth.asStEth).toBe("2.5"); // 2 × 1.25
    expect(d.totalStaked.stEth).toBe("12.5");
    expect(d.withdrawals.pendingRequests).toBe(1);
    expect(d.withdrawals.pendingStEth).toBe("3");
  });

  it("flags an empty position honestly", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          balanceOf: 0n,
          sharesOf: 0n,
          stEthPerToken: parseEther("1.25"),
          getWithdrawalRequests: [],
        },
      }),
    );
    const r = await reads.position(USER, { fetchImpl: deadFetch });
    const d = r.data as Record<string, any>;
    expect(d.hasPosition).toBe(false);
    expect(d.note).toContain("No Lido position");
  });
});

describe("withdrawals", () => {
  it("labels pending/claimable/claimed and sums claimable ETH", async () => {
    setRpcForTests(
      fakeClient({
        reads: {
          getWithdrawalRequests: [11n, 12n, 13n],
          getWithdrawalStatus: [
            wqStatus({ amountOfStETH: parseEther("1"), isFinalized: true, isClaimed: true }),
            wqStatus({ amountOfStETH: parseEther("2"), isFinalized: true, isClaimed: false }),
            wqStatus({ amountOfStETH: parseEther("4"), isFinalized: false, isClaimed: false }),
          ],
          getLastCheckpointIndex: 9n,
          findCheckpointHints: [3n],
          getClaimableEther: [parseEther("1.98")],
          getLastRequestId: 130_000n,
          getLastFinalizedRequestId: 129_900n,
          unfinalizedStETH: parseEther("9000"),
        },
      }),
    );
    const r = await reads.withdrawals(USER, { fetchImpl: deadFetch });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, any>;
    expect(d.requests.map((x: any) => x.status)).toEqual(["claimed", "claimable", "pending"]);
    expect(d.summary).toMatchObject({ pending: 1, claimable: 1, claimed: 1, claimableEth: "1.98" });
    expect(d.next).toContain("build_claim");
    expect(d.queue.unfinalizedStEth).toBe("9000");
  });
});

describe("convert", () => {
  it("converts stETH → wstETH and back at the live rate", async () => {
    setRpcForTests(fakeClient({ reads: { stEthPerToken: parseEther("1.25") } }));
    const toWst = await reads.convert({ amount: "5", from: "stETH", to: "wstETH" });
    expect((toWst.data as any).result).toBe("4"); // 5 / 1.25
    const toStEth = await reads.convert({ amount: "4", from: "wstETH", to: "stETH" });
    expect((toStEth.data as any).result).toBe("5");
    const ethLeg = await reads.convert({ amount: "2", from: "ETH", to: "stETH" });
    expect((ethLeg.data as any).result).toBe("2"); // 1:1
    const wstToEth = await reads.convert({ amount: "4", from: "wstETH", to: "ETH" });
    expect((wstToEth.data as any).result).toBe("5"); // via stETH 1:1
  });

  it("same-unit conversion is identity without touching the chain", async () => {
    setRpcForTests(fakeClient({ reads: {} }));
    const r = await reads.convert({ amount: "3", from: "ETH", to: "ETH" });
    expect((r.data as any).result).toBe("3");
  });
});
