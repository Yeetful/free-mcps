// The universal funding planner — the pure half, mirroring the website's
// lib/funding-plan.ts (website#445/#446) so every consumer speaks the same
// doctrine:
//   · same-token sources outrank stables outrank ETH; richest chain first
//   · destination-chain balances are never sources (that's a same-chain
//     swap, not a bridge)
//   · when the destination wallet can't pay gas for the follow-up action,
//     every option leads with a source → native-ETH gas leg — funds that
//     land where the wallet can't sign are STRANDED, not delivered
//   · a source is only viable if its own chain holds gas to sign with
//   · margins cover solver fees; overshoot lands in the user's own wallet
//   · when the whole wallet can't cover it, say exactly what was seen and
//     what the smallest plan needs — actionable, never a dead end
//
// Output is STRUCTURED legs an agent hands to the NEAR Intents MCP's
// `build_swap` verbatim (originChain/originToken/amount/destinationChain/
// destinationToken) — this service never writes calldata or addresses.

import { erc20Abi, formatEther, formatUnits } from "viem";
import { clientFor, ethUsd, FUNDING_CHAINS, type FundingChain } from "./chains";

export const FUNDING_MARGIN_BPS = 1_000;
export const FUNDING_FLAT_USD = 1;
export const FUNDING_MIN_PLAN_USD = 2;
export const MIN_GAS_LEG_USD = 1.5;
const DUST_USD = 0.5;

export interface FundingSource {
  chainId: number;
  chain: string;
  token: "ETH" | "USDC";
  /** Movable balance (source-chain gas reserve already deducted for ETH). */
  balance: number;
  usd: number;
}

export interface FundingScan {
  sources: FundingSource[];
  readChains: string[];
  /** Chains whose RPC reads failed (after one retry). Failed = UNKNOWN,
   *  never "empty" — plans and refusals only speak for readChains. */
  failedChains: string[];
}

export interface FundingNeed {
  chainId: number;
  /** Token symbol that must land on the destination ("ETH", "USDC", …). */
  token: string;
  /** How much MORE of it must land there (the shortfall, not the ask). */
  amount: number;
}

export interface FundingLeg {
  /** 'funding' moves the needed token; 'gas' drops native ETH so the
   *  follow-up action is signable. Execute IN ORDER via the NEAR Intents
   *  MCP's build_swap, waiting for each settlement. */
  purpose: "funding" | "gas";
  originChain: string;
  originToken: string;
  amount: string;
  destinationChain: string;
  destinationToken: string;
  approxUsd: number;
}

export interface FundingOption {
  kind: "just-enough" | "all-of-source" | "combined";
  label: string;
  legs: FundingLeg[];
  totalUsd: number;
  /** The Yeetful-chat compound-ask sentence for these legs — append
   *  ", then <your action>" and send it to a Yeetful chat/embed to run the
   *  whole thing as one guarded job. */
  yeetfulResume: string;
}

export type FundingPlan =
  | { kind: "offer"; needUsd: number; gasUsd: number; options: FundingOption[]; sourcesSeen: string }
  | { kind: "short"; needUsd: number; gasUsd: number; totalUsd: number; sourcesSeen: string; note: string };

