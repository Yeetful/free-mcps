import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { readPortfolio } from "./balances";
import { bestV3Quote, presentQuote, sqrtPriceToPrice, v3Pools, v4PoolStates } from "./quote";
import { executeRead, KNOWN_CONTRACTS, MAX_RESPONSE_CHARS } from "./read-guard";
import { buildSwap, buildUnwrap, buildWrap, MAX_SLIPPAGE_BPS } from "./swap";
import { formatAtoms, humanToAtoms, resolveToken } from "./tokens";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded<T>(run: () => Promise<T>) {
  try {
    return ok(await run());
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Call failed.");
  }
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const tokenArg = (side: string) =>
  z.string().describe(`${side} token — a Base symbol (USDC, WETH, ETH, DAI, cbETH, USDbC, cbBTC) or the token's 0x contract address (decimals are read on-chain). Never a wallet address.`);
const amountArg = z
  .string()
  .describe('Amount in HUMAN units of the sell token, e.g. "100" or "0.5". Converted with the token\'s real decimals — never pass atoms.');
const fromArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe(
    'The USER\'S OWN wallet address — the payer, and ALWAYS the swap recipient (this service never routes proceeds elsewhere). For the connected user pass "$USER_ADDRESS"; never guess or reuse an address from conversation.',
  );

/** Register the Uniswap tool surface. */
export function registerUniswapTools(server: Server): void {
  // ── Reads ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "quote",
    {
      title: "Uniswap Quote (Base)",
      description:
        "Live exact-in quote across every Uniswap v3 fee tier on Base, straight from QuoterV2 on-chain (no API key, no indexer lag). Returns the best tier, expected output in atoms AND human units, gas estimate, and what every other tier would give.",
      inputSchema: { sellToken: tokenArg("Sell"), buyToken: tokenArg("Buy"), amount: amountArg },
    },
    async ({ sellToken, buyToken, amount }) =>
      guarded(async () => {
        const [tin, tout] = await Promise.all([resolveToken(sellToken), resolveToken(buyToken)]);
        if (tin.address === tout.address) throw new Error("sellToken and buyToken must differ.");
        return presentQuote(await bestV3Quote(tin, tout, humanToAtoms(amount, tin.decimals)));
      }),
  );

  server.registerTool(
    "price",
    {
      title: "Spot Price (Base)",
      description:
        "Current spot price for a token pair from the most liquid Uniswap v3 pool on Base (slot0, decimals-adjusted). Both directions returned.",
      inputSchema: { baseToken: tokenArg("Base"), quoteToken: tokenArg("Quote") },
    },
    async ({ baseToken, quoteToken }) =>
      guarded(async () => {
        const [a, b] = await Promise.all([resolveToken(baseToken), resolveToken(quoteToken)]);
        if (a.address === b.address) throw new Error("Tokens must differ.");
        const pools = await v3Pools(a, b);
        const live = pools.filter((p) => p.liquidity > 0n).sort((x, y) => (y.liquidity > x.liquidity ? 1 : -1));
        if (live.length === 0) throw new Error(`No live Uniswap v3 pool for ${a.symbol}/${b.symbol} on Base.`);
        const top = live[0];
        // slot0 prices token0 in token1 — orient to the caller's pair.
        const aIsToken0 = a.address.toLowerCase() < b.address.toLowerCase();
        const [t0, t1] = aIsToken0 ? [a, b] : [b, a];
        const price0in1 = sqrtPriceToPrice(top.sqrtPriceX96, t0.decimals, t1.decimals);
        return {
          chainId: 8453,
          pool: top.pool,
          feeTierBps: top.fee / 100,
          liquidity: top.liquidity.toString(),
          price: {
            [`${t0.symbol}_in_${t1.symbol}`]: price0in1,
            note: `1 ${t0.symbol} = ${price0in1} ${t1.symbol} (most liquid pool, ${top.fee / 100}bps)`,
          },
        };
      }),
  );

  server.registerTool(
    "pool_info",
    {
      title: "Pool State v3 + v4 (Base)",
      description:
        "Every Uniswap pool for a pair on Base: v3 pools per fee tier (address, sqrtPriceX96, tick, in-range liquidity) AND canonical hookless v4 pools via StateView (v4 pairs WETH trades against native ETH — both are probed). Read-only.",
      inputSchema: { tokenA: tokenArg("First"), tokenB: tokenArg("Second") },
    },
    async ({ tokenA, tokenB }) =>
      guarded(async () => {
        const [a, b] = await Promise.all([resolveToken(tokenA), resolveToken(tokenB)]);
        if (a.address === b.address) throw new Error("Tokens must differ.");
        const [v3, v4] = await Promise.all([v3Pools(a, b), v4PoolStates(a, b)]);
        return {
          chainId: 8453,
          pair: `${a.symbol}/${b.symbol}`,
          v3: v3.map((p) => ({
            feeTierBps: p.fee / 100,
            pool: p.pool,
            sqrtPriceX96: p.sqrtPriceX96.toString(),
            tick: p.tick,
            liquidity: p.liquidity.toString(),
          })),
          v4: v4.map((p) => ({
            feeTierBps: p.fee / 100,
            poolId: p.poolId,
            pairsNativeEth: p.native,
            sqrtPriceX96: p.sqrtPriceX96.toString(),
            tick: p.tick,
            lpFeeBps: p.lpFee / 100,
            liquidity: p.liquidity.toString(),
          })),
        };
      }),
  );

  server.registerTool(
    "balances",
    {
      title: "Wallet Portfolio (Base)",
      description:
        "A wallet's Base portfolio in one call: native ETH + ERC-20 balances across a curated universe (USDC, WETH, DAI, cbETH, cbBTC, AERO, VIRTUAL, DEGEN, UNI, LINK, AAVE, MORPHO, …), each nonzero holding priced to USD from the most liquid Uniswap v3 pool on-chain (spot slot0 — no indexer, no key, no spend). Returns totalUsd and holdings sorted richest-first. Use to show a connected wallet what it holds, spot idle stablecoins, or pick a token to swap. Pass owner=\"$USER_ADDRESS\" for the connected user.",
      inputSchema: {
        owner: fromArg,
        extraTokens: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Extra Base tokens to also check, as symbols or 0x addresses, e.g. ["PEPE","0x…"]. The curated majors are always scanned.'),
      },
    },
    async ({ owner, extraTokens }) => guarded(() => readPortfolio(owner as `0x${string}`, extraTokens ?? [])),
  );

  // ── Builds (the user signs — this service never holds keys) ───────────────
  server.registerTool(
    "build_swap",
    {
      title: "Build Swap Transaction (Base)",
      description:
        "Turn a swap into the exact transaction to sign: fresh best-tier quote → amountOutMinimum minus your slippage bound → SwapRouter02 exactInputSingle inside multicall(deadline). Recipient is ALWAYS the payer. Returns {action:'send_transaction'} plus the ERC-20 approve step when allowance is short (native ETH in needs no approval), and an eth_call dry-run of the exact bytes. Nothing is signed or submitted.",
      inputSchema: {
        sellToken: tokenArg("Sell"),
        buyToken: tokenArg("Buy"),
        amount: amountArg,
        from: fromArg,
        slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).optional()
          .describe("Slippage tolerance in basis points (default 50 = 0.5%, max 500)."),
        deadlineSec: z.number().int().min(30).max(3600).optional()
          .describe("Seconds until the transaction expires (default 600)."),
      },
    },
    async ({ sellToken, buyToken, amount, from, slippageBps, deadlineSec }) =>
      guarded(() => buildSwap({ sellToken, buyToken, amount, from: from as `0x${string}`, slippageBps, deadlineSec })),
  );

  server.registerTool(
    "build_wrap",
    {
      title: "Wrap ETH → WETH (Base)",
      description: "Build the WETH deposit transaction (native ETH → WETH). Returns {action:'send_transaction'}.",
      inputSchema: { amount: amountArg, from: fromArg },
    },
    async ({ amount, from }) => guarded(async () => buildWrap(amount, from)),
  );

  server.registerTool(
    "build_unwrap",
    {
      title: "Unwrap WETH → ETH (Base)",
      description: "Build the WETH withdraw transaction (WETH → native ETH). Returns {action:'send_transaction'}.",
      inputSchema: { amount: amountArg, from: fromArg },
    },
    async ({ amount, from }) => guarded(async () => buildUnwrap(amount, from)),
  );

  // ── Escape hatch (read-only) ────────────────────────────────────────────────
  server.registerTool(
    "read_contract",
    {
      title: "Raw Contract Read (Base, read-only)",
      description: [
        `Escape hatch: ONE read-only eth_call against any contract on Base when the other tools lack the read — ERC-20 balanceOf/allowance/totalSupply, pool token0/token1/fee/liquidity/slot0, factory getPool, v4 getSlot0(poolId), quoter exact-OUTPUT simulations… Simulated via eth_call: it can never move funds, sign, or change state. Payable functions refused; responses truncated ~${MAX_RESPONSE_CHARS / 1000}k chars.`,
        `Named contracts (or pass any 0x address — pools, tokens): ${Object.entries(KNOWN_CONTRACTS).map(([n, a]) => `${n} ${a}`).join(" · ")}.`,
        'Args: JSON array in signature order — uint/int as numbers or decimal strings (atoms, use convert_amount first), addresses as 0x…, tuples as objects or arrays. When an argument must be the USER\'S OWN wallet (their balance, their allowance), pass "$USER_ADDRESS".',
        'Example — the user\'s USDC balance: contract "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", signature "function balanceOf(address) view returns (uint256)", args ["$USER_ADDRESS"].',
      ].join("\n"),
      inputSchema: {
        contract: z
          .string()
          .describe(`Target: a 0x address on Base, or a named contract (${Object.keys(KNOWN_CONTRACTS).join(", ")}).`),
        signature: z
          .string()
          .min(3)
          .max(400)
          .describe('Human-readable Solidity signature incl. returns, e.g. "function allowance(address owner, address spender) view returns (uint256)".'),
        args: z
          .preprocess(
            // Planners often pass args as a JSON string — accept both.
            (v) => {
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v;
              }
            },
            z.array(z.unknown()).max(12).optional(),
          )
          .describe('Arguments as a JSON array (or JSON string) in signature order, e.g. ["$USER_ADDRESS"]. Omit for zero-arg reads.'),
      },
    },
    async ({ contract, signature, args }) => guarded(() => executeRead({ contract, signature, args })),
  );

  // ── Free helper (schema hint for agents) ───────────────────────────────────
  server.registerTool(
    "convert_amount",
    {
      title: "Convert Human Amount ↔ Atoms",
      description:
        "Utility: convert a human amount to atoms for a token (decimals read on-chain for unknown addresses). Use when composing calls to other protocols.",
      inputSchema: { token: tokenArg("The"), amount: amountArg },
    },
    async ({ token, amount }) =>
      guarded(async () => {
        const t = await resolveToken(token);
        const atoms = humanToAtoms(amount, t.decimals);
        return { token: t.symbol, address: t.address, decimals: t.decimals, amount: formatAtoms(atoms, t.decimals), atoms: atoms.toString() };
      }),
  );
}

/** The tool the Bazaar discovery block advertises. */
export const PRIMARY_TOOL = {
  name: "quote",
  description:
    "Live Uniswap v3 exact-in quote on Base across every fee tier, direct from QuoterV2 on-chain — best tier, expected output, gas estimate. Other tools: price, pool_info, balances (a wallet's full Base portfolio priced to USD), build_swap/build_wrap/build_unwrap (unsigned txs the user signs — from = \"$USER_ADDRESS\" for the connected user), convert_amount, read_contract (read-only eth_call escape hatch for any Base contract).",
  inputSchema: {
    type: "object",
    properties: {
      sellToken: { type: "string", description: "Base symbol (USDC, WETH, ETH, …) or 0x address" },
      buyToken: { type: "string", description: "Base symbol or 0x address" },
      amount: { type: "string", description: 'Human units of the sell token, e.g. "100"' },
    },
    required: ["sellToken", "buyToken", "amount"],
  },
  example: {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "quote", arguments: { sellToken: "USDC", buyToken: "WETH", amount: "100" } },
  },
} as const;
