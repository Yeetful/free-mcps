// Live smoke against real public RPCs — read-only by construction.
// Usage: pnpm smoke [address]
import { ethUsd } from "../lib/chains";
import { scanWallet } from "../lib/scan";
import { mintHandoff } from "../lib/handoff";

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
  await check("eth price: QuoterV2 probe returns a sane price", async () => {
    const px = await ethUsd();
    return { pass: px !== null && px > 100 && px < 100_000, detail: `ETH ≈ $${px?.toFixed(2)}` };
  });

  await check("scan_wallet: reads the covered chains", async () => {
    const s = await scanWallet(USER);
    return {
      pass: s.readChains.length > 0,
      detail: `read [${s.readChains.join(", ")}], failed [${s.failedChains.join(", ") || "none"}], ${s.holdings.length} holdings`,
    };
  });

  await check("mintHandoff: sign link round-trips the ask", async () => {
    const h = mintHandoff("Buy $12 of AAPL", { agent: "smoke", mcps: ["robinhood-free"] });
    const u = new URL(h.signUrl);
    return { pass: u.pathname === "/sign" && u.searchParams.get("ask") === "Buy $12 of AAPL", detail: h.signUrl };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
