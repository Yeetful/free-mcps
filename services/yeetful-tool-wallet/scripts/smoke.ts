// Live smoke against the real Alchemy APIs — read-only by construction.
// Usage: ALCHEMY_API_KEY=… pnpm smoke [address]
// Default probe address: the Yeetful house wallet (known holdings on Base +
// Arbitrum from the NEAR Intents live swap of 2026-07-09).
import { resolveChain, resolveChains } from "../lib/chains";
import { getPortfolio, getRecentTransactions, getTokenBalance, getTransactionStatus } from "../lib/alchemy";

const OWNER = process.argv[2] ?? "0x5EaaBd731d2Bc0490C2D47e41858e9b0629455a0";
// The proven NEAR Intents deposit tx on Base (2026-07-09).
const KNOWN_TX = "0xb53095d37078476f396498ba0454ae7a8f36e9dadb251696047f9351d9290219";

let failures = 0;

async function check(name: string, fn: () => Promise<{ pass: boolean; detail: string }>) {
  try {
    const { pass, detail } = await fn();
    console.log(`${pass ? "✅" : "❌"} ${name} — ${detail}`);
    if (!pass) failures++;
  } catch (e) {
    console.log(`❌ ${name} — threw: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }
}

async function main() {
  if (!process.env.ALCHEMY_API_KEY) {
    console.error("ALCHEMY_API_KEY is required for the live smoke.");
    process.exit(1);
  }

  await check("portfolio (all 9 chains, one call)", async () => {
    const p = await getPortfolio({ owner: OWNER, chains: resolveChains() });
    return {
      pass: p.kind === "portfolio" && p.holdings.length > 0 && p.totalUsd > 0,
      detail: p.summary,
    };
  });

  await check('portfolio (filtered: "base and arbitrum" — the flagship ask)', async () => {
    const p = await getPortfolio({ owner: OWNER, chains: resolveChains(["base", "arbitrum"]) });
    const chains = p.chains.map((c) => c.chain).join("+");
    return {
      pass: p.holdings.every((h) => h.chain === "Base" || h.chain === "Arbitrum") && p.holdings.length > 0,
      detail: `${p.holdings.length} holdings on ${chains}, total $${p.totalUsd}`,
    };
  });

  await check("gas balances (nativeOnly)", async () => {
    const p = await getPortfolio({ owner: OWNER, chains: resolveChains(), nativeOnly: true, minUsd: 0 });
    return {
      pass: p.holdings.every((h) => h.native === true),
      detail: p.holdings.map((h) => `${h.chain} ${h.balance} ${h.symbol}`).join(" · ") || "no native balances",
    };
  });

  await check("token_balance (USDC on Arbitrum — the fresh-after-swap check)", async () => {
    const r = await getTokenBalance({
      owner: OWNER,
      chain: resolveChain("arbitrum"),
      token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    });
    return { pass: r.token === "USDC" && Number(String(r.balance).replace(/,/g, "")) > 0, detail: `${r.balance} ${r.token} on ${r.chain}` };
  });

  await check("recent_transactions (multichain merge)", async () => {
    const r = await getRecentTransactions({ owner: OWNER, chains: resolveChains(["base", "arbitrum"]), limit: 5 });
    return {
      pass: r.transactions.length > 0 && r.transactions.every((t) => t.explorerUrl.startsWith("https://")),
      detail: r.transactions.map((t) => `${t.direction} ${t.amount} ${t.asset} (${t.chain})`).join(" · "),
    };
  });

  await check("transaction_status (known confirmed tx)", async () => {
    const r = await getTransactionStatus({ chain: resolveChain("base"), hash: KNOWN_TX });
    return { pass: r.status === "CONFIRMED" && Number(r.confirmations) > 0, detail: `${r.status}, ${r.confirmations} confirmations` };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed (read-only)." : `\n${failures} smoke check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