const fmtAmount = (n: number, dp: number, mode: "up" | "down"): string => {
  const f = 10 ** dp;
  const v = mode === "up" ? Math.ceil(n * f) / f : Math.floor(n * f) / f;
  return v.toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

const usd2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

/** Dollars a plan must move for the token leg: shortfall × price, margined
 *  for solver fees, floored at the minimum sensible move, $0.50-rounded. */
export function fundingPlanUsd(amount: number, tokenUsd: number): number {
  const raw = amount * tokenUsd * (1 + FUNDING_MARGIN_BPS / 10_000) + FUNDING_FLAT_USD;
  return Math.max(FUNDING_MIN_PLAN_USD, Math.ceil(raw * 2) / 2);
}

function sourceAmountFor(source: FundingSource, usd: number): string {
  const perUsd = source.balance / source.usd;
  const dp = source.token === "USDC" ? 2 : 6;
  const amt = Math.min(usd * perUsd, source.balance);
  return fmtAmount(amt, dp, amt >= source.balance ? "down" : "up");
}

export function rankFundingSources(need: FundingNeed, sources: FundingSource[]): FundingSource[] {
  const group = (s: FundingSource) => (s.token.toUpperCase() === need.token.toUpperCase() ? 0 : s.token === "USDC" ? 1 : 2);
  return [...sources].sort((a, b) => group(a) - group(b) || b.usd - a.usd);
}

const destWord = (need: FundingNeed): string => FUNDING_CHAINS.find((c) => c.chainId === need.chainId)?.word ?? String(need.chainId);

function leg(purpose: "funding" | "gas", s: FundingSource, amount: string, need: FundingNeed, approxUsd: number): FundingLeg {
  return {
    purpose,
    originChain: s.chain,
    originToken: s.token,
    amount,
    destinationChain: destWord(need),
    destinationToken: purpose === "gas" ? "ETH" : need.token.toUpperCase(),
    approxUsd: Number(approxUsd.toFixed(2)),
  };
}

const resumeOf = (legs: FundingLeg[]): string =>
  legs.map((l) => `Swap ${l.amount} ${l.originToken} from ${l.originChain} to ${l.destinationToken} on ${l.destinationChain}`).join(", then ");

/**
 * The pure planner. `gasUsd` > 0 = the destination wallet can't sign the
 * follow-up; every option leads with a gas leg from the same source.
 */
export function planFundingOptions(need: FundingNeed, needUsd: number, sources: FundingSource[], gasUsd = 0): FundingPlan {
  const ranked = rankFundingSources(
    need,
    sources.filter((s) => s.usd >= DUST_USD && s.chainId !== need.chainId),
  );
  const sourcesSeen = ranked
    .slice(0, 4)
    .map((s) => `~$${usd2(Number(s.usd.toFixed(2)))} of ${s.token} on ${s.chain}`)
    .join(", ");
  const totalUsd = Number(ranked.reduce((a, s) => a + s.usd, 0).toFixed(2));
  const totalNeedUsd = Number((needUsd + gasUsd).toFixed(2));

  const legsFrom = (s: FundingSource, tokenUsd: number): FundingLeg[] | null => {
    if (s.usd < tokenUsd + gasUsd) return null;
    const legs: FundingLeg[] = [];
    let spent = 0;
    if (gasUsd > 0) {
      legs.push(leg("gas", s, sourceAmountFor(s, gasUsd), need, gasUsd));
      spent = gasUsd;
    }
    const remaining: FundingSource = { ...s, balance: s.balance * (1 - spent / s.usd), usd: s.usd - spent };
    legs.push(leg("funding", remaining, sourceAmountFor(remaining, tokenUsd), need, tokenUsd));
    return legs;
  };

  const best = ranked.find((s) => s.usd >= totalNeedUsd);
  const options: FundingOption[] = [];
  if (best) {
    const justEnough = legsFrom(best, needUsd)!;
    options.push({
      kind: "just-enough",
      label: `Just enough (~$${usd2(totalNeedUsd)} of ${best.token} on ${best.chain})`,
      legs: justEnough,
      totalUsd: totalNeedUsd,
      yeetfulResume: resumeOf(justEnough),
    });
    if (best.usd >= totalNeedUsd * 1.6 && best.usd <= totalNeedUsd * 10) {
      const allLegs = legsFrom(best, Number((best.usd - gasUsd).toFixed(2)));
      if (allLegs) {
        options.push({
          kind: "all-of-source",
          label: `All the ${best.token} on ${best.chain} (~$${usd2(Number(best.usd.toFixed(2)))})`,
          legs: allLegs,
          totalUsd: Number(best.usd.toFixed(2)),
          yeetfulResume: resumeOf(allLegs),
        });
      }
    }
  } else if (totalUsd >= totalNeedUsd && ranked.length >= 2) {
    const byUsd = [...ranked].sort((a, b) => b.usd - a.usd);
    const legs: FundingLeg[] = [];
    let covered = 0;
    let gasCarried = 0;
    for (const s of byUsd) {
      const spendable = s.usd - (gasCarried === 0 && gasUsd > 0 ? gasUsd : 0);
      if (spendable <= 0) continue;
      const tokenUsd = Math.min(spendable, needUsd - covered);
      const segs = gasCarried === 0 && gasUsd > 0 ? legsFrom(s, tokenUsd) : [leg("funding", s, sourceAmountFor(s, tokenUsd), need, tokenUsd)];
      if (!segs) continue;
      legs.push(...segs);
      if (gasCarried === 0 && gasUsd > 0) gasCarried = gasUsd;
      covered += tokenUsd;
      if (covered >= needUsd) break;
    }
    if (covered >= needUsd && (gasUsd === 0 || gasCarried > 0)) {
      options.push({
        kind: "combined",
        label: `Combine ${legs.length} legs (~$${usd2(totalNeedUsd)} total)`,
        legs,
        totalUsd: totalNeedUsd,
        yeetfulResume: resumeOf(legs),
      });
    }
  }

  if (options.length === 0) {
    return {
      kind: "short",
      needUsd: totalNeedUsd,
      gasUsd,
      totalUsd,
      sourcesSeen,
      note:
        (sourcesSeen ? `Movable funds seen: ${sourcesSeen}. ` : "No movable ETH or USDC seen. ") +
        `The smallest plan moves ~$${usd2(totalNeedUsd)} (solver fees${gasUsd > 0 ? " + a destination gas leg" : ""} included). Tell the user exactly this — an honest shortfall with numbers beats a dead end.`,
    };
  }
  return { kind: "offer", needUsd: totalNeedUsd, gasUsd, options: options.slice(0, 3), sourcesSeen };
}

// ── I/O: the scan + the full plan ───────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read movable ETH + USDC across the scan chains, one retry per chain.
 *  Throws only when NOTHING was readable. */
export async function scanFundingSources(user: `0x${string}`): Promise<FundingScan> {
  const px = await ethUsd();
  const sources: FundingSource[] = [];
  const readChains: string[] = [];
  const failedChains: string[] = [];
  await Promise.all(
    FUNDING_CHAINS.map(async (c) => {
      const client = clientFor(c.chainId);
      if (!client) return;
      const read = () =>
        Promise.all([
          client.getBalance({ address: user }),
          client.readContract({ address: c.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
        ]);
      try {
        const [nativeWei, usdcAtoms] = await read().catch(async () => {
          await sleep(400);
          return read();
        });
        readChains.push(c.word);
        const nativeEth = Number(formatEther(nativeWei));
        const usdcBal = Number(formatUnits(usdcAtoms, c.usdc.decimals));
        if (usdcBal > 0 && nativeEth >= c.minGasToSendEth) {
          sources.push({ chainId: c.chainId, chain: c.word, token: "USDC", balance: usdcBal, usd: usdcBal });
        }
        const movableEth = nativeEth - c.gasReserveEth;
        if (px && movableEth > 0) {
          sources.push({ chainId: c.chainId, chain: c.word, token: "ETH", balance: movableEth, usd: movableEth * px });
        }
      } catch {
        failedChains.push(c.word);
      }
    }),
  );
  if (readChains.length === 0) throw new Error("No funding-scan chain was readable — try again in a moment.");
  return { sources, readChains, failedChains };
}

export interface PlanFundingResult {
  plan: FundingPlan;
  scan: FundingScan;
  destinationGas: { floorEth: number; balanceEth: number; legNeeded: boolean };
  next: string;
}

/** The whole move: price the shortfall, check destination gas, scan, plan. */
export async function planFunding(user: `0x${string}`, need: FundingNeed): Promise<PlanFundingResult> {
  const dest = FUNDING_CHAINS.find((c) => c.chainId === need.chainId);
  if (!dest) {
    throw new Error(`Chain ${need.chainId} isn't a plannable destination (covered: ${FUNDING_CHAINS.map((c) => `${c.word}/${c.chainId}`).join(", ")}). Robinhood Chain funding rides the robinhood MCP's LiFi plan instead.`);
  }
  if (!(need.amount > 0)) throw new Error("`amount` must be the positive shortfall — how much MORE of the token must land on the destination.");

  const needToken = need.token.toUpperCase();
  const px = needToken === "USDC" || needToken === "USDT" || needToken === "DAI" || needToken === "USDG" ? 1 : needToken === "ETH" || needToken === "WETH" ? await ethUsd() : null;
  if (!px) {
    throw new Error(`Can't price ${need.token} to size the plan (this service prices ETH + major stables). Size the move yourself and call the NEAR Intents MCP directly.`);
  }

  const destClient = clientFor(need.chainId)!;
  const destNativeEth = Number(formatEther(await destClient.getBalance({ address: user })));
  let gasUsd = 0;
  const gasShort = needToken === "ETH" ? 0 : Math.max(0, dest.destGasFloorEth - destNativeEth);
  if (gasShort > 0) {
    const ethPx = await ethUsd();
    if (!ethPx) throw new Error("The destination wallet needs a gas leg but ETH is unpriceable right now — try again in a moment.");
    gasUsd = Math.max(MIN_GAS_LEG_USD, Math.ceil(gasShort * ethPx * 1.15 * 2) / 2);
  }

  const scan = await scanFundingSources(user);
  const needUsd = fundingPlanUsd(need.amount, px);
  const plan = planFundingOptions(need, needUsd, scan.sources, gasUsd);

  // A shortfall claim is only honest over chains that actually read.
  if (plan.kind === "short" && scan.failedChains.length > 0) {
    throw new Error(`Couldn't scan ${scan.failedChains.join("/")} — refusing to claim the wallet is short when part of it is unreadable. Try again in a moment.`);
  }

  const next =
    plan.kind === "offer"
      ? "Show the options to the user as choices. On their pick, execute the legs IN ORDER via the NEAR Intents MCP's build_swap (pass originChain/originToken/amount/destinationChain/destinationToken and the user's own address verbatim), wait for each settlement (check_status), then retry the original action. Never invent your own route, amounts, or addresses. In a Yeetful chat/embed, sending `yeetfulResume + \", then <the action>\"` runs the whole thing as one guarded job."
      : "Tell the user the honest shortfall with these numbers — what they hold, per chain, and what the smallest plan needs. Do not improvise an alternative route.";

  return { plan, scan, destinationGas: { floorEth: dest.destGasFloorEth, balanceEth: destNativeEth, legNeeded: gasUsd > 0 }, next };
}
