import { describe, it, expect } from "vitest";
import { buildRunbook, PRIMARY_TOOL } from "@/lib/runbook";
import type { FundingOption } from "@/lib/plan";

const option: FundingOption = {
  kind: "just-enough",
  label: "Just enough (~$18 of USDC on Base)",
  legs: [
    {
      purpose: "gas",
      originChain: "Base",
      originToken: "USDC",
      amount: "1.5",
      destinationChain: "Arbitrum",
      destinationToken: "ETH",
      approxUsd: 1.5,
    },
    {
      purpose: "funding",
      originChain: "Base",
      originToken: "USDC",
      amount: "16.5",
      destinationChain: "Arbitrum",
      destinationToken: "USDC",
      approxUsd: 16.5,
    },
  ],
  totalUsd: 18,
  yeetfulResume:
    "Swap 1.5 USDC from Base to ETH on Arbitrum, then Swap 16.5 USDC from Base to USDC on Arbitrum",
};

describe("buildRunbook", () => {
  it("emits build → notify → await per leg, then the follow-up action, numbered in order", () => {
    const steps = buildRunbook(option, "supply 15 USDC to Aave on Arbitrum");

    // 2 legs × 3 steps + 1 act.
    expect(steps).toHaveLength(7);
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(steps.map((s) => s.kind)).toEqual([
      "build", "notify", "await",
      "build", "notify", "await",
      "act",
    ]);

    // Leg params are the plan's legs VERBATIM, from is the placeholder — this
    // service never writes addresses.
    const firstBuild = steps[0]!;
    expect(firstBuild.tool).toBe("build_swap");
    expect(firstBuild.params).toEqual({
      originChain: "Base",
      originToken: "USDC",
      destinationChain: "Arbitrum",
      destinationToken: "ETH",
      amount: "1.5",
      from: "$USER_ADDRESS",
    });
    expect(firstBuild.note).toContain("Gas leg");
    expect(steps[3]!.note).not.toContain("Gas leg");

    // The finale carries the caller's own action.
    expect(steps[6]!.tool).toBeUndefined();
    expect(steps[6]!.note).toContain("supply 15 USDC to Aave on Arbitrum");
  });

  it("without finalAction the finale says to retry the refused action", () => {
    const steps = buildRunbook(option);
    expect(steps[steps.length - 1]!.note).toContain("retry the original action");
  });
});

describe("PRIMARY_TOOL discovery subject", () => {
  it("is fund_and_build with a plain-JSON-Schema input (required fields present)", () => {
    expect(PRIMARY_TOOL.name).toBe("fund_and_build");
    const schema = PRIMARY_TOOL.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toEqual(["user", "chain", "token", "amount"]);
    expect(Object.keys(schema.properties ?? {})).toContain("finalAction");
  });
});
