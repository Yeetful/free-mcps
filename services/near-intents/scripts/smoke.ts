// Live smoke against the real 1Click API — ZERO SPEND by construction: only
// the token list, DRY quotes (dry:true never creates a deposit address), and
// a status lookup for a bogus address. Nothing is committed, signed, or sent.
// Usage: pnpm smoke   (set NEAR_INTENT_API_KEY to also prove authed calls)
import { getTokens, normalizeChain, EVM_CHAINS } from "../lib/oneclick";
import { dryQuote } from "../lib/swap";
import { checkStatus } from "../lib/status";

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
  console.log(`API key: ${process.env.NEAR_INTENT_API_KEY ? "set (authed, no 0.2% keyless fee)" : "NOT set (keyless mode)"}\n`);

  await check("tokens (supported-asset list)", async () => {
    const tokens = await getTokens();
    const chains = new Set(tokens.map((t) => t.blockchain));
    const baseUsdc = tokens.find((t) => t.blockchain === "base" && t.symbol === "USDC");
    const arbUsdc = tokens.find((t) => t.blockchain === "arb" && t.symbol === "USDC");
    return {
      pass: tokens.length > 100 && Boolean(baseUsdc) && Boolean(arbUsdc),
      detail: `${tokens.length} assets across ${chains.size} chains; USDC present on Base + Arbitrum`,
    };
  });

  await check("every EVM build chain is live upstream", async () => {
    const tokens = await getTokens();
    const live = new Set(tokens.map((t) => t.blockchain));
    const missing = Object.keys(EVM_CHAINS).filter((c) => !live.has(c));
    return {
      pass: missing.length === 0,
      detail: missing.length === 0 ? `all ${Object.keys(EVM_CHAINS).length} EVM chains list tokens` : `missing: ${missing.join(", ")}`,
    };
  });

  await check("dry quote USDC Base → USDC Arbitrum (the flagship route)", async () => {
    const r = await dryQuote({
      originChain: "base",
      originToken: "USDC",
      destinationChain: "arbitrum",
      destinationToken: "USDC",
      amount: "5",
    });
    const out = Number(r.quote.receive.estimated);
    return {
      pass: r.kind === "preview_quote" && out > 4 && out < 5.05 && r.quote.etaSeconds > 0,
      detail: r.quote.summary,
    };
  });

  await check("dry quote USDC Base → SOL Solana (cross-VM route)", async () => {
    const r = await dryQuote({
      originChain: "base",
      originToken: "USDC",
      destinationChain: "sol",
      destinationToken: "SOL",
      amount: "25",
    });
    return { pass: Number(r.quote.receive.estimated) > 0, detail: r.quote.summary };
  });

  await check("status of an unknown deposit address explains itself", async () => {
    try {
      await checkStatus("0x000000000000000000000000000000000000dEaD");
      return { pass: false, detail: "expected a 404 explanation, got a result" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { pass: /DRY preview|doesn't recognize/.test(msg), detail: msg.slice(0, 120) };
    }
  });

  await check("chain normalization matches the live enum", async () => {
    const tokens = await getTokens();
    const live = new Set(tokens.map((t) => t.blockchain));
    const probes = ["base", "arbitrum", "ethereum", "solana", "bitcoin"].map(normalizeChain);
    const dead = probes.filter((p) => !live.has(p));
    return { pass: dead.length === 0, detail: dead.length === 0 ? `verified: ${probes.join(", ")}` : `not live: ${dead.join(", ")}` };
  });

  console.log(failures === 0 ? "\nAll smoke checks passed (zero spend)." : `\n${failures} smoke check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
