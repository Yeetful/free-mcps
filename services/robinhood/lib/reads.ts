// Read-only views over Robinhood Chain: the token directory, live Chainlink
// prices (staleness-checked, oracle-pause aware), and whole-wallet
// portfolios. All feed prices ALREADY include the corporate-action
// multiplier — a feed price × a raw balance is the correct USD value.

import { FEED_ABI, FEED_STALE_AFTER_SEC, TOKEN_ABI, readRetry, rpc } from "./chain";
import {
  ARB_SYS,
  BRIDGE_UI,
  CHAIN_ID,
  EXPLORER,
  L1_INBOX,
  MORPHO,
  PERMIT2,
  PUBLIC_RPC,
  TOKENS,
  UNIVERSAL_ROUTER,
  USDG,
  V4_QUOTER,
  type RegistryToken,
  resolveToken,
} from "./registry";
import { fail, formatAtoms, ok, usdValue, type RhResult } from "./util";

export interface FeedPrice {
  usd: number;
  updatedAt: number;
  stale: boolean;
}

/** Read one Chainlink feed; null when the token has no feed. Throws on RPC failure. */
export async function feedPrice(token: RegistryToken): Promise<FeedPrice | null> {
  if (!token.feed) return null;
  const client = rpc();
  const [, answer, , updatedAt] = await readRetry(() =>
    client.readContract({ address: token.feed!, abi: FEED_ABI, functionName: "latestRoundData" }),
  );
  if (answer <= 0n) return null;
  const updated = Number(updatedAt);
  return {
    usd: Number(answer) / 1e8,
    updatedAt: updated,
    stale: Date.now() / 1000 - updated > FEED_STALE_AFTER_SEC,
  };
}

/** ERC-8056 state for a stock token — fail-soft views (revert = extension absent). */
async function scaledUiState(token: RegistryToken) {
  const client = rpc();
  const call = async <T>(functionName: "uiMultiplier" | "newUIMultiplier" | "effectiveAt" | "oraclePaused"): Promise<T | null> => {
    try {
      return (await readRetry(() =>
        client.readContract({ address: token.address, abi: TOKEN_ABI, functionName }),
      )) as T;
    } catch {
      return null;
    }
  };
  const [uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused] = await Promise.all([
    call<bigint>("uiMultiplier"),
    call<bigint>("newUIMultiplier"),
    call<bigint>("effectiveAt"),
    call<boolean>("oraclePaused"),
  ]);
  return { uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused };
}

