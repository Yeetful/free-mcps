import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { ethUsd, FUNDING_CHAINS } from "./chains";
import { planFunding, scanFundingSources } from "./plan";
import { buildRunbook } from "./runbook";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded<T>(run: () => Promise<T> | T) {
  try {
    return ok(await run());
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Call failed.");
  }
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const CHAIN_LIST = FUNDING_CHAINS.map((c) => `${c.word} (${c.chainId})`).join(", ");

const userArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe(
    'The wallet to plan for — for the connected user ALWAYS pass "$USER_ADDRESS"; never guess or reuse an address from conversation. Read-only: planning needs no signature.',
  );

/** Register the funding-planner tool surface. */
export function registerFundingTools(server: Server): void {
  server.registerTool(
    "chains",
    {
      title: "Covered Chains",
      description: `The chains this planner scans as funding sources and plans onto as destinations (${CHAIN_LIST}). Robinhood Chain funding rides the robinhood MCP's LiFi plan instead. Free, instant.`,
      inputSchema: {},
    },
    async () =>
      guarded(() => ({
        chains: FUNDING_CHAINS.map((c) => ({ chainId: c.chainId, name: c.word, destGasFloorEth: c.destGasFloorEth })),
        note: "scan_funding_sources reads all of them in one call; plan_funding takes any of them as the destination.",
      })),
  );

  server.registerTool(
    "scan_funding_sources",
    {
      title: "Scan Movable Funds (all chains)",
      description:
        'Where a wallet\'s movable money sits: ETH + USDC across the covered chains in one call, gas-reserve aware (an ETH balance is only "movable" above what the transfer itself costs; USDC only counts where the wallet also holds gas to sign). Call when an action failed on insufficient balance and you want to see what could fund it — then call plan_funding to turn it into an executable plan. failedChains means UNKNOWN, never empty: do not tell the user a failed chain holds nothing. Pass user="$USER_ADDRESS" for the connected user.',
      inputSchema: { user: userArg },
    },
    async ({ user }) => guarded(() => scanFundingSources(user as `0x${string}`)),
  );

  server.registerTool(
    "plan_funding",
    {
      title: "Plan a Cross-Chain Funding Move",
      description:
        "THE answer when any build/action refuses on insufficient funds (\"needs 20 USDC on Arbitrum but the wallet holds 3\"): turn the shortfall into an executable cross-chain funding plan instead of a dead end. Input = the destination chain, the token that must land there, and the SHORTFALL amount (needed minus held — not the full ask). Returns ranked options of ordered legs (same-token first, then stables; a native-ETH gas leg is prepended automatically when the destination wallet can't pay for the follow-up action — funds that land where the wallet can't sign are stranded). Execute each leg IN ORDER via the NEAR Intents MCP's build_swap with these exact params and the user's own address, wait for settlement, then retry the original action. NEVER invent routes, amounts, or deposit addresses yourself. Construction-only: this tool reads balances and prices; it cannot sign, submit, or move anything. Pass user=\"$USER_ADDRESS\" for the connected user.",
      inputSchema: {
        user: userArg,
        chain: z.string().describe(`Destination chain — name or EVM chainId (${CHAIN_LIST}).`),
        token: z.string().describe('The token that must LAND on the destination ("ETH", "USDC", …). ETH + major stables are priceable; anything else, size the move yourself.'),
        amount: z.number().positive().describe("The SHORTFALL in token units: how much more must land there (needed minus currently held)."),
      },
    },
    async ({ user, chain, token, amount }) =>
      guarded(async () => {
        const dest = FUNDING_CHAINS.find((c) => String(c.chainId) === chain.trim() || c.word.toLowerCase() === chain.trim().toLowerCase() || c.key === chain.trim().toLowerCase());
        if (!dest) throw new Error(`Unknown destination "${chain}" — covered: ${CHAIN_LIST}. (Robinhood Chain funding rides the robinhood MCP's LiFi plan.)`);
        return planFunding(user as `0x${string}`, { chainId: dest.chainId, token, amount });
      }),
  );

  server.registerTool(
    "fund_and_build",
    {
      title: "Fund & Build (one-call runbook)",
      description:
        "The ONE-CALL composite for agents that can sign but can't orchestrate: scan + plan + an executable RUNBOOK in a single response. Call when an action refused on insufficient funds and you want the exact ordered tool calls, not just a plan. Returns everything plan_funding returns PLUS `runbook.steps` — numbered steps naming the NEAR Intents MCP tool for each leg (build_swap with verbatim params → submit_deposit_tx → await_completion) and ending with your follow-up action. Execute the steps in order, signing each deposit transfer with the user's own wallet; deposit addresses come from build_swap's responses, NEVER invented. Pass the action the funding is for as `finalAction` so the last step says what to do once funds land. Construction-only: this tool reads and plans; it cannot sign, submit, or move anything. Pass user=\"$USER_ADDRESS\" for the connected user.",
      inputSchema: {
        user: userArg,
        chain: z.string().describe(`Destination chain — name or EVM chainId (${CHAIN_LIST}).`),
        token: z.string().describe('The token that must LAND on the destination ("ETH", "USDC", …).'),
        amount: z.number().positive().describe("The SHORTFALL in token units: how much more must land there (needed minus currently held)."),
        finalAction: z.string().max(300).optional().describe('Optional: the action this funding is FOR ("supply 12 USDC to Aave on Arbitrum") — echoed into the runbook\'s final step and the yeetfulResume sentence.'),
      },
    },
    async ({ user, chain, token, amount, finalAction }) =>
      guarded(async () => {
        const dest = FUNDING_CHAINS.find((c) => String(c.chainId) === chain.trim() || c.word.toLowerCase() === chain.trim().toLowerCase() || c.key === chain.trim().toLowerCase());
        if (!dest) throw new Error(`Unknown destination "${chain}" — covered: ${CHAIN_LIST}. (Robinhood Chain funding rides the robinhood MCP's LiFi plan.)`);
        const result = await planFunding(user as `0x${string}`, { chainId: dest.chainId, token, amount });
        if (result.plan.kind === "short") return { ...result, runbook: null };
        const primary = result.plan.options[0]!;
        return {
          ...result,
          runbook: {
            option: primary.label,
            steps: buildRunbook(primary, finalAction),
            otherOptions: result.plan.options.slice(1).map((o) => o.label),
            yeetfulResume: finalAction ? `${primary.yeetfulResume}, then ${finalAction}` : primary.yeetfulResume,
          },
        };
      }),
  );

  server.registerTool(
    "eth_price",
    {
      title: "ETH/USD (planner's own read)",
      description: "The ETH/USD price this planner sizes gas legs with — one Uniswap v3 QuoterV2 staticcall on Base, no oracle, no key. Use to sanity-check a plan's dollar figures.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const usd = await ethUsd();
        if (!usd) throw new Error("ETH is unpriceable right now — try again in a moment.");
        return { ethUsd: Number(usd.toFixed(2)), via: "Uniswap v3 QuoterV2 WETH→USDC on Base" };
      }),
  );
}
