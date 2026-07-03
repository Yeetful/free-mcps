// ─────────────────────────────────────────────────────────────────────────
//  Token resolution + amount math. Well-known Base symbols resolve locally;
//  any 0x address resolves ON-CHAIN (decimals + symbol via eth_call, cached)
//  so amounts are always converted with the token's REAL decimals — an amount
//  is never model-guessed and never silently rounded.
//  'ETH' is native ether: it quotes/prices as WETH (that's the pool), and the
//  swap builder handles it via msg.value (see swap.ts).
// ─────────────────────────────────────────────────────────────────────────

import { getAddress, isAddress } from "viem";
import { ERC20_ABI, WETH, readRetry, rpc } from "./chain";

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /** True when the caller wrote 'ETH' — pools use WETH but the router can
   *  wrap msg.value, so the builder needs to know the intent was native. */
  isNativeEth?: boolean;
}

const KNOWN: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { address: WETH, decimals: 18 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  USDBC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
};

const onchainCache = new Map<string, TokenInfo>();

// Official Uniswap token list (tokens.uniswap.org) filtered to Base — cached
// 24h, so UNI/LINK/AAVE/… resolve without hand-typing addresses. Failure
// degrades to the static map + the helpful error.
let listCache: Record<string, TokenInfo> = {};
let listLoadedAt = 0;
async function officialListToken(upperSymbol: string): Promise<TokenInfo | undefined> {
  if (Date.now() - listLoadedAt > 24 * 60 * 60 * 1000 || Object.keys(listCache).length === 0) {
    try {
      const res = await fetch(process.env.TOKEN_LIST_URL || "https://tokens.uniswap.org", {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as { tokens?: { chainId: number; address: string; symbol: string; decimals: number }[] };
        const next: Record<string, TokenInfo> = {};
        for (const tok of json.tokens ?? []) {
          if (tok.chainId !== 8453 || !isAddress(tok.address) || !Number.isInteger(tok.decimals)) continue;
          const key = tok.symbol.toUpperCase();
          if (!next[key]) next[key] = { address: getAddress(tok.address), symbol: tok.symbol, decimals: tok.decimals };
        }
        if (Object.keys(next).length > 0) {
          listCache = next;
          listLoadedAt = Date.now();
        }
      }
    } catch {
      /* degrade */
    }
  }
  return listCache[upperSymbol];
}

/** Resolve a symbol or 0x address to token info. Unknown addresses are read
 *  on-chain (decimals + symbol) and cached; unknown symbols consult the
 *  official Uniswap Base token list before throwing. */
export async function resolveToken(input: string): Promise<TokenInfo> {
  const t = input.trim();
  const upper = t.toUpperCase();
  if (upper === "ETH") {
    return { address: WETH, symbol: "ETH", decimals: 18, isNativeEth: true };
  }
  const known = KNOWN[upper];
  if (known) return { address: known.address, symbol: upper, decimals: known.decimals };
  if (!isAddress(t)) {
    const dyn = await officialListToken(upper);
    if (dyn) return dyn;
    throw new Error(
      `Unknown token "${input}". Use a known Base symbol (${Object.keys(KNOWN).join(", ")}, ETH), any symbol on the official Uniswap Base list, or a 0x address.`,
    );
  }
  const addr = getAddress(t);
  const cached = onchainCache.get(addr);
  if (cached) return cached;
  const [decimals, symbol] = await readRetry(() =>
    Promise.all([
      rpc().readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
      rpc().readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => addr.slice(0, 8)),
    ]),
  );
  const info: TokenInfo = { address: addr, symbol: String(symbol), decimals: Number(decimals) };
  onchainCache.set(addr, info);
  return info;
}

/** Human decimal string → atoms. Refuses malformed input, zero, and more
 *  fractional digits than the token has (never round money silently). */
export function humanToAtoms(amount: string, decimals: number): bigint {
  const m = amount.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`"${amount}" is not a plain decimal amount (no exponents, no signs).`);
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) {
    throw new Error(`"${amount}" has more decimal places than the token supports (${decimals}).`);
  }
  const atoms = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (atoms <= 0n) throw new Error("Amount must be greater than zero.");
  return atoms;
}

/** Atoms → trimmed human string ("100", "0.0636"). Tiny-but-nonzero never
 *  renders as "0" — this string ends up on approval surfaces. */
export function formatAtoms(atoms: bigint, decimals: number, maxFractionDigits = 8): string {
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  let frac = (atoms % base).toString().padStart(decimals, "0").slice(0, maxFractionDigits);
  frac = frac.replace(/0+$/, "");
  if (whole === 0n && !frac && atoms > 0n) return `<0.${"0".repeat(Math.max(maxFractionDigits - 1, 0))}1`;
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Sort two addresses the way Uniswap pools do (token0 < token1). */
export function sortTokens(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}
