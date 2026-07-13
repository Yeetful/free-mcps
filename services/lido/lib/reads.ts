// Read-only views composed from on-chain state (public RPC, multicall-
// batched) + Lido's public APIs. Everything here is presentation-shaped for
// the planner: decimal strings in HUMAN units, USD where available (fail-
// soft — a dead price API never breaks a position read).
import { formatEther, parseEther } from "viem";
import {
  CHAIN_ID,
  STETH,
  STETH_ABI,
  WSTETH,
  WSTETH_ABI,
  WITHDRAWAL_QUEUE,
  WITHDRAWAL_QUEUE_ABI,
  readRetry,
  rpc,
} from "./chain";
import { fetchApr, fetchQueueWait, fetchRewards, fetchStEthUsd, type AprInfo, type LidoOpts, type LidoResult } from "./lido-api";

/** Round a decimal-ETH string for display without losing small balances. */
const round = (s: string, dp = 6): string => {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n !== 0 && Math.abs(n) < 10 ** -dp) return s; // tiny → keep full precision
  return String(Number(n.toFixed(dp)));
};

const usd = (ethAmount: string, price: number | null): number | null =>
  price != null ? Number((Number(ethAmount) * price).toFixed(2)) : null;

interface WithdrawalRequestView {
  requestId: string;
  stEth: string;
  requestedAt: string;
  status: "pending" | "claimable" | "claimed";
  claimableEth?: string;
}

/** Statuses + claimable ETH for an address's withdrawal-request NFTs. */
async function readWithdrawalRequests(user: `0x${string}`): Promise<WithdrawalRequestView[]> {
  const client = rpc();
  const ids = await readRetry(() =>
    client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getWithdrawalRequests", args: [user] }),
  );
  if (ids.length === 0) return [];
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : 1));
  const statuses = await readRetry(() =>
    client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getWithdrawalStatus", args: [sorted] }),
  );

  const views: WithdrawalRequestView[] = sorted.map((id, i) => ({
    requestId: id.toString(),
    stEth: round(formatEther(statuses[i].amountOfStETH)),
    requestedAt: new Date(Number(statuses[i].timestamp) * 1000).toISOString(),
    status: statuses[i].isClaimed ? "claimed" : statuses[i].isFinalized ? "claimable" : "pending",
  }));

  // Claimable ETH per finalized-unclaimed request (needs checkpoint hints).
  const claimable = views.filter((v) => v.status === "claimable");
  if (claimable.length > 0) {
    const claimIds = claimable.map((v) => BigInt(v.requestId));
    const lastCheckpoint = await readRetry(() =>
      client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastCheckpointIndex" }),
    );
    const hints = await readRetry(() =>
      client.readContract({
        address: WITHDRAWAL_QUEUE,
        abi: WITHDRAWAL_QUEUE_ABI,
        functionName: "findCheckpointHints",
        args: [claimIds, 1n, lastCheckpoint],
      }),
    );
    const amounts = await readRetry(() =>
      client.readContract({
        address: WITHDRAWAL_QUEUE,
        abi: WITHDRAWAL_QUEUE_ABI,
        functionName: "getClaimableEther",
        args: [claimIds, hints as bigint[]],
      }),
    );
    claimable.forEach((v, i) => {
      v.claimableEth = round(formatEther(amounts[i]));
    });
  }
  return views;
}

