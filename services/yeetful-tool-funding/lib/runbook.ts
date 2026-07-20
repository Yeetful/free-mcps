// The runbook: turn a funding option into the exact ordered tool-call list an
// agent executes — the "agent-executable program" half of fund_and_build.
//
// PURE and edge-safe: imports only TYPES from plan.ts (no viem, no I/O) so the
// service's proxy.ts can import PRIMARY_TOOL for Bazaar discovery without
// dragging the RPC stack into Next middleware.
//
// Doctrine unchanged from plan_funding: every leg executes via the NEAR
// Intents MCP's build_swap with these params VERBATIM and the user's own
// address — this service never writes calldata, deposit addresses, or venues.

import type { FundingOption } from "./plan";

export interface RunbookStep {
  step: number;
  /** build → sign+broadcast · notify → optional speed-up · await → poll until
   *  settled · act → the follow-up the funding was FOR. */
  kind: "build" | "notify" | "await" | "act";
  /** Tool on the NEAR Intents MCP (near-intents.yeetful.com/mcp). Absent on
   *  the final `act` step — that one belongs to whatever layer refused. */
  tool?: "build_swap" | "submit_deposit_tx" | "await_completion";
  params?: Record<string, unknown>;
  note: string;
}

/** Ordered, numbered steps for ONE funding option. Three steps per leg
 *  (build → notify → await), then the follow-up action. */
export function buildRunbook(option: FundingOption, finalAction?: string): RunbookStep[] {
  const steps: RunbookStep[] = [];
  let n = 0;
  for (const leg of option.legs) {
    steps.push({
      step: ++n,
      kind: "build",
      tool: "build_swap",
      params: {
        originChain: leg.originChain,
        originToken: leg.originToken,
        destinationChain: leg.destinationChain,
        destinationToken: leg.destinationToken,
        amount: leg.amount,
        from: "$USER_ADDRESS",
      },
      note: `${leg.purpose === "gas" ? "Gas leg — lands native ETH so the follow-up is signable. " : ""}Call build_swap with these params verbatim. Sign the returned deposit transfer with the user's own wallet and broadcast it — the deposit address comes from the tool's response, NEVER from you.`,
    });
    steps.push({
      step: ++n,
      kind: "notify",
      tool: "submit_deposit_tx",
      note: "Optional but recommended: once the deposit transfer confirms, submit its tx hash (with the deposit address from step " + (n - 1) + ") so settlement starts immediately.",
    });
    steps.push({
      step: ++n,
      kind: "await",
      tool: "await_completion",
      note: "Wait for this leg to settle on the destination before starting the next step — legs are ordered for a reason (gas before funds; funds before the action).",
    });
  }
  steps.push({
    step: ++n,
    kind: "act",
    note: finalAction
      ? `Funds have landed — now do the thing this was for: ${finalAction}`
      : "Funds have landed — retry the original action that refused on insufficient funds.",
  });
  return steps;
}

/** The paid door's Bazaar discovery subject: fund_and_build, hand-written
 *  JSON Schema (discovery wants plain JSON Schema, not zod). */
export const PRIMARY_TOOL = {
  name: "fund_and_build",
  description:
    "One call from 'insufficient funds' to an executable program: scans the wallet's movable ETH + USDC across Base/Arbitrum/Ethereum, plans the cheapest cross-chain funding move for the shortfall (destination gas leg included), and returns a numbered runbook of exact tool calls — build each leg via the NEAR Intents MCP, sign with your own key, await settlement, then perform the follow-up action. Construction-only: never signs, never holds funds.",
  inputSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "The wallet to plan for (the agent's or user's own address).",
      },
      chain: {
        type: "string",
        description: "Destination chain — name or EVM chainId (base/8453, arbitrum/42161, ethereum/1).",
      },
      token: {
        type: "string",
        description: 'Token that must LAND on the destination ("ETH", "USDC", …).',
      },
      amount: {
        type: "number",
        exclusiveMinimum: 0,
        description: "The SHORTFALL in token units (needed minus held).",
      },
      finalAction: {
        type: "string",
        description: "Optional: the action the funding is FOR, echoed into the runbook's last step.",
      },
    },
    required: ["user", "chain", "token", "amount"],
  } as Record<string, unknown>,
  example: {
    user: "0x66268791B55e1F5fA585D990326519F101407257",
    chain: "arbitrum",
    token: "USDC",
    amount: 12,
    finalAction: "supply 12 USDC to Aave on Arbitrum",
  },
};
