// REAL-MONEY end-to-end: swap a SMALL amount of USDC on Base → USDC on
// Arbitrum through the exact artifacts this MCP hands the chat — build_swap's
// unsigned step is signed locally and the swap is tracked to delivery.
//
//   PRIVATE_KEY=0x… pnpm tsx scripts/live-swap.ts --yes [amountUsdc]
//
// Guards: refuses without --yes, refuses amounts > $5, checks balances
// before sending. Set NEAR_INTENT_API_KEY to avoid the keyless 0.2% fee.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { buildSwap } from "../lib/swap";
import { awaitCompletion, notifyDeposit } from "../lib/status";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("This script moves REAL USDC. Re-run with --yes to proceed.");
    process.exit(1);
  }
  const amount = process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? "0.55";
  if (Number(amount) > 5) {
    console.error(`Refusing ${amount} USDC — this harness is capped at 5 USDC.`);
    process.exit(1);
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("PRIVATE_KEY env is required (a funded Base wallet).");
    process.exit(1);
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  const baseClient = createPublicClient({ chain: base, transport: http() });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http() });
  const wallet = createWalletClient({ account, chain: base, transport: http() });

  const [baseUsdc, arbUsdcBefore] = await Promise.all([
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    arbClient.readContract({ address: USDC_ARB, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`Wallet ${account.address}`);
  console.log(`  Base USDC:     ${formatUnits(baseUsdc, 6)}`);
  console.log(`  Arbitrum USDC: ${formatUnits(arbUsdcBefore, 6)} (before)`);

  console.log(`\n▶ build_swap: ${amount} USDC Base → Arbitrum (recipient = same wallet)…`);
  const built = await buildSwap({
    originChain: "base",
    originToken: "USDC",
    destinationChain: "arbitrum",
    destinationToken: "USDC",
    amount,
    from: account.address,
  });
  console.log(`  ${built.quote.summary}`);
  console.log(`  deposit address: ${built.deposit.address} (expires ${built.deposit.addressExpires})`);
  console.log(`  balanceCheck: ${built.balanceCheck.note}`);
  if (built.balanceCheck.ok === false) process.exit(1);

  const step = built.steps[0];
  console.log(`\n▶ signing "${step.label}": ${step.summary.slice(0, 100)}…`);
  const hash = await wallet.sendTransaction({
    to: step.tx.to as `0x${string}`,
    data: step.tx.data as `0x${string}`,
    value: BigInt(step.tx.value),
  });
  console.log(`  sent: https://basescan.org/tx/${hash}`);
  const receipt = await baseClient.waitForTransactionReceipt({ hash });
  console.log(`  confirmed in block ${receipt.blockNumber} (${receipt.status})`);

  console.log("\n▶ submit_deposit_tx…");
  const notified = await notifyDeposit({ depositAddress: built.deposit.address, txHash: hash });
  console.log(`  status: ${notified.status}`);

  console.log("\n▶ await_completion (looping until terminal)…");
  const deadline = Date.now() + 10 * 60_000;
  let last = await awaitCompletion({ depositAddress: built.deposit.address, timeoutSec: 45 });
  while (!last.terminal && Date.now() < deadline) {
    console.log(`  … still ${last.status} (${last.explanation.slice(0, 80)})`);
    last = await awaitCompletion({ depositAddress: built.deposit.address, timeoutSec: 45 });
  }
  console.log(`  final status: ${last.status}`);
  console.log(`  delivered: ${last.swap.delivered} USDC ($${last.swap.deliveredUsd})`);
  for (const t of last.swap.destinationTransactions) console.log(`  destination tx: ${t.explorer ?? t.hash}`);

  const arbUsdcAfter = await arbClient.readContract({
    address: USDC_ARB,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`\nArbitrum USDC after: ${formatUnits(arbUsdcAfter, 6)} (Δ +${formatUnits(arbUsdcAfter - arbUsdcBefore, 6)})`);
  const delivered = arbUsdcAfter > arbUsdcBefore && last.status === "SUCCESS";
  console.log(delivered ? "\n✅ Cross-chain swap delivered end-to-end." : "\n❌ Swap did not complete — inspect the status output above.");
  process.exit(delivered ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
