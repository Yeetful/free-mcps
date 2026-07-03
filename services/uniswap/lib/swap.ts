// ─────────────────────────────────────────────────────────────────────────
//  Deterministic swap-transaction building. No model in the loop: a fresh
//  QuoterV2 quote sets amountOutMinimum (minus the caller's slippage bound),
//  calldata is ABI-encoded exactInputSingle wrapped in multicall(deadline,…),
//  and the recipient is ALWAYS the payer. The result is the
//  `{action:'send_transaction'}` payload Yeetful's transaction layer turns
//  into a signable evm-tx artifact — this service never holds keys, never
//  signs, never submits.
//
//  Native ETH in: SwapRouter02 wraps msg.value when tokenIn is WETH9, so an
//  ETH sell needs NO approval — the tx just carries value. ETH out (v1)
//  delivers WETH; build_unwrap turns it back into ether.
// ─────────────────────────────────────────────────────────────────────────

import { encodeFunctionData } from "viem";
import { CHAIN_ID, ERC20_ABI, SWAP_ROUTER_02, SWAP_ROUTER_02_ABI, WETH, WETH_ABI, readRetry, rpc } from "./chain";
import { bestV3Quote, presentQuote } from "./quote";
import { formatAtoms, humanToAtoms, resolveToken } from "./tokens";

export const MAX_SLIPPAGE_BPS = 500;
export const MAX_DEADLINE_SEC = 3600;

export interface BuildSwapParams {
  sellToken: string;
  buyToken: string;
  /** Human units ("100", "0.5") — converted with the token's real decimals. */
  amount: string;
  from: `0x${string}`;
  slippageBps?: number;
  deadlineSec?: number;
}

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
}

export async function buildSwap(params: BuildSwapParams) {
  const slippageBps = params.slippageBps ?? 50;
  const deadlineSec = params.deadlineSec ?? 600;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}.`);
  }
  if (!Number.isInteger(deadlineSec) || deadlineSec < 30 || deadlineSec > MAX_DEADLINE_SEC) {
    throw new Error(`deadlineSec must be between 30 and ${MAX_DEADLINE_SEC}.`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.from)) {
    throw new Error("A valid `from` wallet address is required — it becomes the swap recipient.");
  }

  const [tokenIn, tokenOut] = await Promise.all([resolveToken(params.sellToken), resolveToken(params.buyToken)]);
  if (tokenIn.address === tokenOut.address) throw new Error("sellToken and buyToken must differ.");
  const amountIn = humanToAtoms(params.amount, tokenIn.decimals);

  const quote = await bestV3Quote(tokenIn, tokenOut, amountIn);
  const minOut = (quote.best.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);

  const swapCall = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: quote.best.fee,
        recipient: params.from, // ALWAYS the payer — no third-party recipients
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const data = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "multicall",
    args: [deadline, [swapCall]],
  });

  const ethIn = tokenIn.isNativeEth === true;
  const tx = {
    to: SWAP_ROUTER_02,
    data,
    value: ethIn ? amountIn.toString() : "0",
    chainId: CHAIN_ID,
  };

  // Approval status: ETH-in needs none (router wraps msg.value); ERC-20 in
  // needs allowance to SwapRouter02. We report + build the approve tx — the
  // user signs it first if `needed`.
  let approve: { needed: boolean; allowance: string; tx?: SendTransactionAction } = {
    needed: false,
    allowance: "n/a (native ETH in)",
  };
  if (!ethIn) {
    const allowance = await readRetry(() =>
      rpc().readContract({
        address: tokenIn.address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [params.from, SWAP_ROUTER_02],
      }),
    );
    approve = {
      needed: allowance < amountIn,
      allowance: allowance.toString(),
      tx:
        allowance < amountIn
          ? {
              action: "send_transaction",
              label: "approve",
              summary: `Approve ${formatAtoms(amountIn, tokenIn.decimals)} ${tokenIn.symbol} to Uniswap SwapRouter02`,
              tx: {
                to: tokenIn.address,
                data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER_02, amountIn] }),
                value: "0",
                chainId: CHAIN_ID,
              },
            }
          : undefined,
    };
  }

  // Dry-run the exact bytes via eth_call from the payer. Advisory: a revert
  // here (no balance / no allowance yet) is information, not a refusal —
  // the caller sees ok:false + the reason and can fund/approve first.
  let simulation: { ok: boolean; error?: string };
  try {
    await readRetry(() =>
      rpc().call({ account: params.from, to: tx.to, data: tx.data as `0x${string}`, value: BigInt(tx.value) }),
    );
    simulation = { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : "simulation reverted";
    // An RPC outage is not a revert — say so instead of implying the tx is bad.
    simulation = { ok: false, error: /rate limit|429|RPC Request failed/i.test(msg) ? `RPC unavailable (not a contract revert): ${msg}` : msg };
  }

  const q = presentQuote(quote);
  const outNote = tokenOut.isNativeEth ? " (delivered as WETH — use build_unwrap for native ETH)" : "";
  const summary = `${q.summary}, min received ${formatAtoms(minOut, tokenOut.decimals)} ${tokenOut.symbol} (${slippageBps}bps slippage)${outNote}`;

  const swap: SendTransactionAction = { action: "send_transaction", label: "swap", summary, tx };
  return {
    quote: q,
    minimumOut: { atoms: minOut.toString(), amount: formatAtoms(minOut, tokenOut.decimals) },
    deadline: Number(deadline),
    approve,
    simulation,
    swap,
  };
}

/** Wrap native ETH → WETH (deposit). */
export function buildWrap(amount: string, from: string): SendTransactionAction {
  const atoms = humanToAtoms(amount, 18);
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new Error("A valid `from` wallet address is required.");
  return {
    action: "send_transaction",
    label: "wrap",
    summary: `Wrap ${formatAtoms(atoms, 18)} ETH → WETH on Base`,
    tx: { to: WETH, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: atoms.toString(), chainId: CHAIN_ID },
  };
}

/** Unwrap WETH → native ETH (withdraw). */
export function buildUnwrap(amount: string, from: string): SendTransactionAction {
  const atoms = humanToAtoms(amount, 18);
  if (!/^0x[0-9a-fA-F]{40}$/.test(from)) throw new Error("A valid `from` wallet address is required.");
  return {
    action: "send_transaction",
    label: "unwrap",
    summary: `Unwrap ${formatAtoms(atoms, 18)} WETH → ETH on Base`,
    tx: { to: WETH, data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [atoms] }), value: "0", chainId: CHAIN_ID },
  };
}
