// Construction-only transaction building against the official Lido
// contracts. Calldata is encoded locally with viem from the pinned ABIs in
// chain.ts and validated against the sender's REAL on-chain balances and
// allowances before anything is returned; each flow comes back as ordered
// `send_transaction` steps — the same {action:'send_transaction', tx:{…}}
// contract the uniswap/aave siblings use, so the chat renders approve→act
// chains as sign buttons. Nothing here ever signs or submits.
import { encodeFunctionData, formatEther, parseEther } from "viem";
import {
  CHAIN_ID,
  MAX_WITHDRAWAL_WEI,
  MIN_WITHDRAWAL_WEI,
  STETH,
  STETH_ABI,
  WSTETH,
  WSTETH_ABI,
  WITHDRAWAL_QUEUE,
  WITHDRAWAL_QUEUE_ABI,
  readRetry,
  rpc,
} from "./chain";
import type { LidoResult } from "./lido-api";

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: string; data: string; value: string; chainId: number };
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const step = (label: string, summary: string, tx: { to: string; data?: string; value?: bigint }): SendTransactionAction => ({
  action: "send_transaction",
  label,
  summary,
  tx: { to: tx.to, data: tx.data ?? "0x", value: (tx.value ?? 0n).toString(), chainId: CHAIN_ID },
});

const submitWith = (after: string) =>
  `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. After the final step confirms, ${after}`;

const fail = (status: number, message: string): LidoResult => ({ ok: false, status, data: message });

const fmt = (wei: bigint): string => {
  const n = Number(formatEther(wei));
  return n !== 0 && Math.abs(n) < 1e-6 ? formatEther(wei) : String(Number(n.toFixed(6)));
};

