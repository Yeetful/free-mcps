// ─────────────────────────────────────────────────────────────────────────
//  Reads: quotes, spot price, pool state — all pure on-chain (no upstream
//  API, no key). Quotes come from QuoterV2 via eth_call (its quote functions
//  are state-mutating by design and MUST be simulated, never sent). v4 state
//  is read through StateView with a computed poolId (hookless canonical
//  pools); v4 swap routing is a follow-up — v1 routes v3 liquidity.
// ─────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, keccak256, zeroAddress } from "viem";
import {
  FEE_TIERS,
  QUOTER_V2,
  QUOTER_V2_ABI,
  TICK_SPACING,
  V3_FACTORY,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V4_STATE_VIEW,
  V4_STATE_VIEW_ABI,
  WETH,
  readRetry,
  rpc,
} from "./chain";
import { formatAtoms, sortTokens, type TokenInfo } from "./tokens";

export interface TierQuote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
}

export interface BestQuote {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  best: TierQuote;
  /** Every tier that quoted (a tier with no pool / no liquidity is absent). */
  tiers: TierQuote[];
}

/** Quote exactIn across all v3 fee tiers concurrently; best = max amountOut.
 *  Throws with a readable message when NO tier can fill the trade. */
export async function bestV3Quote(tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<BestQuote> {
  const results = await Promise.all(
    FEE_TIERS.map(async (fee): Promise<TierQuote | null> => {
      try {
        const { result } = await readRetry(() => rpc().simulateContract({
          address: QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee, sqrtPriceLimitX96: 0n }],
        }));
        const [amountOut, , , gasEstimate] = result;
        return amountOut > 0n ? { fee, amountOut, gasEstimate } : null;
      } catch {
        return null; // no pool / no liquidity at this tier
      }
    }),
  );
  const tiers = results.filter((t): t is TierQuote => t !== null).sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  if (tiers.length === 0) {
    throw new Error(
      `No Uniswap v3 pool on Base can fill ${tokenIn.symbol} → ${tokenOut.symbol} for this amount.`,
    );
  }
  return { tokenIn, tokenOut, amountIn, best: tiers[0], tiers };
}

/** Human-readable quote payload (atoms AND units — agents get both). */
export function presentQuote(q: BestQuote) {
  const inHuman = formatAtoms(q.amountIn, q.tokenIn.decimals);
  const outHuman = formatAtoms(q.best.amountOut, q.tokenOut.decimals);
  return {
    chainId: 8453,
    protocol: "uniswap-v3",
    sell: { token: q.tokenIn.symbol, address: q.tokenIn.address, atoms: q.amountIn.toString(), amount: inHuman },
    buy: { token: q.tokenOut.symbol, address: q.tokenOut.address, atoms: q.best.amountOut.toString(), amount: outHuman },
    feeTierBps: q.best.fee / 100,
    gasEstimate: q.best.gasEstimate.toString(),
    allTiers: q.tiers.map((t) => ({
      feeTierBps: t.fee / 100,
      amountOut: formatAtoms(t.amountOut, q.tokenOut.decimals),
    })),
    summary: `Swap ${inHuman} ${q.tokenIn.symbol} → ~${outHuman} ${q.tokenOut.symbol} on Uniswap v3 (Base, ${q.best.fee / 100}bps pool)`,
  };
}

/** sqrtPriceX96 → price of token0 in token1, decimals-adjusted. Returned as a
 *  decimal string via bigint math (no float drift on big numbers). */
export function sqrtPriceToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number, digits = 12): string {
  // price1per0 = (sqrtP^2 / 2^192) * 10^(dec0 - dec1)
  const SCALE = 10n ** BigInt(digits);
  const num = sqrtPriceX96 * sqrtPriceX96 * SCALE * 10n ** BigInt(dec0);
  const denom = (1n << 192n) * 10n ** BigInt(dec1);
  const scaled = num / denom; // price * 10^digits
  return formatAtoms(scaled, digits);
}

export interface V3PoolState {
  fee: number;
  pool: `0x${string}`;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

/** All existing v3 pools for a pair, with slot0 + liquidity. */
export async function v3Pools(a: TokenInfo, b: TokenInfo): Promise<V3PoolState[]> {
  const pools = await Promise.all(
    FEE_TIERS.map(async (fee): Promise<V3PoolState | null> => {
      const pool = await readRetry(() =>
        rpc().readContract({
          address: V3_FACTORY,
          abi: V3_FACTORY_ABI,
          functionName: "getPool",
          args: [a.address, b.address, fee],
        }),
      );
      if (pool === zeroAddress) return null;
      try {
        const [slot0, liquidity] = await readRetry(() =>
          Promise.all([
            rpc().readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
            rpc().readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" }),
          ]),
        );
        return { fee, pool, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity };
      } catch {
        return null;
      }
    }),
  );
  return pools.filter((p): p is V3PoolState => p !== null);
}

/** v4 poolId for a canonical HOOKLESS pool: keccak(abi.encode(poolKey)).
 *  v4 pairs against NATIVE ether (currency 0x0), not WETH — so WETH inputs
 *  also probe the native pool. Exported for tests. */
export function v4PoolId(
  currency0: `0x${string}`,
  currency1: `0x${string}`,
  fee: number,
  tickSpacing: number,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [currency0, currency1, fee, tickSpacing, zeroAddress],
    ),
  );
}

export interface V4PoolState {
  fee: number;
  poolId: `0x${string}`;
  native: boolean;
  sqrtPriceX96: bigint;
  tick: number;
  lpFee: number;
  liquidity: bigint;
}

/** Best-effort v4 canonical-pool state for a pair: probes hookless pools at
 *  the standard tiers, for both the ERC-20 pair and (when WETH is involved)
 *  the native-ether pair v4 actually uses. Read-only. */
export async function v4PoolStates(a: TokenInfo, b: TokenInfo): Promise<V4PoolState[]> {
  const pairs: Array<{ c0: `0x${string}`; c1: `0x${string}`; native: boolean }> = [];
  const [s0, s1] = sortTokens(a.address, b.address);
  pairs.push({ c0: s0, c1: s1, native: false });
  if (a.address === WETH || b.address === WETH) {
    const other = a.address === WETH ? b.address : a.address;
    pairs.push({ c0: zeroAddress, c1: other, native: true }); // native ETH sorts first
  }
  const probes = pairs.flatMap((p) =>
    FEE_TIERS.map(async (fee): Promise<V4PoolState | null> => {
      const poolId = v4PoolId(p.c0, p.c1, fee, TICK_SPACING[fee]);
      try {
        const [slot0, liquidity] = await readRetry(() =>
          Promise.all([
            rpc().readContract({ address: V4_STATE_VIEW, abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }),
            rpc().readContract({ address: V4_STATE_VIEW, abi: V4_STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] }),
          ]),
        );
        const [sqrtPriceX96, tick, , lpFee] = slot0;
        if (sqrtPriceX96 === 0n) return null; // uninitialized pool
        return { fee, poolId, native: p.native, sqrtPriceX96, tick: Number(tick), lpFee: Number(lpFee), liquidity };
      } catch {
        return null;
      }
    }),
  );
  return (await Promise.all(probes)).filter((p): p is V4PoolState => p !== null);
}
