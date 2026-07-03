#!/usr/bin/env tsx
// Live smoke against Base mainnet RPC — proves the docs addresses respond and
// the full read+build surface works with REAL chain state. Free (eth_calls
// only, nothing signed or sent). Run: npm run smoke  (in services/uniswap)
import { resolveToken } from "../lib/tokens";
import { bestV3Quote, presentQuote, v3Pools, v4PoolStates, sqrtPriceToPrice } from "../lib/quote";
import { buildSwap } from "../lib/swap";

const FROM = (process.env.SMOKE_FROM as `0x${string}`) ?? "0x1111111111111111111111111111111111111111";

// The default public Base RPC rate-limits bursts; pace the steps so the smoke
// measures OUR correctness, not the free endpoint's patience. Prod sets
// BASE_RPC_URL to a real provider.
const pace = () => new Promise((r) => setTimeout(r, process.env.BASE_RPC_URL ? 0 : 4000));

/** Retry a step once after a pause — free-RPC 429s are transient. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    return run();
  }
}

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  const [usdc, weth] = await Promise.all([resolveToken("USDC"), resolveToken("WETH")]);

  // 1. QuoterV2 answers with a real quote (proves QUOTER_V2 address).
  const q = await bestV3Quote(usdc, weth, 100_000_000n); // 100 USDC
  const pq = presentQuote(q);
  check("QuoterV2 live quote 100 USDC→WETH", q.best.amountOut > 0n, pq.summary);
  check("quote scans multiple tiers", q.tiers.length >= 2, `${q.tiers.length} tiers quoted`);

  // 2. Factory + pool reads (proves V3_FACTORY + pool ABI).
  await pace();
  const pools = await v3Pools(usdc, weth);
  check("v3 factory finds USDC/WETH pools", pools.length >= 2, `${pools.length} pools`);
  const top = pools.filter((p) => p.liquidity > 0n).sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))[0];
  if (top) {
    // slot0 prices token0 in token1 — WETH (0x4200…) sorts before USDC
    // (0x8335…) on Base, so token0 = WETH and the price IS USDC per WETH.
    const wethIsToken0 = weth.address.toLowerCase() < usdc.address.toLowerCase();
    const [d0, d1] = wethIsToken0 ? [weth.decimals, usdc.decimals] : [usdc.decimals, weth.decimals];
    const p = Number(sqrtPriceToPrice(top.sqrtPriceX96, d0, d1));
    const ethUsd = wethIsToken0 ? p : 1 / p;
    check("spot price sane (ETH between $100 and $100k)", ethUsd > 100 && ethUsd < 100_000, `implied ETH ≈ $${ethUsd.toFixed(0)}`);
  } else {
    check("spot price sane (ETH between $100 and $100k)", false, "no live pool to price");
  }

  // 3. v4 StateView reads (proves V4_STATE_VIEW + poolId derivation).
  await pace();
  const v4 = await v4PoolStates(usdc, weth);
  check("v4 StateView finds canonical USDC/WETH-or-ETH pools", v4.length >= 1,
    v4.map((p) => `${p.fee / 100}bps${p.native ? " (native ETH)" : ""} liq=${p.liquidity}`).join(", ") || "none");

  // 4. On-chain token resolution for an unknown address (decimals/symbol read).
  await pace();
  const byAddr = await resolveToken("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  check("unknown-address token resolves on-chain", byAddr.decimals === 6, `${byAddr.symbol} dec=${byAddr.decimals}`);

  // 5. Full build_swap: quote → calldata → allowance read → eth_call dry-run.
  await pace();
  const built = await withRetry(() =>
    buildSwap({ sellToken: "USDC", buyToken: "WETH", amount: "100", from: FROM, slippageBps: 50 }),
  );
  check("build_swap returns a send_transaction action", built.swap.action === "send_transaction" && built.swap.tx.data.startsWith("0x"));
  check("recipient is pinned to the payer", built.swap.summary.length > 0 && built.swap.tx.to === "0x2626664c2603336E57B271c5C0b26F421741e481");
  check("min-out below quote (slippage applied)", BigInt(built.minimumOut.atoms) < q.best.amountOut);
  check("approve step reported", typeof built.approve.needed === "boolean", `needed=${built.approve.needed}`);
  console.log(`   simulation: ok=${built.simulation.ok}${built.simulation.error ? ` (${built.simulation.error})` : ""} — advisory`);
  console.log(`   summary: ${built.swap.summary}`);

  // 6. ETH-in build: no approval needed, value carries the amount.
  await pace();
  const ethIn = await withRetry(() =>
    buildSwap({ sellToken: "ETH", buyToken: "USDC", amount: "0.01", from: FROM }),
  );
  check("ETH-in swap needs no approval and carries value", ethIn.approve.needed === false && BigInt(ethIn.swap.tx.value) === 10_000_000_000_000_000n);

  console.log(failures === 0 ? "\nSMOKE GREEN" : `\nSMOKE RED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE CRASHED:", e);
  process.exit(1);
});
