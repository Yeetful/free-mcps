// Token symbol resolution + amount math. A curated per-chain map of the
// liquid, unambiguous symbols; raw 0x addresses are accepted everywhere
// (with a `decimals` arg where amounts are involved, since this service is
// deliberately RPC-free — the order-book API never reports decimals).
//
// Every address below was verified against the live api.cow.fi
// /token/{address}/native_price endpoint on 2026-07-06 (a 200 means the
// order book knows + prices the token on that chain).

import { formatUnits, parseUnits } from "viem";

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

type TokenMap = Record<string, { address: string; decimals: number }>;

const MAINNET: TokenMap = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  COW: { address: "0xDEf1CA1fb7FBcDC777520aa7f396b4E015F497aB", decimals: 18 },
  GNO: { address: "0x6810e776880C02933D47DB1b9fc05908e5386b96", decimals: 18 },
};

const GNOSIS: TokenMap = {
  WXDAI: { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", decimals: 18 },
  WETH: { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", decimals: 18 },
  USDC: { address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", decimals: 6 },
  USDT: { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", decimals: 6 },
  WBTC: { address: "0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252", decimals: 8 },
  GNO: { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", decimals: 18 },
  COW: { address: "0x177127622c4A00F3d409B75571e12cB3c8973d3c", decimals: 18 },
};

const ARBITRUM: TokenMap = {
  WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
  USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FcbB9", decimals: 6 },
  DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
  WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
  ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
  COW: { address: "0xcb8b5CD20BdCaea9a010aC1F8d835824F5C87A04", decimals: 18 },
};

const BASE: TokenMap = {
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  USDBC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  COW: { address: "0xc694a91e6b071bF030A18BD3053A7fE09B6DaE69", decimals: 18 },
};

const AVALANCHE: TokenMap = {
  WAVAX: { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", decimals: 18 },
  AVAX: { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", decimals: 18 }, // alias for WAVAX
  USDC: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
  USDT: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  WETH: { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18 }, // WETH.e
  DAI: { address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18 }, // DAI.e
};

const POLYGON: TokenMap = {
  WPOL: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  POL: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 }, // alias
  WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 }, // legacy alias
  USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
  WBTC: { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
};

const BNB: TokenMap = {
  WBNB: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  BNB: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 }, // alias
  USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 }, // 18 on BNB!
  USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }, // 18 on BNB!
  ETH: { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 }, // Binance-peg
  BTCB: { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
};

const SEPOLIA: TokenMap = {
  WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
  USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
  COW: { address: "0x0625aFB445C3B6B7B929342a04A22599fd5dBB59", decimals: 18 },
};

const BY_CHAIN: Record<string, TokenMap> = {
  mainnet: MAINNET,
  gnosis: GNOSIS,
  arbitrum: ARBITRUM,
  base: BASE,
  avalanche: AVALANCHE,
  polygon: POLYGON,
  bnb: BNB,
  sepolia: SEPOLIA,
};

/**
 * Resolve a token symbol or 0x address on a chain.
 * - Curated symbols resolve to {address, decimals}.
 * - Raw 0x addresses pass through; decimals come from `decimalsHint` (or null
 *   — callers that need amount math must then refuse with a helpful error).
 */
export function resolveToken(
  chainName: string,
  token: string,
  decimalsHint?: number,
): TokenInfo | { error: string } {
  const trimmed = token.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    // Reverse-lookup a known symbol for display; else the bare address.
    const map = BY_CHAIN[chainName] ?? {};
    const known = Object.entries(map).find(([, t]) => t.address.toLowerCase() === trimmed.toLowerCase());
    return {
      address: trimmed,
      symbol: known?.[0] ?? trimmed.slice(0, 10) + "…",
      decimals: decimalsHint ?? known?.[1].decimals ?? -1, // -1 = unknown
    };
  }
  const upper = trimmed.toUpperCase();
  const map = BY_CHAIN[chainName];
  if (!map) return { error: `Unknown chain "${chainName}".` };
  const hit = map[upper];
  if (!hit) {
    return {
      error:
        `Unknown token symbol "${token}" on ${chainName}. Known symbols: ${Object.keys(map).join(", ")}. ` +
        `Pass the token's 0x address instead (plus its decimals where an amount is involved).`,
    };
  }
  return { address: hit.address, symbol: upper, decimals: hit.decimals };
}

export const isResolved = (t: TokenInfo | { error: string }): t is TokenInfo => !("error" in t);

/** Reverse-lookup a symbol for an address on a chain (display only). */
export function symbolFor(chainName: string, address: string): string {
  const map = BY_CHAIN[chainName] ?? {};
  const known = Object.entries(map).find(([, t]) => t.address.toLowerCase() === address.toLowerCase());
  return known?.[0] ?? address;
}

/** Human units → atoms, as a decimal string. Throws on bad input. */
export function toAtoms(amount: string | number, decimals: number): string {
  return parseUnits(String(amount), decimals).toString();
}

/** Atoms → human units string. */
export function fromAtoms(atoms: string | bigint, decimals: number): string {
  return formatUnits(BigInt(atoms), decimals);
}

export function knownSymbols(chainName: string): string[] {
  return Object.keys(BY_CHAIN[chainName] ?? {});
}
