// Tool-facing query wrappers: resolve tokens, call the order book, shape the
// response for an agent. All take an injectable fetchImpl seam for tests.

import {
  apiGet,
  apiPost,
  apiDelete,
  explorerOrderUrl,
  postQuote,
  resolveChain,
  type ChainInfo,
  type CowOpts,
  type CowResult,
  type QuoteResponse,
} from "./cow";
import { fromAtoms, isResolved, resolveToken, symbolFor, toAtoms, type TokenInfo } from "./tokens";
import {
  DEFAULT_APP_DATA,
  cancellationTypedData,
  limitOrder,
  normalizeAppData,
  orderFromQuote,
  type BuiltOrder,
} from "./order";

export const err = (status: number, msg: string): CowResult => ({ ok: false, status, data: msg });

/** Resolve chain or produce a helpful error result. */
export function chainOr400(chain?: string): ChainInfo | CowResult {
  const c = resolveChain(chain);
  return c ?? err(400, `Unknown chain "${chain}". Supported: mainnet, gnosis, arbitrum, base, avalanche, polygon, bnb, sepolia.`);
}
export const isErr = (v: unknown): v is CowResult =>
  typeof v === "object" && v !== null && "ok" in v && (v as CowResult).ok === false;

interface PairArgs {
  chain?: string;
  sellToken: string;
  buyToken: string;
  sellTokenDecimals?: number;
  buyTokenDecimals?: number;
}

function resolvePair(
  c: ChainInfo,
  args: PairArgs,
): { sell: TokenInfo; buy: TokenInfo } | CowResult {
  const sell = resolveToken(c.name, args.sellToken, args.sellTokenDecimals);
  if (!isResolved(sell)) return err(400, sell.error);
  const buy = resolveToken(c.name, args.buyToken, args.buyTokenDecimals);
  if (!isResolved(buy)) return err(400, buy.error);
  return { sell, buy };
}

const needDecimals = (t: TokenInfo, side: string): CowResult =>
  err(
    400,
    `Token ${t.address} (${side}) is not in the curated symbol map — pass ${side}TokenDecimals so amounts convert with the token's REAL decimals (never guessed).`,
  );

const human = (atoms: string, t: TokenInfo): string | null =>
  t.decimals >= 0 ? `${fromAtoms(atoms, t.decimals)} ${t.symbol}` : null;

// ── quote ────────────────────────────────────────────────────────────────────

export interface QuoteArgs extends PairArgs {
  kind: "sell" | "buy";
  amount: string | number;
  from: string;
  receiver?: string;
  validFor?: number;
}

async function rawQuote(
  c: ChainInfo,
  args: QuoteArgs,
  fullAppData: string,
  opts?: CowOpts,
): Promise<{ pair: { sell: TokenInfo; buy: TokenInfo }; res: QuoteResponse } | CowResult> {
  const pair = resolvePair(c, args);
  if (isErr(pair)) return pair;
  const { sell, buy } = pair;
  // The amount side being converted must have known decimals.
  const amtToken = args.kind === "sell" ? sell : buy;
  if (amtToken.decimals < 0) return needDecimals(amtToken, args.kind === "sell" ? "sell" : "buy");

  let atoms: string;
  try {
    atoms = toAtoms(args.amount, amtToken.decimals);
  } catch {
    return err(400, `Bad amount "${args.amount}" — pass a decimal number in HUMAN units (e.g. 100 for 100 USDC).`);
  }
  const r = await postQuote(
    c,
    {
      sellToken: sell.address,
      buyToken: buy.address,
      from: args.from,
      ...(args.receiver ? { receiver: args.receiver } : {}),
      kind: args.kind,
      ...(args.kind === "sell" ? { sellAmountBeforeFee: atoms } : { buyAmountAfterFee: atoms }),
      validFor: args.validFor ?? 1800,
      appData: fullAppData,
    },
    opts,
  );
  if (!r.ok) return r;
  return { pair, res: r.data as QuoteResponse };
}

