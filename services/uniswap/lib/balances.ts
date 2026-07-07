// ─────────────────────────────────────────────────────────────────────────
//  Wallet portfolio on Base — the read behind the "connected-wallet" splash.
//  Pure on-chain, zero-spend, no indexer, no key: native ETH via getBalance +
//  ERC-20 balanceOf over a curated Base token universe (Multicall3-batched by
//  the shared viem client), each nonzero holding priced to USD from the most
//  liquid Uniswap v3 pool (slot0 spot — no price-impact, no quoter simulation).
//  Callers may widen the universe with `extraTokens`.
// ─────────────────────────────────────────────────────────────────────────

import { ERC20_ABI, WETH, readRetry, rpc } from "./chain";
import { sqrtPriceToPrice, v3Pools } from "./quote";
import { formatAtoms, resolveToken, type TokenInfo } from "./tokens";

/** Curated Base token universe scanned for every wallet. Symbols resolve
 *  through the same path the swap tools use (static map → on-chain →
 *  official list), so this is just the default set to CHECK — not a
 *  hardcoded address list that can drift. */
const SCAN_SYMBOLS = [
  "USDC", "WETH", "DAI", "CBETH", "USDBC", "CBBTC", // the swap-tool knowns
  "AERO", "VIRTUAL", "DEGEN", "BRETT", "UNI", "LINK", "AAVE", "MORPHO", "WELL",
] as const;

/** USDC on Base — the unit of account for valuation. */
const USDC: TokenInfo = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };
const STABLES = new Set([USDC.address.toLowerCase(), "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" /*USDbC*/, "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" /*DAI*/]);

export interface Holding {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Human-unit balance, e.g. "1.27". */
  balance: string;
  /** Spot USD price per token, or null when no priced pool exists. */
  priceUsd: number | null;
  /** balance × priceUsd, or null when unpriced. */
  valueUsd: number | null;
  /** True for native ether (address is WETH but the holding is unwrapped ETH). */
  native?: boolean;
}

/** Spot price of `a` denominated in `b` (how many b per 1 a) from the most
 *  liquid live v3 pool, or null when no such pool exists. */
async function spotPrice(a: TokenInfo, b: TokenInfo): Promise<number | null> {
  if (a.address.toLowerCase() === b.address.toLowerCase()) return 1;
  const pools = await v3Pools(a, b);
  const live = pools.filter((p) => p.liquidity > 0n).sort((x, y) => (y.liquidity > x.liquidity ? 1 : -1));
  if (live.length === 0) return null;
  const top = live[0];
  const aIsToken0 = a.address.toLowerCase() < b.address.toLowerCase();
  const [t0, t1] = aIsToken0 ? [a, b] : [b, a];
  const price0in1 = Number(sqrtPriceToPrice(top.sqrtPriceX96, t0.decimals, t1.decimals));
  if (!Number.isFinite(price0in1) || price0in1 === 0) return null;
  return aIsToken0 ? price0in1 : 1 / price0in1;
}

/** USD value of one token: $1 for stables, WETH spot for ETH/WETH, else the
 *  token's spot to USDC, falling back through WETH. */
async function usdPrice(t: TokenInfo, wethUsd: number | null): Promise<number | null> {
  if (STABLES.has(t.address.toLowerCase())) return 1;
  if (t.address.toLowerCase() === WETH.toLowerCase()) return wethUsd;
  const direct = await spotPrice(t, USDC);
  if (direct !== null) return direct;
  if (wethUsd === null) return null;
  const viaWeth = await spotPrice(t, { address: WETH, symbol: "WETH", decimals: 18 });
  return viaWeth === null ? null : viaWeth * wethUsd;
}

export interface PortfolioResult {
  chainId: 8453;
  owner: `0x${string}`;
  totalUsd: number;
  /** Nonzero holdings, richest first. */
  holdings: Holding[];
  /** Symbols scanned but held at zero (context for the model, not display). */
  scanned: number;
  note?: string;
}

/**
 * Read a wallet's Base portfolio: native ETH + ERC-20 balances across the
 * curated universe (plus any `extraTokens`), priced to USD on-chain.
 * `owner` is the wallet to inspect ("$USER_ADDRESS" for the connected user,
 * substituted upstream to a real 0x address before this runs).
 */
export async function readPortfolio(owner: `0x${string}`, extraTokens: string[] = []): Promise<PortfolioResult> {
  // Resolve the scan universe (symbols → TokenInfo). Unknown/extra symbols that
  // fail to resolve are dropped rather than failing the whole portfolio.
  const symbols = [...new Set([...SCAN_SYMBOLS, ...extraTokens.map((s) => s.trim()).filter(Boolean)])];
  const resolved = (
    await Promise.all(symbols.map((s) => resolveToken(s).catch(() => null)))
  ).filter((t): t is TokenInfo => t !== null);
  // De-dupe by address (WETH known + WETH-from-list collide).
  const universe = [...new Map(resolved.map((t) => [t.address.toLowerCase(), t])).values()];

  // Balances: native ETH once, ERC-20 balanceOf for the rest (multicall-batched).
  const [ethAtoms, erc20] = await Promise.all([
    readRetry(() => rpc().getBalance({ address: owner })),
    Promise.all(
      universe.map(async (t) => {
        try {
          const bal = await readRetry(() =>
            rpc().readContract({ address: t.address, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
          );
          return { token: t, atoms: bal as bigint };
        } catch {
          return { token: t, atoms: 0n };
        }
      }),
    ),
  ]);

  // Price WETH first — it's the fallback route for everything unpriced to USDC.
  const wethInfo: TokenInfo = { address: WETH, symbol: "WETH", decimals: 18 };
  const wethUsd = await spotPrice(wethInfo, USDC);

  const raw: Array<{ token: TokenInfo; atoms: bigint; native?: boolean }> = erc20.filter((r) => r.atoms > 0n);
  if (ethAtoms > 0n) raw.unshift({ token: { ...wethInfo, symbol: "ETH", isNativeEth: true }, atoms: ethAtoms, native: true });

  const holdings: Holding[] = await Promise.all(
    raw.map(async ({ token, atoms, native }) => {
      const balance = formatAtoms(atoms, token.decimals);
      const priceUsd = native ? wethUsd : await usdPrice(token, wethUsd);
      const balanceNum = Number(atoms) / 10 ** token.decimals;
      const valueUsd = priceUsd === null ? null : Math.round(balanceNum * priceUsd * 100) / 100;
      return { symbol: token.symbol, address: token.address, decimals: token.decimals, balance, priceUsd, valueUsd, native };
    }),
  );
  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const totalUsd = Math.round(holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0) * 100) / 100;
  return {
    chainId: 8453,
    owner,
    totalUsd,
    holdings,
    scanned: universe.length,
    note: holdings.some((h) => h.valueUsd === null)
      ? "Some holdings have no priced Uniswap v3 pool on Base and are unvalued."
      : undefined,
  };
}
