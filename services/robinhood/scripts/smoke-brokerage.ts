/* Live READ-ONLY smoke against the real Robinhood Crypto Trading API using
 * the env credentials (ROBINHOOD_API_KEY + ROBINHOOD_PRIVATE_KEY). ZERO
 * order placement by construction: reads + the read-only build_order preview
 * only — brokerage_submit_order and brokerage_cancel_order are NEVER called
 * here (the write path is covered by unit tests against a fake API).
 *
 *   pnpm smoke:brokerage      (loads .env.local via node --env-file-if-exists)
 */

import { resolveCreds, maskApiKey } from "../lib/brokerage";
import { brokerageReads, buildOrder, verifyConfirmToken, type OrderParams } from "../lib/brokerage-orders";

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`  ✅ ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function main() {
  const resolved = resolveCreds(undefined);
  if ("error" in resolved) {
    console.error("No env credentials — set ROBINHOOD_API_KEY + ROBINHOOD_PRIVATE_KEY in .env.local to run the live smoke.");
    process.exit(1);
  }
  const creds = resolved.creds;
  console.log(`\nRobinhood brokerage smoke (READ-ONLY) — ${maskApiKey(creds.apiKey)}\n`);

  let accountNumber = "";
  await check("brokerage_accounts returns an active account", async () => {
    const res = await brokerageReads.accounts(creds);
    assert(res.ok, String(res.data));
    const d = res.data as { results?: Array<{ account_number: string; status: string; buying_power?: string; buying_power_currency?: string }> };
    const acct = d.results?.[0];
    assert(acct?.account_number, "no account in response");
    accountNumber = acct!.account_number;
    return `status ${acct!.status}, buying power ${acct!.buying_power ?? "?"} ${acct!.buying_power_currency ?? ""}`.trim();
  });

  await check("brokerage_best_bid_ask BTC-USD", async () => {
    const res = await brokerageReads.bestBidAsk(creds, { symbols: ["BTC-USD"] });
    assert(res.ok, String(res.data));
    const q = (res.data as { results?: Array<{ symbol: string; bid?: string; ask?: string }> }).results?.[0];
    assert(q?.symbol === "BTC-USD", "no BTC-USD quote");
    assert(Number(q!.bid) > 0 && Number(q!.ask) > 0, `bad bid/ask: ${q!.bid}/${q!.ask}`);
    return `bid $${q!.bid} / ask $${q!.ask}`;
  });

  await check("brokerage_trading_pairs paginates the tradable list", async () => {
    const res = await brokerageReads.tradingPairs(creds, {});
    assert(res.ok, String(res.data));
    const d = res.data as { count: number; pairs: Array<{ symbol: string }> };
    assert(d.count >= 5, `only ${d.count} pairs`);
    assert(d.pairs.some((p) => p.symbol === "BTC-USD"), "BTC-USD missing from pairs");
    return `${d.count} pairs`;
  });

  await check("brokerage_estimated_price 0.001 BTC (ask)", async () => {
    const res = await brokerageReads.estimatedPrice(creds, { symbol: "BTC-USD", side: "ask", quantity: "0.001" });
    assert(res.ok, String(res.data));
    // v2 shape: side-named price + fee-tier totals.
    const q = (res.data as { results?: Array<{ ask?: number; est_fee?: number; est_total_cost?: number }> }).results?.[0];
    assert(q?.ask && Number(q.ask) > 0, "no estimated ask price");
    return `$${Number(q!.ask).toFixed(2)} per BTC, est total $${q!.est_total_cost?.toFixed(2)} incl. $${q!.est_fee?.toFixed(2)} fee`;
  });

  await check("brokerage_holdings lists (possibly empty) holdings", async () => {
    const res = await brokerageReads.holdings(creds, {});
    assert(res.ok, String(res.data));
    const d = res.data as { count: number };
    return `${d.count} holding(s)`;
  });

  await check("brokerage_orders lists (possibly empty) orders", async () => {
    const res = await brokerageReads.orders(creds, {});
    assert(res.ok, String(res.data));
    const d = res.data as { count: number };
    return `${d.count} order(s)`;
  });

  await check("brokerage_build_order previews WITHOUT placing (read-only step 1)", async () => {
    const res = await buildOrder(creds, { symbol: "BTC-USD", side: "buy", type: "market", assetQuantity: "0.0001" });
    assert(res.ok, String(res.data));
    const d = res.data as { estimate: { estNotionalUsd: number }; confirmToken: string; nextStep: string };
    assert(d.confirmToken.includes("."), "no confirm token");
    assert(d.nextStep.includes("REAL MONEY"), "missing the real-money warning");
    // Token round-trips locally against the same params — still nothing placed.
    const params: OrderParams = { accountNumber, symbol: "BTC-USD", side: "buy", type: "market", assetQuantity: "0.0001" };
    const verdict = verifyConfirmToken(creds, params, d.confirmToken);
    assert(verdict.ok, `token failed local verification: ${!verdict.ok ? verdict.reason : ""}`);
    return `est. $${d.estimate.estNotionalUsd} for 0.0001 BTC — NOT submitted`;
  });

  console.log(`\n${failures === 0 ? "✅ brokerage smoke clean (read-only, nothing placed)" : `❌ ${failures} failure(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