export async function quote(args: QuoteArgs, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const q = await rawQuote(c, args, DEFAULT_APP_DATA, opts);
  if (isErr(q)) return q;
  const { sell, buy } = q.pair;
  const { quote: side, id, verified, expiration } = q.res;
  return {
    ok: true,
    status: 200,
    data: {
      chain: c.name,
      kind: side.kind,
      sellToken: { ...sell },
      buyToken: { ...buy },
      sell: human(side.sellAmount, sell),
      buy: human(side.buyAmount, buy),
      networkFee: human(side.feeAmount, sell),
      priceNote:
        sell.decimals >= 0 && buy.decimals >= 0
          ? `${fromAtoms(side.buyAmount, buy.decimals)} ${buy.symbol} per ${fromAtoms(side.sellAmount, sell.decimals)} ${sell.symbol} (before slippage; fee paid in ${sell.symbol})`
          : null,
      validTo: side.validTo,
      quoteId: id,
      verified,
      expiration,
      raw: side,
      next: "To turn this into a signable order, call build_swap_order with the same parameters.",
    },
  };
}

// ── build_swap_order ────────────────────────────────────────────────────────

export interface BuildSwapArgs extends QuoteArgs {
  slippageBps?: number;
  appData?: string;
  partiallyFillable?: boolean;
}

function presentBuilt(c: ChainInfo, built: BuiltOrder, pair: { sell: TokenInfo; buy: TokenInfo }, extra?: Record<string, unknown>) {
  const { sell, buy } = pair;
  return {
    chain: c.name,
    chainId: c.chainId,
    summary: {
      kind: built.order.kind,
      sell: human(built.order.sellAmount, sell),
      buy: human(built.order.buyAmount, buy),
      receiver: built.order.receiver,
      validTo: built.order.validTo,
      validToIso: new Date(built.order.validTo * 1000).toISOString(),
      partiallyFillable: built.order.partiallyFillable,
    },
    order: built.order,
    typedData: built.typedData,
    fullAppData: built.fullAppData,
    quoteId: built.quoteId,
    approval: {
      ...built.approval,
      note: `STEP 1 (prerequisite): the sell token must be approved to the GPv2VaultRelayer (${built.approval.spender}) for at least ${built.approval.neededAllowance} atoms before the order can settle. Skip if the existing allowance already covers it.`,
    },
    submit_with:
      "STEP 2: have the USER's wallet sign `typedData` via eth_signTypedData_v4 (EIP-712 — wallets hash the string members themselves), then call submit_order with {chain, order, fullAppData, signature, from, quoteId}. This service NEVER signs.",
    ...extra,
  };
}

export async function buildSwapOrder(args: BuildSwapArgs, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const app = normalizeAppData(args.appData);
  if ("error" in app) return err(400, app.error);
  const q = await rawQuote(c, args, app.fullAppData, opts);
  if (isErr(q)) return q;
  const built = orderFromQuote(c, { ...q.res.quote, partiallyFillable: args.partiallyFillable ?? false }, q.res.id, {
    from: args.from,
    receiver: args.receiver,
    slippageBps: args.slippageBps,
    fullAppData: app.fullAppData,
    appDataHash: app.hash,
  });
  return {
    ok: true,
    status: 200,
    data: presentBuilt(c, built, q.pair, {
      slippageBps: args.slippageBps ?? 50,
      quotedNetworkFee: human(q.res.quote.feeAmount, q.pair.sell),
      feeNote: "The quoted network fee is folded into sellAmount and the order is signed with feeAmount 0 (fees are computed dynamically by solvers).",
    }),
  };
}

// ── build_limit_order ───────────────────────────────────────────────────────

export interface BuildLimitArgs extends PairArgs {
  sellAmount: string | number;
  buyAmount: string | number;
  from: string;
  receiver?: string;
  validFor?: number;
  validTo?: number;
  partiallyFillable?: boolean;
  appData?: string;
}

const MAX_LIMIT_VALIDITY_S = 365 * 24 * 3600;