export const reads = {
  /** Static chain facts + a live block probe. */
  async chainInfo(): Promise<RhResult> {
    let block: string | null = null;
    try {
      block = (await readRetry(() => rpc().getBlockNumber())).toString();
    } catch {
      // live probe is decoration — the static facts still answer the question
    }
    return ok({
      chain: "Robinhood Chain",
      chainId: CHAIN_ID,
      stack: "Arbitrum Orbit L2 on Ethereum (blob DA), gas token ETH",
      rpc: { public: PUBLIC_RPC, note: "Public endpoint is rate-limited; Alchemy slug robinhood-mainnet for production." },
      explorer: EXPLORER,
      latestBlock: block,
      protocols: {
        trading: { venue: "Uniswap v4 (stock tokens trade in v4-only pools quoted against USDG)", quoter: V4_QUOTER, universalRouter: UNIVERSAL_ROUTER, permit2: PERMIT2 },
        lending: { venue: "Morpho", core: MORPHO },
        bridge: { l1Inbox: L1_INBOX, arbSys: ARB_SYS, ui: BRIDGE_UI },
      },
      stockTokens: "ERC-20, 18 decimals, ERC-8056 scaled-UI extension (uiMultiplier folds in splits/dividends). Chainlink feeds already include the multiplier.",
      moneyTokens: "USDG (Global Dollar, 6 decimals) is the quote/loan currency; USDe and WETH also circulate. There is NO USDC on this chain.",
    });
  },

  /** The token directory — every stock, ETF, and money token this service knows. */
  async stockTokens(): Promise<RhResult> {
    return ok({
      chainId: CHAIN_ID,
      count: TOKENS.length,
      tokens: TOKENS.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        kind: t.kind,
        address: t.address,
        decimals: t.decimals,
        priceFeed: t.feed,
      })),
      note: "Source: docs.robinhood.com/chain/contracts. Stock/ETF feeds are Chainlink 'Robinhood X / USD' proxies (8 decimals) and already include the corporate-action multiplier. Use `token_info` for a live price + multiplier state.",
    });
  },

  /** One token in depth: live price, staleness, ERC-8056 multiplier state. */
  async tokenInfo(args: { token: string }): Promise<RhResult> {
    const token = resolveToken(args.token);
    if (!token) return fail(404, `Unknown token "${args.token}" on Robinhood Chain — call stock_tokens for the directory.`);
    try {
      const [price, ui, totalSupply] = await Promise.all([
        feedPrice(token).catch(() => null),
        token.kind === "money" ? Promise.resolve(null) : scaledUiState(token),
        readRetry(() => rpc().readContract({ address: token.address, abi: TOKEN_ABI, functionName: "totalSupply" })).catch(() => null),
      ]);
      const paused = ui?.oraclePaused === true;
      return ok({
        symbol: token.symbol,
        name: token.name,
        kind: token.kind,
        address: token.address,
        decimals: token.decimals,
        explorer: `${EXPLORER}/token/${token.address}`,
        price: paused
          ? { usd: null, note: "Corporate action in progress — the token reports oraclePaused; treat the price as temporarily unavailable." }
          : price
            ? { usd: price.usd, updatedAt: new Date(price.updatedAt * 1000).toISOString(), stale: price.stale, ...(price.stale ? { note: "Feed is past its heartbeat window — treat with caution." } : {}) }
            : { usd: null, note: token.feed ? "Feed returned no valid answer." : "No Chainlink feed listed for this token yet." },
        totalSupply: totalSupply != null ? formatAtoms(totalSupply, token.decimals) : null,
        ...(ui && ui.uiMultiplier != null
          ? {
              corporateActions: {
                uiMultiplier: formatAtoms(ui.uiMultiplier, 18),
                pending:
                  ui.newUIMultiplier != null && ui.effectiveAt != null && ui.effectiveAt > 0n && ui.newUIMultiplier !== ui.uiMultiplier
                    ? { newUIMultiplier: formatAtoms(ui.newUIMultiplier, 18), effectiveAt: new Date(Number(ui.effectiveAt) * 1000).toISOString() }
                    : null,
                note: "The Chainlink price already includes this multiplier — never apply it twice.",
              },
            }
          : {}),
      });
    } catch (e) {
      return fail(502, `Robinhood Chain RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /** Batch prices for a list of symbols (default: everything with a feed). */
  async prices(args: { tokens?: string[] }): Promise<RhResult> {
    const list = args.tokens?.length
      ? args.tokens.map((s) => resolveToken(s))
      : TOKENS.filter((t) => t.feed);
    const unknown = args.tokens?.filter((_, i) => !list[i]) ?? [];
    if (unknown.length) return fail(404, `Unknown token(s): ${unknown.join(", ")} — call stock_tokens for the directory.`);
    try {
      const priced = await Promise.all(
        (list as RegistryToken[]).map(async (t) => {
          const p = await feedPrice(t).catch(() => null);
          return { symbol: t.symbol, kind: t.kind, usd: p?.usd ?? null, stale: p?.stale ?? null, updatedAt: p ? new Date(p.updatedAt * 1000).toISOString() : null };
        }),
      );
      return ok({ chainId: CHAIN_ID, source: "Chainlink (corporate-action multiplier included)", prices: priced });
    } catch (e) {
      return fail(502, `Robinhood Chain RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  /**
   * Whole-wallet view on Robinhood Chain: native ETH + every registry token,
   * USD-valued via Chainlink. `kind:'portfolio'` is the chat's rich-card contract.
   */
  async portfolio(args: { user: `0x${string}` }): Promise<RhResult> {
    const client = rpc();
    try {
      const [ethBalance, ...balances] = await Promise.all([
        readRetry(() => client.getBalance({ address: args.user })),
        ...TOKENS.map((t) =>
          readRetry(() => client.readContract({ address: t.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [args.user] })),
        ),
      ]);

      const held = TOKENS.map((t, i) => ({ token: t, atoms: balances[i] })).filter((h) => h.atoms > 0n);
      const weth = TOKENS.find((t) => t.symbol === "WETH")!;
      const ethPrice = ethBalance > 0n || held.some((h) => h.token.symbol === "WETH") ? await feedPrice(weth).catch(() => null) : null;

      const holdings: Array<{ symbol: string; kind: string; balance: string; usd: number | null; priceUsd: number | null; stale?: boolean }> = [];
      let totalUsd = 0;
      let unpriced = 0;

      if (ethBalance > 0n) {
        const usd = ethPrice ? usdValue(ethBalance, 18, BigInt(Math.round(ethPrice.usd * 1e8)), 8) : null;
        holdings.push({ symbol: "ETH", kind: "native", balance: formatAtoms(ethBalance, 18), usd, priceUsd: ethPrice?.usd ?? null });
        totalUsd += usd ?? 0;
        if (usd == null) unpriced++;
      }

      for (const h of held) {
        const price = h.token.symbol === "WETH" ? ethPrice : await feedPrice(h.token).catch(() => null);
        const usd = price ? usdValue(h.atoms, h.token.decimals, BigInt(Math.round(price.usd * 1e8)), 8) : null;
        holdings.push({
          symbol: h.token.symbol,
          kind: h.token.kind,
          balance: formatAtoms(h.atoms, h.token.decimals),
          usd,
          priceUsd: price?.usd ?? null,
          ...(price?.stale ? { stale: true } : {}),
        });
        totalUsd += usd ?? 0;
        if (usd == null) unpriced++;
      }

      holdings.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
      const stocksUsd = holdings.filter((h) => h.kind === "stock" || h.kind === "etf").reduce((s, h) => s + (h.usd ?? 0), 0);

      return ok({
        kind: "portfolio",
        chain: "Robinhood Chain",
        chainId: CHAIN_ID,
        owner: args.user,
        totalUsd: Number(totalUsd.toFixed(2)),
        holdings,
        summary:
          holdings.length === 0
            ? `No ETH or known tokens on Robinhood Chain for ${args.user}.`
            : `${holdings.length} holding(s) ≈ $${totalUsd.toFixed(2)} on Robinhood Chain` +
              (stocksUsd > 0 ? `, $${stocksUsd.toFixed(2)} of it in tokenized stocks/ETFs` : "") +
              (unpriced ? ` (${unpriced} holding(s) have no feed price)` : "") +
              ".",
        updatedAt: new Date().toISOString(),
        note: "Morpho lending positions are NOT included here — use lending_position for supplied/borrowed balances.",
      });
    } catch (e) {
      return fail(502, `Robinhood Chain RPC read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
