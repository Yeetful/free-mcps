// Live smoke against real public RPCs — read-only by construction.
// Usage: pnpm smoke [address]
// Default probe address: the Yeetful house wallet (known small holdings on
// Base + Arbitrum; too small to cover a mainnet plan → exercises the honest
// shortfall path end-to-end).
import { ethUsd } from "../lib/chains";
import { planFunding, scanFundingSources } from "../lib/plan";

const USER = (process.argv[2] ?? "0x5EaaBd731d2Bc0490C2D47e41858e9b0629455a0") as `0x${string}`;

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
  await check("eth_price: QuoterV2 probe returns a sane price", async () => {
    const px = await ethUsd();
    return { pass: px !== null && px > 100 && px < 100_000, detail: `ETH ≈ $${px?.toFixed(2)}` };
  });

  await check("scan_funding_sources: reads all three chains", async () => {
    const scan = await scanFundingSources(USER);
    return {
      pass: scan.readChains.length === 3 && scan.failedChains.length === 0,
      detail: `read [${scan.readChains.join(", ")}], ${scan.sources.length} sources: ${scan.sources.map((s) => `${s.token}@${s.chain}~$${s.usd.toFixed(2)}`).join(" · ") || "none"}`,
    };
  });

  await check("plan_funding: an offer or an honest shortfall, never a dead end", async () => {
    const res = await planFunding(USER, { chainId: 1, token: "ETH", amount: 0.005 });
    const p = res.plan;
    const detail =
      p.kind === "offer"
        ? `offer: ${p.options.map((o) => o.label).join(" | ")}`
        : `short: needs ~$${p.needUsd}, holds ~$${p.totalUsd}`;
    return { pass: p.kind === "offer" || p.kind === "short", detail };
  });

  await check("plan_funding: gas leg appears for a token need on a gasless destination", async () => {
    // The house wallet holds ~0 mainnet gas → a USDC-on-Ethereum need must
    // either plan a gas leg or refuse honestly (never a gasless-token plan).
    const res = await planFunding(USER, { chainId: 1, token: "USDC", amount: 5 });
    const p = res.plan;
    if (p.kind === "offer") {
      const allLeadWithGas = p.options.every((o) => !res.destinationGas.legNeeded || o.legs[0]?.purpose === "gas");
      return { pass: allLeadWithGas, detail: `gasLegNeeded=${res.destinationGas.legNeeded}, first legs: ${p.options.map((o) => o.legs[0]?.purpose).join(",")}` };
    }
    return { pass: true, detail: `short (honest): needs ~$${p.needUsd} incl. gas $${p.gasUsd}` };
  });

  await check("plan_funding: refuses unpriceable tokens with a pointer, not a guess", async () => {
    const res = await planFunding(USER, { chainId: 1, token: "PEPE", amount: 1000 }).then(
      () => null,
      (e: Error) => e.message,
    );
    return { pass: !!res && /price/i.test(res), detail: res?.slice(0, 80) ?? "did not throw" };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