export async function buildLimitOrder(args: BuildLimitArgs): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const pair = resolvePair(c, args);
  if (isErr(pair)) return pair;
  const { sell, buy } = pair;
  if (sell.decimals < 0) return needDecimals(sell, "sell");
  if (buy.decimals < 0) return needDecimals(buy, "buy");
  const app = normalizeAppData(args.appData);
  if ("error" in app) return err(400, app.error);

  const nowS = Math.floor(Date.now() / 1000);
  const validTo = args.validTo ?? nowS + (args.validFor ?? 7 * 24 * 3600);
  if (validTo <= nowS) return err(400, "validTo is in the past.");
  if (validTo > nowS + MAX_LIMIT_VALIDITY_S) return err(400, "Limit orders can be valid for at most 1 year.");

  let sellAtoms: string, buyAtoms: string;
  try {
    sellAtoms = toAtoms(args.sellAmount, sell.decimals);
    buyAtoms = toAtoms(args.buyAmount, buy.decimals);
  } catch {
    return err(400, "Bad amount — pass decimal numbers in HUMAN units (e.g. 0.5 for 0.5 WETH).");
  }
  if (BigInt(sellAtoms) <= 0n || BigInt(buyAtoms) <= 0n) return err(400, "Amounts must be positive.");

  const built = limitOrder(c, {
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmountAtoms: sellAtoms,
    buyAmountAtoms: buyAtoms,
    from: args.from,
    receiver: args.receiver,
    validTo,
    partiallyFillable: args.partiallyFillable,
    fullAppData: app.fullAppData,
    appDataHash: app.hash,
  });
  return {
    ok: true,
    status: 200,
    data: presentBuilt(c, built, pair, {
      limitPrice: `${Number(args.buyAmount) / Number(args.sellAmount)} ${buy.symbol} per ${sell.symbol} (executes at this price OR BETTER)`,
      feeNote: "Limit orders are signed with feeAmount 0 — the network fee is taken from the surplus when a solver can execute at better than your limit price.",
    }),
  };
}

// ── submit_order / cancel ───────────────────────────────────────────────────

export interface SubmitArgs {
  chain?: string;
  order: Record<string, unknown>;
  signature: string;
  from: string;
  signingScheme?: "eip712" | "ethsign" | "eip1271" | "presign";
  fullAppData?: string;
  quoteId?: number;
}

export async function submitOrder(args: SubmitArgs, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const o = args.order;
  const required = ["sellToken", "buyToken", "sellAmount", "buyAmount", "validTo", "appData", "feeAmount", "kind", "partiallyFillable"];
  const missing = required.filter((k) => o[k] === undefined || o[k] === null);
  if (missing.length > 0) return err(400, `order is missing fields: ${missing.join(", ")} — pass the \`order\` object from build_swap_order/build_limit_order unchanged.`);

  const body: Record<string, unknown> = {
    ...o,
    receiver: o.receiver ?? args.from,
    sellTokenBalance: o.sellTokenBalance ?? "erc20",
    buyTokenBalance: o.buyTokenBalance ?? "erc20",
    signingScheme: args.signingScheme ?? "eip712",
    signature: args.signature,
    from: args.from,
    ...(args.quoteId !== undefined ? { quoteId: args.quoteId } : {}),
  };
  // Prefer the FULL appData JSON (the API registers it and derives the hash);
  // keep the signed hash alongside for verification.
  if (args.fullAppData) {
    body.appDataHash = o.appData;
    body.appData = args.fullAppData;
  }
  const r = await apiPost(c, "/v1/orders", body, opts);
  if (!r.ok) return r;
  const uid = r.data as string;
  return {
    ok: true,
    status: r.status,
    data: {
      orderUid: uid,
      explorerUrl: explorerOrderUrl(c, uid),
      note: "Order accepted by the order book. Track it with order_status.",
    },
  };
}

export interface CancelArgs {
  chain?: string;
  orderUids: string[];
  signature?: string;
  signingScheme?: "eip712" | "ethsign";
}

/** No signature → return the OrderCancellations typed data to sign.
 *  With signature → DELETE the orders. */
export async function cancelOrders(args: CancelArgs, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  if (args.orderUids.length === 0 || args.orderUids.length > 128) {
    return err(400, "Pass 1–128 orderUids.");
  }
  if (!args.signature) {
    return {
      ok: true,
      status: 200,
      data: {
        typedData: cancellationTypedData(c, args.orderUids),
        next: "Have the USER's wallet sign this typed data (eth_signTypedData_v4), then call cancel_orders again with the same orderUids plus {signature}.",
      },
    };
  }
  const r = await apiDelete(c, "/v1/orders", {
    orderUids: args.orderUids,
    signature: args.signature,
    signingScheme: args.signingScheme ?? "eip712",
  }, opts);
  if (!r.ok) return r;
  return { ok: true, status: r.status, data: { cancelled: args.orderUids, note: "Cancellation accepted by the order book." } };
}

// ── Order/trade/portfolio reads ─────────────────────────────────────────────

interface RawOrder {
  uid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  executedSellAmountBeforeFees?: string;
  executedSellAmount?: string;
  executedBuyAmount?: string;
  validTo: number;
  kind: "sell" | "buy";
  partiallyFillable: boolean;
  status: string;
  class?: string;
  creationDate?: string;
  invalidated?: boolean;
  receiver?: string | null;
}

