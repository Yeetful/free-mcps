import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { clip, gqlRequest, isEvmAddress, queries, type AaveResult } from "./aave";
import { builds } from "./tx";
import { ALLOWED_ROOT_FIELDS, guardQuery } from "./graphql-guard";

function present(result: AaveResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `AaveKit API error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

// The account address. Yeetful's planner substitutes the connected user's
// wallet as $USER_ADDRESS — "my positions" / "my earnings" resolve to this.
const userArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe(
    "EVM address (0x…) of the Aave account. For the CONNECTED USER's own portfolio/balances/history, pass their wallet address ($USER_ADDRESS).",
  );

const chainIdArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Chain id (default 1 = Ethereum mainnet, the only live Aave v4 chain today).");

const spokeAddressArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("The spoke (market) contract address — from `markets` or `reserves`.");

// Human-readable token amount as a decimal string ("100", "0.5") — the
// AaveKit API takes decimal amounts, not wei.
const amountArg = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .describe('Token amount as a decimal string in HUMAN units, e.g. "100" USDC or "0.5" WETH (not wei).');

const currencyArg = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("The underlying token (currency) address — `asset.address` from `reserves` or `portfolio`.");

/** Register the Aave market + portfolio + transaction-building tool surface. */
export function registerAaveTools(server: Server): void {
  // ── Market data ────────────────────────────────────────────────────────────
  server.registerTool(
    "markets",
    {
      title: "Aave Markets (Hubs + Spokes)",
      description:
        "Aave v4 market map: liquidity hubs (Core/Prime/…, with TVL + utilization) and the spokes (user-facing markets) connected to them. Answers 'what markets does Aave have?' — then pass a spoke address to `reserves` for its pools.",
      inputSchema: { chainId: chainIdArg },
    },
    async ({ chainId }) => present(await queries.markets({ chainId })),
  );

  server.registerTool(
    "reserves",
    {
      title: "Reserves (Pools)",
      description:
        "Aave v4 pool list with LIVE rates: supply APY, borrow APY, size (USD), caps, collateral factor, and supply/borrow/collateral flags per asset. Default = top pools chain-wide by size; filter with `spokeAddress` (one market) or `symbols` (['USDC','WETH']). Answers 'where can I earn on USDC?' / 'list Aave pools'. Use the returned asset.address + spokeAddress with the build_* tools.",
      inputSchema: {
        spokeAddress: spokeAddressArg.optional(),
        symbols: z
          .preprocess(
            (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
            z.array(z.string()).max(20).optional(),
          )
          .describe('Asset symbol filter, e.g. ["USDC","WETH"] (or "USDC,WETH").'),
        chainId: chainIdArg,
        first: z.number().int().min(1).max(100).optional().describe("How many to return (default 30, max 100)."),
      },
    },
    async ({ spokeAddress, symbols, chainId, first }) =>
      present(await queries.reserves({ spokeAddress, symbols, chainId, first })),
  );

  // ── Account views ──────────────────────────────────────────────────────────
  server.registerTool(
    "portfolio",
    {
      title: "Portfolio",
      description:
        "Full Aave v4 account view for an address: per-market positions (net balance, net APY, HEALTH FACTOR, max/remaining borrowing power), every supply with EARNED INTEREST, and every borrow with accrued debt. This is the 'show my Aave position / what am I earning?' tool. Empty positions → suggest `balances` (what they could supply) + `reserves` (where).",
      inputSchema: { user: userArg, chainId: chainIdArg },
    },
    async ({ user, chainId }) => present(await queries.portfolio({ user, chainId })),
  );

  server.registerTool(
    "balances",
    {
      title: "Wallet Balances (supplyable)",
      description:
        "Aave-listed tokens a wallet HOLDS (not yet deposited), each with its USD value and the best available supply APY — 'what could I put to work on Aave?'. Follow up with build_supply to prepare the deposit.",
      inputSchema: { user: userArg, chainId: chainIdArg },
    },
    async ({ user, chainId }) => present(await queries.balances({ user, chainId })),
  );

  server.registerTool(
    "activities",
    {
      title: "Account Activity",
      description:
        "Recent Aave v4 history for an address — supplies, borrows, repays, withdrawals with amounts, market, timestamp, and tx hash. Paginated: pass back `nextCursor` for older items.",
      inputSchema: {
        user: userArg,
        chainId: chainIdArg,
        cursor: z.string().optional().describe("Pagination cursor from a previous call's nextCursor."),
      },
    },
    async ({ user, chainId, cursor }) => present(await queries.activities({ user, chainId, cursor })),
  );

  // ── Simulation ─────────────────────────────────────────────────────────────
  server.registerTool(
    "preview",
    {
      title: "Preview Position After Action",
      description:
        "Simulate a supply/borrow/withdraw/repay BEFORE building it: health factor now vs after, net APY, net collateral, remaining borrowing power, and the pool's rates after the action. Nothing is built or signed. Use this before build_borrow / a large build_withdraw so the user sees the health-factor impact first; a full repay shows '∞ (no debt)'.",
      inputSchema: {
        action: z.enum(["supply", "borrow", "withdraw", "repay"]).describe("The action to simulate."),
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        amount: amountArg.optional().describe("Amount to simulate — omit with max:true (withdraw/repay only)."),
        max: z.boolean().optional().describe("Simulate the maximum (withdraw all / repay everything)."),
        user: userArg.describe("The wallet the action would run as — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
      },
    },
    async (args) => {
      if (!args.max && !args.amount) return fail("Pass `amount` or `max:true`.");
      if (args.max && (args.action === "supply" || args.action === "borrow"))
        return fail("`max` only applies to withdraw/repay — pass an explicit amount.");
      return present(await builds.preview(args));
    },
  );

  // ── Transaction building (construction-only — the USER signs) ─────────────
  registerBuildTools(server);

  server.registerTool(
    "check_transaction",
    {
      title: "Check Transaction Indexed",
      description:
        "After the user's wallet sends a prepared transaction, confirm Aave has processed it (true = indexed, portfolio data is current). Use this to complete a multi-step flow before re-reading the portfolio.",
      inputSchema: {
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The transaction hash the wallet returned."),
        operation: z
          .enum(["SPOKE_SUPPLY", "SPOKE_BORROW", "SPOKE_WITHDRAW", "SPOKE_REPAY"])
          .describe("Which operation the transaction performed."),
      },
    },
    async ({ txHash, operation }) =>
      present(
        await gqlRequest(
          `query($request: HasProcessedKnownTransactionRequest!) { hasProcessedKnownTransaction(request: $request) }`,
          { request: { operations: [operation], txHash } },
        ),
      ),
  );

  // ── Escape hatch ───────────────────────────────────────────────────────────
  server.registerTool(
    "graphql_query",
    {
      title: "Raw GraphQL Query (read-only)",
      description: [
        "Escape hatch: run any READ-ONLY query against the official AaveKit v4 GraphQL API (api.v4.aave.com) for data the other tools don't cover — e.g. reserve holders, EUR-denominated summaries, incentives.",
        `Allowed root fields: ${[...ALLOWED_ROOT_FIELDS].join(", ")}.`,
        "Notes: most fields take a single `request` input object; amounts are objects like {value} and percentages {value (fraction), normalized (percent)}; unions (userBalances.balances, activities.items) need `... on Type` inline fragments; introspection is disabled upstream but error messages suggest valid fields. Responses truncated ~24k chars.",
      ].join("\n"),
      inputSchema: {
        query: z.string().min(10).describe("The GraphQL query text (a single `query` operation)."),
        variables: z
          .preprocess(
            // Planners often pass variables as a JSON string — accept both.
            (v) => {
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v;
              }
            },
            z.record(z.unknown()).optional(),
          )
          .describe('Variables as an object (or JSON string), e.g. {"request":{"query":{"chainIds":[1]}}}.'),
      },
    },
    async ({ query, variables }) => {
      const guard = guardQuery(query);
      if (!guard.ok) return fail(`Request rejected: ${guard.error}`);
      return present(await gqlRequest(query, (variables as Record<string, unknown>) ?? {}));
    },
  );
}

// ── Build tools (split out for readability; same registration pass) ─────────

function registerBuildTools(server: Server): void {
  const sharedNote =
    "Returns UNSIGNED transaction step(s) {action:'send_transaction', tx:{to,data,value,chainId}} for the USER's wallet — an ERC-20 approve step first when allowance is short. Nothing is signed or submitted by this service.";

  server.registerTool(
    "build_supply",
    {
      title: "Build Supply (Deposit)",
      description: `Prepare an Aave v4 SUPPLY: deposit a token into a spoke's pool to start earning its supply APY (optionally as collateral). ${sharedNote} Get spokeAddress + the token's address from \`reserves\` or \`balances\`.`,
      inputSchema: {
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        amount: amountArg,
        user: userArg.describe(
          "The wallet that supplies and signs — $USER_ADDRESS for the connected user.",
        ),
        chainId: chainIdArg,
      },
    },
    async (args) => {
      if (!isEvmAddress(args.user)) return fail("`user` must be a 0x… address.");
      return present(await builds.supply(args));
    },
  );

  server.registerTool(
    "build_withdraw",
    {
      title: "Build Withdraw",
      description: `Prepare an Aave v4 WITHDRAW: pull a supplied token back to the wallet (pass max:true to withdraw everything, accrued interest included). ${sharedNote}`,
      inputSchema: {
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        amount: amountArg.optional().describe('Amount to withdraw — omit with max:true for "withdraw all".'),
        max: z.boolean().optional().describe("Withdraw the full balance (overrides amount)."),
        user: userArg.describe("The wallet that withdraws and signs — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
      },
    },
    async (args) => {
      if (!args.max && !args.amount) return fail("Pass `amount` or `max:true`.");
      return present(await builds.withdraw(args));
    },
  );

  server.registerTool(
    "build_borrow",
    {
      title: "Build Borrow",
      description: `Prepare an Aave v4 BORROW against the user's supplied collateral. Check \`portfolio\` first for remainingBorrowingPower and warn if the resulting health factor looks tight. ${sharedNote}`,
      inputSchema: {
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        amount: amountArg,
        user: userArg.describe("The wallet that borrows and signs — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
      },
    },
    async (args) => present(await builds.borrow(args)),
  );

  server.registerTool(
    "build_repay",
    {
      title: "Build Repay",
      description: `Prepare an Aave v4 REPAY of borrowed debt (pass max:true to clear the debt in full, accrued interest included). ${sharedNote}`,
      inputSchema: {
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        amount: amountArg.optional().describe('Amount to repay — omit with max:true for "repay everything".'),
        max: z.boolean().optional().describe("Repay the full outstanding debt (overrides amount)."),
        user: userArg.describe("The wallet that repays and signs — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
      },
    },
    async (args) => {
      if (!args.max && !args.amount) return fail("Pass `amount` or `max:true`.");
      return present(await builds.repay(args));
    },
  );

  server.registerTool(
    "build_collateral_toggle",
    {
      title: "Build Collateral Toggle",
      description: `Prepare a transaction that enables or disables a SUPPLIED token as collateral on a spoke. Disabling can drop the health factor — run \`preview\` context first when debt exists. ${sharedNote}`,
      inputSchema: {
        spokeAddress: spokeAddressArg,
        currency: currencyArg,
        enable: z.boolean().describe("true = use as collateral, false = stop using as collateral."),
        user: userArg.describe("The wallet that signs — $USER_ADDRESS for the connected user."),
        chainId: chainIdArg,
      },
    },
    async (args) => present(await builds.setCollateral(args)),
  );
}

// Kept in sync with the flagship tool above — the Bazaar discovery extension
// validates this JSON Schema.
export const PRIMARY_TOOL = {
  name: "portfolio",
  description:
    "Full Aave v4 account view for an address: positions with health factor + borrowing power, supplies with earned interest, borrows with accrued debt. Other tools: markets, reserves (pools + live APYs), balances (supplyable wallet tokens), activities, preview (health factor AFTER a hypothetical action), build_supply/build_withdraw/build_borrow/build_repay/build_collateral_toggle (unsigned txs the user signs — user = \"$USER_ADDRESS\" for the connected user), check_transaction, graphql_query (read-only escape hatch).",
  inputSchema: {
    type: "object",
    properties: {
      user: {
        type: "string",
        description: "EVM address (0x…) of the Aave account — $USER_ADDRESS for the connected user.",
      },
    },
    required: ["user"],
    additionalProperties: false,
  },
  example: { user: "0x0000000000000000000000000000000000000000" },
} as const;
