// Live smoke against the real CoW order-book API (read-only + quote — zero
// cost, POST /quote is free and commits to nothing).
// Usage: pnpm smoke [address]
// Verifies: version, native_price, a real USDC→WETH quote, build_swap_order
// end-to-end (typed data + approval hint), user_orders/user_trades/portfolio
// for an address, solver_competition latest, order_status on a real recent
// uid pulled from the latest auction's trades, and docs search.
import { CHAINS, apiGet } from "../lib/cow";
import * as q from "../lib/queries";
import { searchDocs } from "../lib/docs";

// Default probe address: vitalik.eth (public; quotes are address-sensitive
// but any funded-ish address quotes fine).
const USER = process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E45359a2c7bA4c30";

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

const dig = <T,>(r: { ok: boolean; data: unknown }): T => r.data as T;

async function main() {
  await check("version (mainnet order book)", async () => {
    const r = await apiGet(CHAINS.mainnet!, "/v1/version");
    return { pass: r.ok && typeof r.data === "string", detail: String(r.data) };
  });

  await check("native_price (WETH mainnet)", async () => {
    const r = await q.nativePrice({ chain: "mainnet", token: "WETH" });
    const price = dig<{ price: number }>(r).price;
    return { pass: r.ok && Math.abs(price - 1) < 0.01, detail: `price=${price} (WETH ≈ 1 ETH)` };
  });

  await check("quote (100 USDC → WETH, mainnet)", async () => {
    const r = await q.quote({ chain: "mainnet", sellToken: "USDC", buyToken: "WETH", kind: "sell", amount: 100, from: USER });
    const d = dig<{ sell: string; buy: string; networkFee: string; verified: boolean }>(r);
    return { pass: r.ok && d.buy.includes("WETH"), detail: `${d.sell} → ${d.buy} (fee ${d.networkFee}, verified=${d.verified})` };
  });

  await check("build_swap_order (2 USDC → COW, base — typed data + approval)", async () => {
    const r = await q.buildSwapOrder({ chain: "base", sellToken: "USDC", buyToken: "COW", kind: "sell", amount: 2, from: USER });
    if (!r.ok) return { pass: false, detail: JSON.stringify(r.data).slice(0, 200) };
    const d = dig<{
      typedData: { domain: { chainId: number; verifyingContract: string }; primaryType: string };
      order: { feeAmount: string; sellAmount: string };
      approval: { spender: string };
      quoteId: number | null;
    }>(r);
    const pass =
      d.typedData.primaryType === "Order" &&
      d.typedData.domain.chainId === 8453 &&
      d.typedData.domain.verifyingContract === "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" &&
      d.order.feeAmount === "0" &&
      d.approval.spender === "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
    return { pass, detail: `sellAmount=${d.order.sellAmount} atoms, quoteId=${d.quoteId}, domain ok` };
  });

  await check("build_limit_order (1 WETH ≥ 9000 USDC, mainnet, 30d)", async () => {
    const r = await q.buildLimitOrder({
      chain: "mainnet", sellToken: "WETH", buyToken: "USDC", sellAmount: 1, buyAmount: 9000, from: USER, validFor: 30 * 24 * 3600,
    });
    const d = dig<{ order: { buyAmount: string; feeAmount: string } }>(r);
    return { pass: r.ok && d.order.buyAmount === "9000000000" && d.order.feeAmount === "0", detail: `buyAmount=${d.order.buyAmount} atoms (constructed offline, no API call)` };
  });

  await check(`user_orders + user_trades (${USER.slice(0, 10)}…)`, async () => {
    const [o, t] = await Promise.all([
      q.userOrders({ chain: "mainnet", owner: USER, limit: 5 }),
      q.userTrades({ chain: "mainnet", owner: USER, first: 5 }),
    ]);
    const oc = dig<{ returned: number; openCount: number }>(o);
    const tc = dig<{ totalReturned: number }>(t);
    return { pass: o.ok && t.ok, detail: `${oc.returned} orders (${oc.openCount} open), ${tc.totalReturned} trades` };
  });

  await check("portfolio (mainnet + base)", async () => {
    const r = await q.portfolio({ owner: USER, chains: ["mainnet", "base"] });
    const d = dig<{ chains: { chain: string }[] }>(r);
    return { pass: r.ok && d.chains.length === 2, detail: d.chains.map((c) => c.chain).join(", ") };
  });

  let realUid: string | null = null;
  await check("solver_competition (latest, mainnet)", async () => {
    const r = await q.solverCompetition({ chain: "mainnet" });
    const d = dig<{ auctionId: number; settlementTxHashes: string[]; solutions: unknown[] }>(r);
    // Pull a real, recently-settled order uid for the order_status check.
    if (r.ok && d.settlementTxHashes[0]) {
      const trades = await apiGet(CHAINS.mainnet!, `/v1/trades?txHash=${d.settlementTxHashes[0]}`);
      // /trades needs owner|orderUid — fall back to the auction's order list via by_tx_hash competition data.
      if (!trades.ok) {
        const comp = await apiGet(CHAINS.mainnet!, `/v2/solver_competition/by_tx_hash/${d.settlementTxHashes[0]}`);
        const orders = (comp.data as { auction?: { orders?: string[] } })?.auction?.orders;
        realUid = orders?.[0] ?? null;
      }
    }
    return { pass: r.ok && d.auctionId > 0, detail: `auction ${d.auctionId}, ${d.solutions.length} solutions, ${d.settlementTxHashes.length} txs` };
  });

  await check("order_status (real recent uid from the latest auction)", async () => {
    if (!realUid) return { pass: false, detail: "no uid recovered from solver_competition" };
    const r = await q.orderStatus({ chain: "mainnet", uid: realUid });
    const d = dig<{ status: string; pair: string; explorerUrl: string }>(r);
    return { pass: r.ok && !!d.status, detail: `${realUid.slice(0, 18)}… status=${d.status} pair=${d.pair}` };
  });

  await check("docs_search (bundled corpus, offline)", async () => {
    const hits = await searchDocs("how does MEV protection work");
    return { pass: hits.length > 0, detail: `${hits.length} hits, top: ${hits[0]?.path}` };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