function fillPct(o: RawOrder): number | null {
  const target = o.kind === "sell" ? o.sellAmount : o.buyAmount;
  const done = o.kind === "sell" ? (o.executedSellAmountBeforeFees ?? o.executedSellAmount) : o.executedBuyAmount;
  if (!target || !done) return null;
  const t = BigInt(target);
  if (t === 0n) return null;
  return Number((BigInt(done) * 10_000n) / t) / 100;
}

function summarizeOrder(c: ChainInfo, o: RawOrder) {
  return {
    uid: o.uid,
    pair: `${symbolFor(c.name, o.sellToken)} → ${symbolFor(c.name, o.buyToken)}`,
    kind: o.kind,
    class: o.class ?? null,
    status: o.status,
    filledPct: fillPct(o),
    sellAmountAtoms: o.sellAmount,
    buyAmountAtoms: o.buyAmount,
    validTo: o.validTo,
    created: o.creationDate ?? null,
    partiallyFillable: o.partiallyFillable,
    explorerUrl: explorerOrderUrl(c, o.uid),
  };
}

export async function orderStatus(args: { chain?: string; uid: string }, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const r = await apiGet(c, `/v1/orders/${args.uid}`, opts);
  if (!r.ok) return r;
  const o = r.data as RawOrder;
  return {
    ok: true,
    status: 200,
    data: {
      ...summarizeOrder(c, o),
      owner: o.owner,
      receiver: o.receiver ?? null,
      executed: {
        sellAmountAtoms: o.executedSellAmountBeforeFees ?? o.executedSellAmount ?? "0",
        buyAmountAtoms: o.executedBuyAmount ?? "0",
      },
      raw: o,
    },
  };
}

export async function userOrders(
  args: { chain?: string; owner: string; limit?: number; offset?: number },
  opts?: CowOpts,
): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const r = await apiGet(c, `/v1/account/${args.owner}/orders?limit=${limit}&offset=${args.offset ?? 0}`, opts);
  if (!r.ok) return r;
  const orders = (r.data as RawOrder[]) ?? [];
  const open = orders.filter((o) => o.status === "open");
  return {
    ok: true,
    status: 200,
    data: {
      chain: c.name,
      owner: args.owner,
      returned: orders.length,
      openCount: open.length,
      orders: orders.map((o) => summarizeOrder(c, o)),
    },
  };
}

interface RawTrade {
  orderUid: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  sellAmountBeforeFees?: string;
  buyAmount: string;
  txHash: string | null;
  blockNumber: number;
}

export async function userTrades(
  args: { chain?: string; owner: string; first?: number },
  opts?: CowOpts,
): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const r = await apiGet(c, `/v1/trades?owner=${args.owner}`, opts);
  if (!r.ok) return r;
  const all = (r.data as RawTrade[]) ?? [];
  // Most recent first (API returns ascending block order).
  const sorted = [...all].sort((a, b) => b.blockNumber - a.blockNumber);
  const first = Math.min(args.first ?? 20, 100);
  return {
    ok: true,
    status: 200,
    data: {
      chain: c.name,
      owner: args.owner,
      totalReturned: all.length,
      trades: sorted.slice(0, first).map((t) => ({
        orderUid: t.orderUid,
        pair: `${symbolFor(c.name, t.sellToken)} → ${symbolFor(c.name, t.buyToken)}`,
        sellAmountAtoms: t.sellAmount,
        buyAmountAtoms: t.buyAmount,
        txHash: t.txHash,
        blockNumber: t.blockNumber,
        explorerUrl: explorerOrderUrl(c, t.orderUid),
      })),
      ...(all.length > first ? { note: `Showing ${first} of ${all.length} — raise \`first\`.` } : {}),
    },
  };
}

const PORTFOLIO_DEFAULT_CHAINS = ["mainnet", "gnosis", "arbitrum", "base"];

