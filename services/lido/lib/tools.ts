import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { clip, type LidoResult } from "./lido-api";
import { reads } from "./reads";
import { builds } from "./tx";

function present(result: LidoResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result.data === "string" ? result.data : `Lido service error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my position" / "my staking earnings" resolve
// to this.
const userArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the account. For the CONNECTED USER's own position/earnings/withdrawals, pass their wallet address ($USER_ADDRESS).",
  );

// Human-readable token amount as a decimal string ("1", "0.5") — never wei.
const amountArg = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .describe('Token amount as a decimal string in HUMAN units, e.g. "0.5" ETH or "10" stETH (not wei).');

const asUser = (s: string) => s as `0x${string}`;

/** Register the Lido stats + position + earnings + transaction-building tool surface. */
export function registerLidoTools(server: Server): void {
  // ── Protocol data ──────────────────────────────────────────────────────────
  server.registerTool(
    "stats",
    {
      title: "Lido Protocol Stats",
      description:
        "Lido protocol snapshot on Ethereum: staking APR (7-day average + latest daily), total ETH staked, the live stETH↔wstETH rate, the current stake-rate limit, stETH USD price, and withdrawal-queue state. Answers 'what's the Lido staking APR?' / 'how much ETH is staked with Lido?'.",
      inputSchema: {},
    },
    async () => present(await reads.stats()),
  );

  server.registerTool(
    "convert",
    {
      title: "Convert ETH / stETH / wstETH",
      description:
        "Convert an amount between ETH, stETH, and wstETH at the live on-chain rate — 'how much wstETH is 5 stETH?'. ETH↔stETH is 1:1 at the protocol; the wstETH leg uses stEthPerToken.",
      inputSchema: {
        amount: amountArg,
        from: z.enum(["ETH", "stETH", "wstETH"]).describe("The unit the amount is in."),
        to: z.enum(["ETH", "stETH", "wstETH"]).describe("The unit to convert into."),
      },
    },
    async ({ amount, from, to }) => present(await reads.convert({ amount, from, to })),
  );

  // ── Account views ──────────────────────────────────────────────────────────
  server.registerTool(
    "position",
    {
      title: "Lido Position",
      description:
        "Full Lido staking position for an address: ETH / stETH / wstETH balances (wstETH also shown at its current stETH value), total staked with USD value, the current APR it's earning, and any withdrawal requests in flight. This is the 'show my Lido position / how much do I have staked?' tool. For what the position has EARNED, use `earnings`.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => present(await reads.position(asUser(user))),
  );

  server.registerTool(
    "earnings",
    {
      title: "Staking Earnings",
      description:
        "Lido staking EARNINGS for an address, from the protocol's reward history: lifetime rewards in stETH and USD, the average APR actually earned, and the recent daily rebase events (date, reward, running balance, that day's APR). This is the 'what have I earned staking? / show my Lido rewards' tool. Note: wstETH holders earn via the rising stETH/wstETH rate, not rebases — `position` shows that value.",
      inputSchema: {
        user: userArg,
        limit: z.number().int().min(1).max(60).optional().describe("How many recent reward events to include (default 14 ≈ two weeks)."),
      },
    },
    async ({ user, limit }) => present(await reads.earnings({ user, limit })),
  );

  server.registerTool(
    "withdrawals",
    {
      title: "Withdrawal Requests",
      description:
        "Withdrawal-queue view for an address: every request NFT with its status (pending / claimable / claimed), amounts, the claimable ETH total, a wait-time estimate for pending requests, and overall queue depth. Answers 'where is my unstake? / can I claim yet?'. When something is claimable, follow with build_claim.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => present(await reads.withdrawals(asUser(user))),
  );

  // ── Transaction building (construction-only — never signs) ────────────────
  server.registerTool(
    "build_stake",
    {
      title: "Build: Stake ETH",
      description:
        "Prepare an UNSIGNED stake transaction: ETH into Lido. receive:'stETH' (default) mints rebasing stETH 1:1; receive:'wstETH' stakes and wraps in one transaction. Balance and the protocol's stake-rate limit are checked live before building. The user signs with their own wallet — this service never signs.",
      inputSchema: {
        user: userArg.describe("The wallet that stakes and receives the tokens — $USER_ADDRESS for the connected user."),
        amount: amountArg.describe('ETH amount to stake, e.g. "0.5".'),
        receive: z.enum(["stETH", "wstETH"]).optional().describe("Which token to receive (default stETH)."),
      },
    },
    async ({ user, amount, receive }) => present(await builds.stake({ user: asUser(user), amount, receive })),
  );

  server.registerTool(
    "build_wrap",
    {
      title: "Build: Wrap stETH → wstETH",
      description:
        "Prepare UNSIGNED transactions wrapping stETH into non-rebasing wstETH (for DeFi that can't handle rebases). Includes the stETH approval step only when the live allowance is short. Use max:true to wrap the full balance.",
      inputSchema: {
        user: userArg.describe("The wallet doing the wrap — $USER_ADDRESS for the connected user."),
        amount: amountArg.optional().describe("stETH amount to wrap — omit with max:true."),
        max: z.boolean().optional().describe("Wrap the wallet's entire stETH balance."),
      },
    },
    async ({ user, amount, max }) => present(await builds.wrap({ user: asUser(user), amount, max })),
  );

  server.registerTool(
    "build_unwrap",
    {
      title: "Build: Unwrap wstETH → stETH",
      description:
        "Prepare an UNSIGNED transaction unwrapping wstETH back into rebasing stETH (no approval needed). Use max:true to unwrap the full balance.",
      inputSchema: {
        user: userArg.describe("The wallet doing the unwrap — $USER_ADDRESS for the connected user."),
        amount: amountArg.optional().describe("wstETH amount to unwrap — omit with max:true."),
        max: z.boolean().optional().describe("Unwrap the wallet's entire wstETH balance."),
      },
    },
    async ({ user, amount, max }) => present(await builds.unwrap({ user: asUser(user), amount, max })),
  );

  server.registerTool(
    "build_request_withdrawal",
    {
      title: "Build: Request Withdrawal (unstake)",
      description:
        "Prepare UNSIGNED transactions starting a Lido exit: stETH (or wstETH with token:'wstETH') goes into the withdrawal queue and the wallet receives claimable request NFT(s); the ETH unlocks after finalization (hours to days — `withdrawals` shows the estimate). Amounts over the 1000-stETH per-request cap are split automatically. Approval step included only when the allowance is short. Use max:true to exit the full balance. For an INSTANT exit at market price, a DEX swap is the alternative.",
      inputSchema: {
        user: userArg.describe("The wallet exiting — $USER_ADDRESS for the connected user. It receives the request NFT(s) and, later, the ETH."),
        amount: amountArg.optional().describe("Amount to withdraw — omit with max:true."),
        max: z.boolean().optional().describe("Withdraw the wallet's entire balance of the chosen token."),
        token: z.enum(["stETH", "wstETH"]).optional().describe("Which token funds the withdrawal (default stETH)."),
      },
    },
    async ({ user, amount, max, token }) => present(await builds.requestWithdrawal({ user: asUser(user), amount, max, token })),
  );

  server.registerTool(
    "build_claim",
    {
      title: "Build: Claim Finalized Withdrawals",
      description:
        "Prepare an UNSIGNED claim transaction for EVERY finalized, unclaimed withdrawal request the address holds — the ETH lands in their wallet. Reads the queue live (request ids + checkpoint hints); if nothing is claimable yet it says so honestly instead of building.",
      inputSchema: {
        user: userArg.describe("The wallet that owns the withdrawal request NFT(s) — $USER_ADDRESS for the connected user."),
      },
    },
    async ({ user }) => present(await builds.claim({ user: asUser(user) })),
  );

}