function parseAmount(amount: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  try {
    const wei = parseEther(amount);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

async function rpcGuard<T>(fn: () => Promise<T>): Promise<T> {
  return readRetry(fn);
}

export const builds = {
  /**
   * Stake ETH. receive:'stETH' → stETH.submit(); receive:'wstETH' → a plain
   * ETH transfer to the wstETH contract (its receive() stakes AND wraps in
   * one transaction — official Lido behavior).
   */
  async stake(args: { user: `0x${string}`; amount: string; receive?: "stETH" | "wstETH" }): Promise<LidoResult> {
    const wei = parseAmount(args.amount);
    if (!wei) return fail(400, `Invalid amount "${args.amount}" — pass a positive decimal ETH amount like "0.5".`);
    const receive = args.receive ?? "stETH";
    const client = rpc();
    try {
      const [balance, stakeLimit] = await Promise.all([
        rpcGuard(() => client.getBalance({ address: args.user })),
        rpcGuard(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "getCurrentStakeLimit" })),
      ]);
      if (wei > balance) {
        return fail(400, `Insufficient ETH: staking ${args.amount} ETH but the wallet holds ${fmt(balance)} ETH. Nothing was built.`);
      }
      if (wei > stakeLimit) {
        return fail(400, `Amount exceeds Lido's current stake-rate limit (${fmt(stakeLimit)} ETH right now — it refills continuously). Stake less or retry later.`);
      }
      const gasWarning =
        balance - wei < parseEther("0.002")
          ? " ⚠️ This leaves almost no ETH for gas — consider staking slightly less."
          : "";

      const s =
        receive === "wstETH"
          ? step(
              "stake",
              `Stake ${args.amount} ETH with Lido and receive wstETH (staked + wrapped in one transaction).${gasWarning}`,
              { to: WSTETH, value: wei },
            )
          : step(
              "stake",
              `Stake ${args.amount} ETH with Lido and receive stETH 1:1 — starts earning staking rewards via daily rebases.${gasWarning}`,
              { to: STETH, data: encodeFunctionData({ abi: STETH_ABI, functionName: "submit", args: [ZERO] }), value: wei },
            );
      return {
        ok: true,
        status: 200,
        data: {
          operation: "stake",
          amountEth: args.amount,
          receive,
          steps: [s],
          submit_with: submitWith("re-read `position` — the new balance appears immediately."),
          note: "Staking via Lido is one-way at the protocol: exiting goes through the withdrawal queue (build_request_withdrawal, hours-to-days) or an instant DEX swap at market price.",
        },
      };
    } catch (e) {
      return fail(502, `RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Wrap stETH into wstETH (approve step included when allowance is short). */
  async wrap(args: { user: `0x${string}`; amount?: string; max?: boolean }): Promise<LidoResult> {
    const client = rpc();
    try {
      const [balance, allowance] = await Promise.all([
        rpcGuard(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "balanceOf", args: [args.user] })),
        rpcGuard(() => client.readContract({ address: STETH, abi: STETH_ABI, functionName: "allowance", args: [args.user, WSTETH] })),
      ]);
      const wei = args.max ? balance : parseAmount(args.amount ?? "");
      if (!wei || wei <= 0n) {
        return args.max
          ? fail(400, "The wallet holds no stETH to wrap. `build_stake` (receive wstETH) stakes ETH straight into wstETH.")
          : fail(400, `Invalid amount "${args.amount ?? ""}" — pass a positive decimal stETH amount, or max:true.`);
      }
      if (wei > balance) {
        return fail(400, `Insufficient stETH: wrapping ${fmt(wei)} but the wallet holds ${fmt(balance)}. Nothing was built.`);
      }
      const steps: SendTransactionAction[] = [];
      if (allowance < wei) {
        steps.push(
          step("approve", `Approve ${fmt(wei)} stETH for the wstETH contract`, {
            to: STETH,
            data: encodeFunctionData({ abi: STETH_ABI, functionName: "approve", args: [WSTETH, wei] }),
          }),
        );
      }
      steps.push(
        step("wrap", `Wrap ${fmt(wei)} stETH into wstETH (non-rebasing — value accrues in the rate instead)`, {
          to: WSTETH,
          data: encodeFunctionData({ abi: WSTETH_ABI, functionName: "wrap", args: [wei] }),
        }),
      );
      return {
        ok: true,
        status: 200,
        data: {
          operation: "wrap",
          amountStEth: fmt(wei),
          steps,
          submit_with: submitWith("re-read `position` for the new wstETH balance."),
        },
      };
    } catch (e) {
      return fail(502, `RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Unwrap wstETH back to stETH (no approval — burns the caller's own). */
  async unwrap(args: { user: `0x${string}`; amount?: string; max?: boolean }): Promise<LidoResult> {
    const client = rpc();
    try {
      const balance = await rpcGuard(() =>
        client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "balanceOf", args: [args.user] }),
      );
      const wei = args.max ? balance : parseAmount(args.amount ?? "");
      if (!wei || wei <= 0n) {
        return args.max
          ? fail(400, "The wallet holds no wstETH to unwrap.")
          : fail(400, `Invalid amount "${args.amount ?? ""}" — pass a positive decimal wstETH amount, or max:true.`);
      }
      if (wei > balance) {
        return fail(400, `Insufficient wstETH: unwrapping ${fmt(wei)} but the wallet holds ${fmt(balance)}. Nothing was built.`);
      }
      return {
        ok: true,
        status: 200,
        data: {
          operation: "unwrap",
          amountWstEth: fmt(wei),
          steps: [
            step("unwrap", `Unwrap ${fmt(wei)} wstETH back into rebasing stETH`, {
              to: WSTETH,
              data: encodeFunctionData({ abi: WSTETH_ABI, functionName: "unwrap", args: [wei] }),
            }),
          ],
          submit_with: submitWith("re-read `position` for the new stETH balance."),
        },
      };
    } catch (e) {
      return fail(502, `RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /**
   * Request a withdrawal: stETH (or wstETH) → claimable NFT(s). Amounts over
   * the queue's 1000-stETH per-request cap are split into multiple requests
   * inside ONE transaction.
   */
  async requestWithdrawal(args: {
    user: `0x${string}`;
    amount?: string;
    max?: boolean;
    token?: "stETH" | "wstETH";
  }): Promise<LidoResult> {
    const token = args.token ?? "stETH";
    const tokenAddr = token === "stETH" ? STETH : WSTETH;
    const tokenAbi = token === "stETH" ? STETH_ABI : WSTETH_ABI;
    const client = rpc();
    try {
      const [balance, allowance, perToken] = await Promise.all([
        rpcGuard(() => client.readContract({ address: tokenAddr, abi: tokenAbi, functionName: "balanceOf", args: [args.user] })),
        rpcGuard(() => client.readContract({ address: tokenAddr, abi: tokenAbi, functionName: "allowance", args: [args.user, WITHDRAWAL_QUEUE] })),
        rpcGuard(() => client.readContract({ address: WSTETH, abi: WSTETH_ABI, functionName: "stEthPerToken" })),
      ]);
      const wei = args.max ? balance : parseAmount(args.amount ?? "");
      if (!wei || wei <= 0n) {
        return args.max
          ? fail(400, `The wallet holds no ${token} to withdraw.`)
          : fail(400, `Invalid amount "${args.amount ?? ""}" — pass a positive decimal ${token} amount, or max:true.`);
      }
      if (wei > balance) {
        return fail(400, `Insufficient ${token}: requesting ${fmt(wei)} but the wallet holds ${fmt(balance)}. Nothing was built.`);
      }

      // The queue's MIN/MAX are stETH-denominated; for wstETH requests the
      // cap applies to the unwrapped stETH value, so chunk in stETH terms.
      const stEthValue = token === "stETH" ? wei : (wei * perToken) / 10n ** 18n;
      if (stEthValue < MIN_WITHDRAWAL_WEI) {
        return fail(400, `Amount is below the queue's minimum (${MIN_WITHDRAWAL_WEI} wei of stETH).`);
      }
      const maxPerRequest = token === "stETH" ? MAX_WITHDRAWAL_WEI : (MAX_WITHDRAWAL_WEI * 10n ** 18n) / perToken;
      const chunks: bigint[] = [];
      let remaining = wei;
      while (remaining > 0n) {
        const c = remaining > maxPerRequest ? maxPerRequest : remaining;
        chunks.push(c);
        remaining -= c;
      }
      if (chunks.length > 20) {
        return fail(400, `That would create ${chunks.length} withdrawal requests in one transaction — split the exit into smaller batches (≤ ${fmt(maxPerRequest * 20n)} ${token} per call).`);
      }

      const steps: SendTransactionAction[] = [];
      if (allowance < wei) {
        steps.push(
          step("approve", `Approve ${fmt(wei)} ${token} for Lido's withdrawal queue`, {
            to: tokenAddr,
            data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [WITHDRAWAL_QUEUE, wei] }),
          }),
        );
      }
      steps.push(
        step(
          "request_withdrawal",
          `Request withdrawal of ${fmt(wei)} ${token} (${chunks.length} request${chunks.length > 1 ? "s" : ""}) — you receive claimable NFT(s); the ETH unlocks after queue finalization`,
          {
            to: WITHDRAWAL_QUEUE,
            data: encodeFunctionData({
              abi: WITHDRAWAL_QUEUE_ABI,
              functionName: token === "stETH" ? "requestWithdrawals" : "requestWithdrawalsWstETH",
              args: [chunks, args.user],
            }),
          },
        ),
      );
      return {
        ok: true,
        status: 200,
        data: {
          operation: "request_withdrawal",
          token,
          amount: fmt(wei),
          requests: chunks.map(fmt),
          steps,
          submit_with: submitWith("track the request with `withdrawals` — when it shows claimable, `build_claim` finishes the exit."),
          note: "Withdrawals are NOT instant: the queue finalizes in hours to days (`withdrawals` shows the current estimate). The rebasing stops for the queued amount at request time.",
        },
      };
    } catch (e) {
      return fail(502, `RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Claim every finalized, unclaimed withdrawal request the address holds. */
  async claim(args: { user: `0x${string}` }): Promise<LidoResult> {
    const client = rpc();
    try {
      const ids = await rpcGuard(() =>
        client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getWithdrawalRequests", args: [args.user] }),
      );
      if (ids.length === 0) {
        return fail(404, "This address holds no withdrawal requests — nothing to claim. `build_request_withdrawal` starts an exit.");
      }
      const sorted = [...ids].sort((a, b) => (a < b ? -1 : 1));
      const statuses = await rpcGuard(() =>
        client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getWithdrawalStatus", args: [sorted] }),
      );
      const claimIds = sorted.filter((_, i) => statuses[i].isFinalized && !statuses[i].isClaimed);
      if (claimIds.length === 0) {
        const pending = sorted.filter((_, i) => !statuses[i].isFinalized);
        return fail(
          404,
          pending.length > 0
            ? `Nothing claimable yet — ${pending.length} request${pending.length > 1 ? "s are" : " is"} still pending finalization. \`withdrawals\` shows the wait estimate.`
            : "Every withdrawal request here is already claimed.",
        );
      }
      const lastCheckpoint = await rpcGuard(() =>
        client.readContract({ address: WITHDRAWAL_QUEUE, abi: WITHDRAWAL_QUEUE_ABI, functionName: "getLastCheckpointIndex" }),
      );
      const hints = (await rpcGuard(() =>
        client.readContract({
          address: WITHDRAWAL_QUEUE,
          abi: WITHDRAWAL_QUEUE_ABI,
          functionName: "findCheckpointHints",
          args: [claimIds, 1n, lastCheckpoint],
        }),
      )) as bigint[];
      const amounts = await rpcGuard(() =>
        client.readContract({
          address: WITHDRAWAL_QUEUE,
          abi: WITHDRAWAL_QUEUE_ABI,
          functionName: "getClaimableEther",
          args: [claimIds, hints],
        }),
      );
      const totalEth = amounts.reduce((s, a) => s + a, 0n);
      return {
        ok: true,
        status: 200,
        data: {
          operation: "claim",
          requestIds: claimIds.map(String),
          claimableEth: fmt(totalEth),
          steps: [
            step(
              "claim",
              `Claim ${claimIds.length} finalized withdrawal request${claimIds.length > 1 ? "s" : ""} — ${fmt(totalEth)} ETH lands in the wallet`,
              {
                to: WITHDRAWAL_QUEUE,
                data: encodeFunctionData({
                  abi: WITHDRAWAL_QUEUE_ABI,
                  functionName: "claimWithdrawals",
                  args: [claimIds, hints],
                }),
              },
            ),
          ],
          submit_with: submitWith("re-read `position` — the ETH balance reflects the claim immediately."),
        },
      };
    } catch (e) {
      return fail(502, `RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