export async function portfolio(
  args: { owner: string; chains?: string[] },
  opts?: CowOpts,
): Promise<CowResult> {
  const names = args.chains && args.chains.length > 0 ? args.chains : PORTFOLIO_DEFAULT_CHAINS;
  const chains: ChainInfo[] = [];
  for (const n of names) {
    const c = chainOr400(n);
    if (isErr(c)) return c;
    chains.push(c);
  }
  const perChain = await Promise.all(
    chains.map(async (c) => {
      const [ordersRes, tradesRes] = await Promise.all([
        apiGet(c, `/v1/account/${args.owner}/orders?limit=50`, opts),
        apiGet(c, `/v1/trades?owner=${args.owner}`, opts),
      ]);
      if (!ordersRes.ok && !tradesRes.ok) {
        return { chain: c.name, error: `orders HTTP ${ordersRes.status}, trades HTTP ${tradesRes.status}` };
      }
      const orders = ordersRes.ok ? ((ordersRes.data as RawOrder[]) ?? []) : [];
      const trades = tradesRes.ok ? ((tradesRes.data as RawTrade[]) ?? []) : [];
      const open = orders.filter((o) => o.status === "open");
      // Order-book-derived volume: total sold per token (atoms + symbol).
      const soldByToken = new Map<string, bigint>();
      for (const t of trades) {
        const key = t.sellToken.toLowerCase();
        soldByToken.set(key, (soldByToken.get(key) ?? 0n) + BigInt(t.sellAmountBeforeFees ?? t.sellAmount));
      }
      const recent = [...trades].sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 5);
      return {
        chain: c.name,
        openOrders: open.map((o) => summarizeOrder(c, o)),
        recentOrderCount: orders.length,
        tradeCount: trades.length,
        recentFills: recent.map((t) => ({
          pair: `${symbolFor(c.name, t.sellToken)} → ${symbolFor(c.name, t.buyToken)}`,
          sellAmountAtoms: t.sellAmount,
          buyAmountAtoms: t.buyAmount,
          txHash: t.txHash,
        })),
        totalSoldByToken: Object.fromEntries(
          [...soldByToken.entries()].map(([addr, atoms]) => [symbolFor(c.name, addr), atoms.toString()]),
        ),
      };
    }),
  );
  return {
    ok: true,
    status: 200,
    data: {
      owner: args.owner,
      chains: perChain,
      note: "Order-book-derived view (open orders, fills, traded volume in atoms). Token balances live on-chain and are out of scope for this service.",
    },
  };
}

// ── native_price / solver_competition ───────────────────────────────────────

export async function nativePrice(args: { chain?: string; token: string }, opts?: CowOpts): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const t = resolveToken(c.name, args.token);
  if (!isResolved(t)) return err(400, t.error);
  const r = await apiGet(c, `/v1/token/${t.address}/native_price`, opts);
  if (!r.ok) return r;
  return {
    ok: true,
    status: 200,
    data: {
      chain: c.name,
      token: t.symbol,
      address: t.address,
      price: (r.data as { price: number }).price,
      note: `Price of one ATOM-scaled unit in ${c.native} terms as returned by the order book (price × 10^tokenDecimals / 10^18 = ${c.native} per whole token).`,
    },
  };
}

export async function solverCompetition(
  args: { chain?: string; txHash?: string },
  opts?: CowOpts,
): Promise<CowResult> {
  const c = chainOr400(args.chain);
  if (isErr(c)) return c;
  const path = args.txHash ? `/v2/solver_competition/by_tx_hash/${args.txHash}` : "/v2/solver_competition/latest";
  const r = await apiGet(c, path, opts);
  if (!r.ok) return r;
  const d = r.data as {
    auctionId: number;
    auctionStartBlock?: number;
    transactionHashes?: string[];
    referenceScores?: Record<string, string>;
    solutions?: { solverAddress: string; score?: string; ranking?: number; isWinner?: boolean; orders?: unknown[] }[];
    auction?: { orders?: string[] };
  };
  return {
    ok: true,
    status: 200,
    data: {
      chain: c.name,
      auctionId: d.auctionId,
      auctionStartBlock: d.auctionStartBlock ?? null,
      settlementTxHashes: d.transactionHashes ?? [],
      ordersInAuction: d.auction?.orders?.length ?? null,
      solutions: (d.solutions ?? []).map((s) => ({
        solver: s.solverAddress,
        score: s.score ?? null,
        ranking: s.ranking ?? null,
        isWinner: s.isWinner ?? null,
        orderCount: s.orders?.length ?? null,
      })),
      referenceScores: d.referenceScores ?? null,
    },
  };
}

// ── chains listing ──────────────────────────────────────────────────────────

export { CHAINS, SETTLEMENT_CONTRACT, VAULT_RELAYER } from "./cow";
