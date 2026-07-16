import { describe, it, expect } from "vitest";
import { fundingPlanUsd, planFundingOptions, rankFundingSources, type FundingNeed, type FundingSource } from "@/lib/plan";

const need: FundingNeed = { chainId: 1, token: "ETH", amount: 0.005 };
const src = (chainId: number, chain: string, token: "ETH" | "USDC", usd: number, balance = token === "USDC" ? usd : usd / 3500): FundingSource => ({
  chainId,
  chain,
  token,
  balance,
  usd,
});

// These cases mirror the website harness (scripts/test-api.ts, website#445/#446)
// so both halves of the planner speak the same doctrine.
describe("funding planner (pure)", () => {
  it("sizes the need: shortfall × price + 10% + $1 flat, $0.50-rounded, $2 floor", () => {
    expect(fundingPlanUsd(0.005, 3500)).toBe(20.5);
    expect(fundingPlanUsd(0.2, 1)).toBe(2);
  });

  it("ranks same-token sources over stables over ETH, richest first", () => {
    const ranked = rankFundingSources(need, [src(8453, "Base", "USDC", 50), src(42161, "Arbitrum", "ETH", 40), src(8453, "Base", "ETH", 90)]);
    expect(ranked.map((s) => `${s.token}:${s.chain}`)).toEqual(["ETH:Base", "ETH:Arbitrum", "USDC:Base"]);
  });

  it("a covering source offers just-enough (+ all-of when sensible)", () => {
    const plan = planFundingOptions(need, 20.5, [src(8453, "Base", "USDC", 60)]);
    expect(plan.kind).toBe("offer");
    if (plan.kind !== "offer") return;
    expect(plan.options.map((o) => o.kind)).toEqual(["just-enough", "all-of-source"]);
    expect(plan.options[0].legs).toHaveLength(1);
    expect(plan.options[0].legs[0]).toMatchObject({ purpose: "funding", originChain: "Base", originToken: "USDC", destinationChain: "Ethereum", destinationToken: "ETH" });
    expect(plan.options[0].yeetfulResume).toBe("Swap 20.5 USDC from Base to ETH on Ethereum");
  });

  it("caps the all-of-source option at 10× the need (no $15k moves for a $20 gap)", () => {
    const plan = planFundingOptions(need, 20.5, [src(8453, "Base", "USDC", 15_000)]);
    expect(plan.kind).toBe("offer");
    if (plan.kind !== "offer") return;
    expect(plan.options.map((o) => o.kind)).toEqual(["just-enough"]);
  });

  it("never uses destination-chain balances as sources", () => {
    const plan = planFundingOptions(need, 20.5, [src(1, "Ethereum", "USDC", 60)]);
    expect(plan.kind).toBe("short");
  });

  it("combines chains when no single source covers it", () => {
    const plan = planFundingOptions(need, 20.5, [src(8453, "Base", "USDC", 12), src(42161, "Arbitrum", "USDC", 11)]);
    expect(plan.kind).toBe("offer");
    if (plan.kind !== "offer") return;
    expect(plan.options[0].kind).toBe("combined");
    expect(plan.options[0].legs.map((l) => l.originChain)).toEqual(["Base", "Arbitrum"]);
  });

  it("prepends a destination gas leg to every option when gasUsd > 0", () => {
    const usdcNeed: FundingNeed = { chainId: 1, token: "USDC", amount: 17 };
    const plan = planFundingOptions(usdcNeed, 20, [src(8453, "Base", "USDC", 60)], 7);
    expect(plan.kind).toBe("offer");
    if (plan.kind !== "offer") return;
    expect(plan.needUsd).toBe(27);
    expect(plan.options[0].legs.map((l) => l.purpose)).toEqual(["gas", "funding"]);
    expect(plan.options[0].legs[0].destinationToken).toBe("ETH");
    expect(plan.options[0].legs[1].destinationToken).toBe("USDC");
    expect(plan.options[0].yeetfulResume).toBe("Swap 7 USDC from Base to ETH on Ethereum, then Swap 20 USDC from Base to USDC on Ethereum");
  });

  it("a source covering the tokens but not the gas leg is honestly short", () => {
    const usdcNeed: FundingNeed = { chainId: 1, token: "USDC", amount: 17 };
    const plan = planFundingOptions(usdcNeed, 20, [src(8453, "Base", "USDC", 22)], 7);
    expect(plan.kind).toBe("short");
    if (plan.kind !== "short") return;
    expect(plan.needUsd).toBe(27);
  });

  it("reports an honest shortfall with dust ignored", () => {
    const plan = planFundingOptions(need, 20.5, [src(8453, "Base", "USDC", 3), src(42161, "Arbitrum", "ETH", 0.3)]);
    expect(plan.kind).toBe("short");
    if (plan.kind !== "short") return;
    expect(plan.totalUsd).toBe(3);
    expect(plan.note).toContain("$20.50");
  });
});
