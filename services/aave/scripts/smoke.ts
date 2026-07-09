// Live smoke against the real AaveKit v4 API (zero spend by construction —
// reads + transaction PREPARATION only; nothing is ever signed or submitted).
// Usage: pnpm smoke [address]
// Verifies: markets, reserves (chain-wide + per-spoke + symbol filter),
// portfolio/balances/activities for an address, the guard, check_transaction,
// and every build_* wrapper (construct-only: the returned calldata is never
// sent anywhere).
import { gqlRequest, queries } from "../lib/aave";
import { builds } from "../lib/tx";
import { guardQuery } from "../lib/graphql-guard";

// Default probe address: a live v4 whale found via reserveHolders (2026-07-09
// — supplies WETH/weETH/cbBTC/XAUt, borrows USDT/frxUSD across 3 spokes).
const USER = process.argv[2] ?? "0x71F12a5b0E60d2Ff8A87FD34E7dcff3c10c914b0";

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
  let spokeAddress = "";
  let usdc: { address: string; spoke: string } | null = null;

  await check("markets (hubs + spokes)", async () => {
    const r = await queries.markets({});
    const d = dig<{ hubs: { name: string }[]; spokes: { name: string; address: string }[] }>(r);
    spokeAddress = d.spokes[0]?.address ?? "";
    return {
      pass: r.ok && d.hubs.length >= 1 && d.spokes.length >= 1,
      detail: `${d.hubs.length} hubs (${d.hubs.map((h) => h.name).join("/")}), ${d.spokes.length} spokes`,
    };
  });

  await check("reserves (chain-wide, top by size)", async () => {
    const r = await queries.reserves({ first: 10 });
    const d = dig<{ count: number; reserves: { asset: { symbol: string; address: string }; spoke: string; spokeAddress: string; supplyApyPct: number | null; canSupply: boolean }[] }>(r);
    const u = d.reserves.find((x) => x.asset.symbol === "USDC" && x.canSupply);
    if (u) usdc = { address: u.asset.address, spoke: u.spokeAddress };
    return {
      pass: r.ok && d.reserves.length > 0 && d.reserves.some((x) => x.supplyApyPct !== null),
      detail: `${d.count} reserves, top: ${d.reserves.slice(0, 3).map((x) => `${x.asset.symbol}@${x.spoke}`).join(", ")}`,
    };
  });

  await check("reserves (per-spoke)", async () => {
    const r = await queries.reserves({ spokeAddress });
    const d = dig<{ count: number }>(r);
    return { pass: r.ok && d.count > 0, detail: `${d.count} reserves on ${spokeAddress.slice(0, 8)}…` };
  });

  await check("reserves (symbol filter WETH)", async () => {
    const r = await queries.reserves({ symbols: ["WETH"] });
    const d = dig<{ count: number; reserves: { asset: { symbol: string } }[] }>(r);
    return {
      pass: r.ok && d.count > 0 && d.reserves.every((x) => x.asset.symbol === "WETH"),
      detail: `${d.count} WETH reserves`,
    };
  });

  await check(`portfolio (${USER.slice(0, 8)}…)`, async () => {
    const r = await queries.portfolio({ user: USER });
    const d = dig<{ positions: { spoke: string; healthFactor: string | null }[]; supplies: { earnedInterest: string | null }[]; borrows: unknown[] }>(r);
    return {
      pass: r.ok,
      detail: `${d.positions.length} positions, ${d.supplies.length} supplies, ${d.borrows.length} borrows${
        d.positions[0] ? `, HF ${Number(d.positions[0].healthFactor).toFixed(2)} on ${d.positions[0].spoke}` : ""
      }`,
    };
  });

  await check("balances (supplyable wallet tokens)", async () => {
    const r = await queries.balances({ user: USER });
    const d = dig<{ balances: { symbol: string; bestSupplyApyPct: number | null }[] }>(r);
    return { pass: r.ok, detail: `${d.balances.length} tokens held` };
  });

  await check("activities (history)", async () => {
    const r = await queries.activities({ user: USER });
    const d = dig<{ activities: { type: string }[] }>(r);
    return { pass: r.ok, detail: `${d.activities.length} recent items` };
  });

  await check("check_transaction (known supply tx)", async () => {
    const r = await gqlRequest(
      `query($request: HasProcessedKnownTransactionRequest!) { hasProcessedKnownTransaction(request: $request) }`,
      {
        request: {
          operations: ["SPOKE_SUPPLY"],
          txHash: "0xede0a785e3d86bc681007641aab90a82f8b34f1438d9ac5c074b275f895df26c",
        },
      },
    );
    return { pass: r.ok && dig<{ hasProcessedKnownTransaction: boolean }>(r).hasProcessedKnownTransaction === true, detail: "indexed = true" };
  });

  await check("graphql_query guard (allows reads, blocks tx-prep root)", async () => {
    const good = guardQuery(`query($r: HubsRequest!) { hubs(request: $r) { name } }`);
    const bad = guardQuery(`query { supply(request: {}) { __typename } }`);
    return { pass: good.ok && !bad.ok, detail: "read ok, supply blocked" };
  });

  // ── Construct-only transaction building (nothing signed, nothing sent) ────
  // The API validates against REAL balances/positions/health factor, so each
  // build targets what the probe wallet actually holds: supply ← a wallet
  // balance, withdraw/collateral ← an existing supply, repay ← an existing
  // borrow. Legible server-side refusals (HF-gated etc.) also count as passes
  // — that's the guardrail doing its job.
  if (!usdc) {
    const r = await queries.reserves({ symbols: ["USDC"] });
    const d = dig<{ reserves: { asset: { address: string }; spokeAddress: string; canSupply: boolean; canBorrow: boolean }[] }>(r);
    const u = d.reserves.find((x) => x.canBorrow) ?? d.reserves[0];
    if (u) usdc = { address: u.asset.address, spoke: u.spokeAddress };
  }

  const pf = await queries.portfolio({ user: USER });
  const pfd = dig<{
    supplies: { spokeAddress: string; token: { address: string | null; symbol: string | null } }[];
    borrows: { spokeAddress: string; token: { address: string | null; symbol: string | null } }[];
  }>(pf);
  const bal = await queries.balances({ user: USER });
  const held = dig<{ balances: { address: string | null; symbol: string | null; amount: string | null }[] }>(bal)
    .balances.find((b) => b.address && b.symbol && Number(b.amount ?? 0) > 0.01);
  let supplyTarget: { spoke: string; address: string; symbol: string; amount: string } | null = null;
  if (held) {
    // Pair the held token with a spoke that actually lists it as suppliable.
    const r = await queries.reserves({ symbols: [held.symbol!] });
    const row = dig<{ reserves: { spokeAddress: string; canSupply: boolean }[] }>(r).reserves.find((x) => x.canSupply);
    if (row) supplyTarget = { spoke: row.spokeAddress, address: held.address!, symbol: held.symbol!, amount: held.amount! };
  }

  const asSteps = (r: { ok: boolean; data: unknown }, wantBuilt: boolean) => {
    const steps = ((r.data as { steps?: { action: string; label: string; tx: { data: string } }[] })?.steps ?? []);
    const built = r.ok && steps.length >= 1 && steps.every((s) => s.action === "send_transaction" && s.tx.data.startsWith("0x"));
    return {
      pass: built || (!wantBuilt && !r.ok),
      detail: built
        ? `${steps.length} step(s): ${steps.map((s) => s.label).join(" → ")}`
        : `${r.ok ? "unexpected shape" : "legible refusal"}: ${JSON.stringify(r.data).slice(0, 140)}`,
    };
  };

  if (supplyTarget?.address) {
    await check(`build_supply (${supplyTarget.symbol} the wallet holds)`, async () => {
      const amount = String(Math.min(Number(supplyTarget.amount), 1));
      const r = await builds.supply({ spokeAddress: supplyTarget.spoke, currency: supplyTarget.address!, amount, user: USER });
      return asSteps(r, true);
    });
  }

  const sup = pfd.supplies.find((s) => s.token.address && s.spokeAddress);
  if (sup) {
    await check(`build_withdraw (existing ${sup.token.symbol} supply, small exact)`, async () => {
      const r = await builds.withdraw({ spokeAddress: sup.spokeAddress, currency: sup.token.address!, amount: "0.000001", user: USER });
      return asSteps(r, true);
    });

    await check(`preview borrow impact (HF before/after)`, async () => {
      const bor = pfd.borrows.find((b) => b.token.address && b.spokeAddress);
      const target = bor ?? sup;
      const r = await builds.preview({
        action: bor ? "borrow" : "supply",
        spokeAddress: target.spokeAddress,
        currency: target.token.address!,
        amount: "1",
        user: USER,
      });
      const d = dig<{ healthFactor?: { current: string | null; after: string | null } }>(r);
      return {
        pass: r.ok && !!d.healthFactor?.current,
        detail: r.ok ? `HF ${d.healthFactor?.current} → ${d.healthFactor?.after}` : `refusal: ${JSON.stringify(r.data).slice(0, 120)}`,
      };
    });

    await check("build_collateral_toggle (existing supply)", async () => {
      const r = await builds.setCollateral({ spokeAddress: sup.spokeAddress, currency: sup.token.address!, enable: true, user: USER });
      return asSteps(r, false); // may legitimately refuse (already enabled / HF-gated)
    });
  }

  const bor = pfd.borrows.find((b) => b.token.address && b.spokeAddress);
  if (bor) {
    await check(`build_repay (existing ${bor.token.symbol} debt, small exact)`, async () => {
      const r = await builds.repay({ spokeAddress: bor.spokeAddress, currency: bor.token.address!, amount: "0.01", user: USER });
      return asSteps(r, false); // InsufficientBalance is legible if wallet holds none of the debt token
    });
  }

  if (usdc) {
    await check("build_borrow (USDC against collateral)", async () => {
      const r = await builds.borrow({ spokeAddress: usdc!.spoke, currency: usdc!.address, amount: "1", user: USER });
      return asSteps(r, false);
    });
  }

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