export const reads = {
  /** Protocol snapshot: APR, totals, rate, stake limit, queue state. */
  async stats(opts?: LidoOpts): Promise<LidoResult> {
    const client = rpc();
    try {
      const [pooled, shares, stakeLimit, perToken, lastReq, lastFin, unfinalized, aprRes, price] = await Promise.all([
        readRetry(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "getTotalPooledEther" })),
        readRetry(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "getTotalShares" })),
        readRetry(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "getCurrentStakeLimit" })),
        readRetry(() => client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "stEthPerToken" })),
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastRequestId" })),
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastFinalizedRequestId" })),
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "unfinalizedStETH" })),
        fetchApr(opts),
        fetchStEthUsd(opts),
      ]);
      const apr = aprRes.ok ? (aprRes.data as AprInfo) : null;
      return {
        ok: true,
        status: 200,
        data: {
          chain: "Ethereum mainnet",
          apr: apr ?? { note: "APR API unavailable right now" },
          totalStakedEth: round(formatEther(pooled), 0),
          totalStEthShares: round(formatEther(shares), 0),
          stEthPerWstEth: round(formatEther(perToken), 6),
          currentStakeLimitEth: round(formatEther(stakeLimit), 0),
          stEthUsdPrice: price,
          withdrawalQueue: {
            lastRequestId: lastReq.toString(),
            lastFinalizedRequestId: lastFin.toString(),
            pendingRequests: (lastReq - lastFin).toString(),
            unfinalizedStEth: round(formatEther(unfinalized), 2),
          },
          note: "APR is variable and accrues via daily stETH rebases. wstETH does not rebase — its stETH value grows through stEthPerWstEth instead.",
        },
      };
    } catch (e) {
      return { ok: false, status: 502, data: `RPC read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  /** Full Lido position for one address. */
  async position(user: `0x${string}`, opts?: LidoOpts): Promise<LidoResult> {
    const client = rpc();
    try {
      const [ethWei, stEthWei, sharesWei, wstEthWei, perToken, price, aprRes] = await Promise.all([
        readRetry(() => client.getBalance({ address: user })),
        readRetry(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "balanceOf", args: [user] })),
        readRetry(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "sharesOf", args: [user] })),
        readRetry(() => client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "balanceOf", args: [user] })),
        readRetry(() => client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "stEthPerToken" })),
        fetchStEthUsd(opts),
        fetchApr(opts),
      ]);
      const wstAsStEthWei = (wstEthWei * perToken) / 10n ** 18n;
      const requests = await readWithdrawalRequests(user);
      const pending = requests.filter((r) => r.status === "pending");
      const claimable = requests.filter((r) => r.status === "claimable");

      const stEth = formatEther(stEthWei);
      const wstAsStEth = formatEther(wstAsStEthWei);
      const totalStaked = formatEther(stEthWei + wstAsStEthWei);
      const apr = aprRes.ok ? (aprRes.data as AprInfo) : null;

      const hasPosition = stEthWei > 0n || wstEthWei > 0n || requests.length > 0;
      return {
        ok: true,
        status: 200,
        data: {
          address: user,
          hasPosition,
          eth: { balance: round(formatEther(ethWei)), usd: usd(formatEther(ethWei), price) },
          stEth: { balance: round(stEth), shares: round(formatEther(sharesWei)), usd: usd(stEth, price) },
          wstEth: {
            balance: round(formatEther(wstEthWei)),
            asStEth: round(wstAsStEth),
            usd: usd(wstAsStEth, price),
          },
          totalStaked: { stEth: round(totalStaked), usd: usd(totalStaked, price) },
          currentAprPct: apr?.smaAprPct ?? null,
          withdrawals: {
            pendingRequests: pending.length,
            pendingStEth: round(String(pending.reduce((s, r) => s + Number(r.stEth), 0))),
            claimableRequests: claimable.length,
            claimableEth: round(String(claimable.reduce((s, r) => s + Number(r.claimableEth ?? 0), 0))),
          },
          ...(hasPosition
            ? { next: "For what this position has EARNED, call `earnings`. For per-request withdrawal detail, call `withdrawals`." }
            : { note: "No Lido position — nothing staked, nothing queued. `build_stake` prepares a stake; `stats` shows the current APR." }),
        },
      };
    } catch (e) {
      return { ok: false, status: 502, data: `RPC read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  /** Earnings view — Lido's reward-history backend, plus live-position framing. */
  async earnings(args: { user: string; limit?: number }, opts?: LidoOpts): Promise<LidoResult> {
    const r = await fetchRewards({ address: args.user, limit: args.limit, onlyRewards: true }, opts);
    if (!r.ok) return r;
    const d = r.data as import("./lido-api").RewardHistory;
    if (d.totalEvents === 0) {
      return {
        ok: true,
        status: 200,
        data: {
          address: args.user,
          totalRewards: { stEth: "0", usd: 0 },
          note: "No staking rewards recorded for this address — it has never held stETH through a rebase. wstETH earnings accrue in the stETH/wstETH rate instead of rebases; `position` shows the current value.",
        },
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        address: args.user,
        totalRewards: { stEth: round(d.totalRewardsStEth, 8), usd: d.totalRewardsUsd },
        averageAprPct: d.averageAprPct,
        stEthUsdPrice: d.stEthUsdPrice,
        rewardEvents: d.totalEvents,
        recentRewards: d.events.map((e) => ({
          date: e.date,
          rewardStEth: round(e.rewardStEth, 10),
          balanceStEth: round(e.balanceStEth, 8),
          aprPct: e.aprPct,
        })),
        note: "Rewards arrive as daily stETH rebases (balance grows in place). Totals cover this address's full stETH history. wstETH earnings show up in the stETH/wstETH rate, not here.",
      },
    };
  },

  /** Withdrawal requests + queue context for one address. */
  async withdrawals(user: `0x${string}`, opts?: LidoOpts): Promise<LidoResult> {
    const client = rpc();
    try {
      const requests = await readWithdrawalRequests(user);
      const [lastReq, lastFin, unfinalized] = await Promise.all([
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastRequestId" })),
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastFinalizedRequestId" })),
        readRetry(() => client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "unfinalizedStETH" })),
      ]);

      const pending = requests.filter((r) => r.status === "pending");
      let waitEstimate: unknown = null;
      if (pending.length > 0) {
        const totalPending = pending.reduce((s, r) => s + Number(r.stEth), 0);
        const w = await fetchQueueWait(String(totalPending || 1), opts);
        if (w.ok) waitEstimate = w.data;
      }

      const claimable = requests.filter((r) => r.status === "claimable");
      return {
        ok: true,
        status: 200,
        data: {
          address: user,
          requests,
          summary: {
            pending: pending.length,
            claimable: claimable.length,
            claimableEth: round(String(claimable.reduce((s, r) => s + Number(r.claimableEth ?? 0), 0))),
            claimed: requests.filter((r) => r.status === "claimed").length,
          },
          ...(waitEstimate ? { pendingWaitEstimate: waitEstimate } : {}),
          queue: {
            lastRequestId: lastReq.toString(),
            lastFinalizedRequestId: lastFin.toString(),
            unfinalizedStEth: round(formatEther(unfinalized), 2),
          },
          ...(claimable.length > 0
            ? { next: "Claimable requests exist — `build_claim` prepares the claim transaction that sends the ETH to the owner's wallet." }
            : requests.length === 0
              ? { note: "No withdrawal requests for this address. `build_request_withdrawal` starts an exit; swapping stETH on a DEX is the instant (but market-priced) alternative." }
              : {}),
        },
      };
    } catch (e) {
      return { ok: false, status: 502, data: `RPC read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },

  /** Convert an amount between ETH / stETH / wstETH at the live rate. */
  async convert(args: { amount: string; from: "ETH" | "stETH" | "wstETH"; to: "ETH" | "stETH" | "wstETH" }): Promise<LidoResult> {
    if (args.from === args.to) {
      return { ok: true, status: 200, data: { amount: args.amount, from: args.from, to: args.to, result: args.amount } };
    }
    const client = rpc();
    try {
      const wei = parseEther(args.amount);
      const perToken = await readRetry(() =>
        client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "stEthPerToken" }),
      );
      // ETH ↔ stETH is 1:1 at the protocol (stake mints 1:1; withdrawals
      // redeem 1:1 after the queue). Only the wstETH leg needs the rate.
      const toWst = (stEthWei: bigint) => (stEthWei * 10n ** 18n) / perToken;
      const fromWst = (wstWei: bigint) => (wstWei * perToken) / 10n ** 18n;
      const resultWei = args.to === "wstETH" ? toWst(wei) : args.from === "wstETH" ? fromWst(wei) : wei;
      return {
        ok: true,
        status: 200,
        data: {
          amount: args.amount,
          from: args.from,
          to: args.to,
          result: round(formatEther(resultWei), 8),
          stEthPerWstEth: round(formatEther(perToken), 6),
          note: "Protocol rates: ETH↔stETH is 1:1 (market price on DEXes can differ slightly); stETH↔wstETH uses the live on-chain rate.",
        },
      };
    } catch (e) {
      return { ok: false, status: 502, data: `RPC read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
