// Two-step guarded order flow for the Robinhood brokerage (real money, no
// wallet signature to act as consent — so consent is made EXPLICIT):
//
//   1. brokerage_build_order  → validates the order against live trading
//      pairs + estimated price, returns a full-cost PREVIEW and a one-time
//      confirm token (HMAC, 5-minute TTL, stateless — no server storage).
//   2. brokerage_submit_order → requires the confirm token AND the exact
//      same order params again; refuses on any mismatch or expiry, then
//      places the order via the v2 API with a fresh client_order_id.
//
// Construction and submission are NEVER a single call. The token is
// HMAC-SHA256 keyed by a digest of the caller's own credentials, so a token
// minted under one credential set cannot be replayed under another, and a
// token never survives a parameter edit.

import { randomUUID } from "node:crypto";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  bkFail,
  bkOk,
  brokerageNowSec,
  brokeragePaginate,
  brokerageRequest,
  maskApiKey,
  type BkResult,
  type BrokerageCreds,
} from "./brokerage";

export const ORDER_SIDES = ["buy", "sell"] as const;
export const ORDER_TYPES = ["market", "limit", "stop_loss", "stop_limit"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export type OrderType = (typeof ORDER_TYPES)[number];

export interface OrderParams {
  accountNumber: string;
  symbol: string; // "BTC-USD"
  side: OrderSide;
  type: OrderType;
  assetQuantity?: string;
  quoteAmount?: string;
  limitPrice?: string;
  stopPrice?: string;
  timeInForce?: "gtc";
}

const DECIMAL = /^\d+(\.\d+)?$/;
const SYMBOL = /^[A-Z0-9]{1,15}-USD$/;

const isPositiveDecimal = (s: string | undefined): s is string => !!s && DECIMAL.test(s) && Number(s) > 0;

/** Shape-validate order params. Returns an error message or null when valid. */
export function validateOrderShape(p: OrderParams): string | null {
  if (!SYMBOL.test(p.symbol)) return `Symbol must be an uppercase USD trading pair like "BTC-USD" (got "${p.symbol}").`;
  if (!ORDER_SIDES.includes(p.side)) return `side must be "buy" or "sell".`;
  if (!ORDER_TYPES.includes(p.type)) return `type must be one of ${ORDER_TYPES.join(", ")}.`;
  if (p.assetQuantity !== undefined && !isPositiveDecimal(p.assetQuantity)) return `assetQuantity must be a positive decimal string (got "${p.assetQuantity}").`;
  if (p.quoteAmount !== undefined && !isPositiveDecimal(p.quoteAmount)) return `quoteAmount must be a positive decimal string in USD (got "${p.quoteAmount}").`;
  if (p.limitPrice !== undefined && !isPositiveDecimal(p.limitPrice)) return `limitPrice must be a positive decimal string in USD.`;
  if (p.stopPrice !== undefined && !isPositiveDecimal(p.stopPrice)) return `stopPrice must be a positive decimal string in USD.`;

  const hasQty = p.assetQuantity !== undefined;
  const hasQuote = p.quoteAmount !== undefined;
  if (p.type === "market") {
    if (!hasQty) return "Market orders need assetQuantity (the crypto amount, e.g. \"0.001\" BTC).";
    if (hasQuote) return "Market orders take assetQuantity only — quoteAmount is not supported for market orders.";
    if (p.limitPrice !== undefined || p.stopPrice !== undefined) return "Market orders take no limitPrice/stopPrice.";
  } else {
    if (hasQty === hasQuote) return `${p.type} orders need EXACTLY ONE of assetQuantity or quoteAmount.`;
    if (p.type === "limit" && p.limitPrice === undefined) return "Limit orders need limitPrice.";
    if (p.type === "limit" && p.stopPrice !== undefined) return "Limit orders take no stopPrice (use stop_limit).";
    if (p.type === "stop_loss" && p.stopPrice === undefined) return "Stop-loss orders need stopPrice.";
    if (p.type === "stop_loss" && p.limitPrice !== undefined) return "Stop-loss orders take no limitPrice (use stop_limit).";
    if (p.type === "stop_limit" && (p.limitPrice === undefined || p.stopPrice === undefined)) return "Stop-limit orders need BOTH limitPrice and stopPrice.";
  }
  return null;
}

/** The `{type}_order_config` object the API expects (decimal strings). */
export function orderConfig(p: OrderParams): { key: string; config: Record<string, string> } {
  const config: Record<string, string> = {};
  if (p.assetQuantity !== undefined) config.asset_quantity = p.assetQuantity;
  if (p.quoteAmount !== undefined) config.quote_amount = p.quoteAmount;
  if (p.limitPrice !== undefined) config.limit_price = p.limitPrice;
  if (p.stopPrice !== undefined) config.stop_price = p.stopPrice;
  if (p.type !== "market") config.time_in_force = p.timeInForce ?? "gtc";
  return { key: `${p.type}_order_config`, config };
}

// ── Confirm token (stateless HMAC, one credential set, 5-minute TTL) ───────

export const CONFIRM_TTL_SEC = 300;

/** Key-sort-canonicalize the params so field order can never break a match. */
export function canonicalOrder(p: OrderParams): string {
  const entries = Object.entries({
    accountNumber: p.accountNumber,
    symbol: p.symbol,
    side: p.side,
    type: p.type,
    assetQuantity: p.assetQuantity,
    quoteAmount: p.quoteAmount,
    limitPrice: p.limitPrice,
    stopPrice: p.stopPrice,
    timeInForce: p.type === "market" ? undefined : (p.timeInForce ?? "gtc"),
  }).filter(([, v]) => v !== undefined) as Array<[string, string]>;
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(entries));
}

/** MAC key bound to the caller's credentials — one-way, reveals nothing. */
function tokenKey(creds: BrokerageCreds): Uint8Array {
  const label = new TextEncoder().encode(`yeetful-brokerage-confirm-v1|${creds.apiKey}|`);
  const material = new Uint8Array(label.length + creds.seed.length);
  material.set(label, 0);
  material.set(creds.seed, label.length);
  return sha256(material);
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function mintConfirmToken(creds: BrokerageCreds, params: OrderParams, now = brokerageNowSec()): { token: string; expiresAt: string } {
  const payload = JSON.stringify({ v: 1, exp: now + CONFIRM_TTL_SEC, h: bytesToHex(sha256(new TextEncoder().encode(canonicalOrder(params)))) });
  const mac = Buffer.from(hmac(sha256, tokenKey(creds), new TextEncoder().encode(payload))).toString("base64url");
  return { token: `${b64url(payload)}.${mac}`, expiresAt: new Date((now + CONFIRM_TTL_SEC) * 1000).toISOString() };
}

export function verifyConfirmToken(
  creds: BrokerageCreds,
  params: OrderParams,
  token: string,
  now = brokerageNowSec(),
): { ok: true } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "Malformed confirm token — call brokerage_build_order to get a fresh one." };
  let payload: { v?: number; exp?: number; h?: string };
  try {
    payload = JSON.parse(fromB64url(parts[0])) as typeof payload;
  } catch {
    return { ok: false, reason: "Malformed confirm token — call brokerage_build_order to get a fresh one." };
  }
  const expectedMac = Buffer.from(hmac(sha256, tokenKey(creds), new TextEncoder().encode(fromB64url(parts[0]))));
  const gotMac = Buffer.from(parts[1], "base64url");
  if (expectedMac.length !== gotMac.length || !expectedMac.equals(gotMac))
    return { ok: false, reason: "Confirm token was not minted for these credentials — call brokerage_build_order yourself first." };
  if (payload.v !== 1 || typeof payload.exp !== "number" || typeof payload.h !== "string")
    return { ok: false, reason: "Malformed confirm token — call brokerage_build_order to get a fresh one." };
  if (now > payload.exp)
    return { ok: false, reason: `Confirm token expired (valid ${CONFIRM_TTL_SEC / 60} minutes). Call brokerage_build_order again and re-confirm — prices move.` };
  const paramsHash = bytesToHex(sha256(new TextEncoder().encode(canonicalOrder(params))));
  if (paramsHash !== payload.h)
    return { ok: false, reason: "Order params do not match the previewed order — the confirm token only covers EXACTLY what brokerage_build_order previewed. Re-run brokerage_build_order with the new params." };
  return { ok: true };
}

// ── Account + market plumbing ──────────────────────────────────────────────

/** Live v2 shape verified 2026-07-15: max_order_size is in ASSET units,
 *  min_order_amount is in QUOTE currency (USD), plus is_api_tradable. */
interface TradingPair {
  symbol?: string;
  status?: string;
  is_api_tradable?: boolean;
  min_order_size?: string; // v1-style fallback (asset units)
  min_order_amount?: string; // USD
  max_order_size?: string; // asset units
  asset_increment?: string;
  quote_increment?: string;
}

/** First (usually only) crypto account number for these creds. */
export async function resolveAccountNumber(creds: BrokerageCreds, explicit?: string): Promise<{ accountNumber: string } | { error: BkResult }> {
  if (explicit) return { accountNumber: explicit };
  const res = await brokerageRequest(creds, "GET", "/api/v2/crypto/trading/accounts/");
  if (!res.ok) return { error: res };
  const results = (res.data as { results?: Array<{ account_number?: string }> }).results ?? [];
  const accountNumber = results[0]?.account_number;
  if (!accountNumber) return { error: bkFail(404, "No crypto trading account found for these credentials.") };
  return { accountNumber };
}

async function fetchPair(creds: BrokerageCreds, symbol: string): Promise<{ pair: TradingPair } | { error: BkResult }> {
  const res = await brokerageRequest(creds, "GET", `/api/v2/crypto/trading/trading_pairs/?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) return { error: res };
  const pair = ((res.data as { results?: TradingPair[] }).results ?? []).find((p) => p.symbol === symbol);
  if (!pair) return { error: bkFail(404, `"${symbol}" is not a Robinhood crypto trading pair — call brokerage_trading_pairs for the tradable list.`) };
  return { pair };
}

/** v2 estimated_price result (fee tiers): live shape verified 2026-07-15 —
 *  `{symbol, side, quantity, fee_ratio, est_fee, ask|bid, est_total_cost}`,
 *  numbers not strings, and NO generic `price` field. */
interface EstimatedQuote {
  ask?: number | string;
  bid?: number | string;
  price?: number | string; // defensive: v1-style shape
  fee_ratio?: number | string;
  est_fee?: number | string;
  est_total_cost?: number | string;
}

const num = (v: number | string | undefined): number | null => {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchEstimatedPrice(
  creds: BrokerageCreds,
  symbol: string,
  side: OrderSide,
  quantity: string,
): Promise<{ pricePerUnitUsd: number; estFeeUsd: number | null; estTotalUsd: number | null; feeRatio: number | null } | { error: BkResult }> {
  // Buys execute at the ask, sells at the bid.
  const book = side === "buy" ? "ask" : "bid";
  const res = await brokerageRequest(
    creds,
    "GET",
    `/api/v2/crypto/trading/estimated_price/?symbol=${encodeURIComponent(symbol)}&side=${book}&quantity=${encodeURIComponent(quantity)}`,
  );
  if (!res.ok) return { error: res };
  const quote = ((res.data as { results?: EstimatedQuote[] }).results ?? [])[0];
  const pricePerUnitUsd = num(quote?.[book]) ?? num(quote?.price);
  if (pricePerUnitUsd == null) return { error: bkFail(502, `No estimated price returned for ${symbol} — the pair may be halted.`) };
  return {
    pricePerUnitUsd,
    estFeeUsd: num(quote?.est_fee),
    estTotalUsd: num(quote?.est_total_cost),
    feeRatio: num(quote?.fee_ratio),
  };
}

// ── The three order operations ─────────────────────────────────────────────

export interface BuildOrderArgs extends Omit<OrderParams, "accountNumber"> {
  accountNumber?: string;
}

/**
 * Step 1 of 2 — read-only. Validates against live trading-pair limits +
 * estimated price and returns the preview + one-time confirm token. Nothing
 * is placed here.
 */
export async function buildOrder(creds: BrokerageCreds, args: BuildOrderArgs): Promise<BkResult> {
  const account = await resolveAccountNumber(creds, args.accountNumber);
  if ("error" in account) return account.error;
  const params: OrderParams = { ...args, accountNumber: account.accountNumber };

  const shapeError = validateOrderShape(params);
  if (shapeError) return bkFail(400, shapeError);

  const pairRes = await fetchPair(creds, params.symbol);
  if ("error" in pairRes) return pairRes.error;
  const { pair } = pairRes;
  if (pair.status && pair.status !== "tradable")
    return bkFail(409, `"${params.symbol}" is currently "${pair.status}" (not tradable) — refusing to build an order for it.`);
  if (pair.is_api_tradable === false)
    return bkFail(409, `"${params.symbol}" is not API-tradable (is_api_tradable=false) — Robinhood only accepts API orders on API-tradable pairs.`);

  if (params.assetQuantity) {
    const qty = Number(params.assetQuantity);
    if (pair.min_order_size && qty < Number(pair.min_order_size))
      return bkFail(400, `assetQuantity ${params.assetQuantity} is below the ${params.symbol} minimum order size ${pair.min_order_size}.`);
    if (pair.max_order_size && qty > Number(pair.max_order_size))
      return bkFail(400, `assetQuantity ${params.assetQuantity} exceeds the ${params.symbol} maximum order size ${pair.max_order_size}.`);
  }

  // Cost basis: estimated execution price (fee-tier inclusive when the API
  // reports it) for quantity orders; the quote amount IS the notional for
  // quote-denominated orders.
  let estimate: { pricePerUnitUsd: number | null; estNotionalUsd: number; estFeeUsd: number | null; feeRatio: number | null; basis: string };
  if (params.assetQuantity) {
    const est = await fetchEstimatedPrice(creds, params.symbol, params.side, params.assetQuantity);
    if ("error" in est) return est.error;
    estimate = {
      pricePerUnitUsd: est.pricePerUnitUsd,
      estNotionalUsd: est.estTotalUsd ?? est.pricePerUnitUsd * Number(params.assetQuantity),
      estFeeUsd: est.estFeeUsd,
      feeRatio: est.feeRatio,
      basis: `live estimated ${params.side === "buy" ? "ask" : "bid"} for ${params.assetQuantity} ${params.symbol}${est.estTotalUsd != null ? " (fee-tier inclusive est_total_cost)" : ""}`,
    };
  } else {
    estimate = {
      pricePerUnitUsd: null,
      estNotionalUsd: Number(params.quoteAmount),
      estFeeUsd: null,
      feeRatio: null,
      basis: "quote_amount orders spend/receive exactly this USD notional",
    };
  }

  // min_order_amount is QUOTE-denominated (USD) — check it against the
  // estimated notional so dust orders are refused before the preview.
  if (pair.min_order_amount && estimate.estNotionalUsd < Number(pair.min_order_amount))
    return bkFail(400, `Estimated notional $${estimate.estNotionalUsd.toFixed(2)} is below the ${params.symbol} minimum order amount $${pair.min_order_amount}.`);

  const { token, expiresAt } = mintConfirmToken(creds, params);
  const { key, config } = orderConfig(params);

  return bkOk({
    kind: "brokerage_order_preview",
    account: { accountNumber: params.accountNumber, apiKey: maskApiKey(creds.apiKey), credentialSource: creds.source },
    order: { symbol: params.symbol, side: params.side, type: params.type, [key]: config },
    estimate: {
      pricePerUnitUsd: estimate.pricePerUnitUsd,
      estNotionalUsd: Number(estimate.estNotionalUsd.toFixed(2)),
      ...(estimate.estFeeUsd != null ? { estFeeUsd: Number(estimate.estFeeUsd.toFixed(4)) } : {}),
      ...(estimate.feeRatio != null ? { feeRatio: estimate.feeRatio } : {}),
      basis: estimate.basis,
      note: "Estimate only — market moves and Robinhood fee tiers can change the final execution price.",
    },
    tradingPair: {
      minOrderAmountUsd: pair.min_order_amount ?? null,
      maxOrderSize: pair.max_order_size ?? null,
      assetIncrement: pair.asset_increment ?? null,
      status: pair.status ?? null,
      isApiTradable: pair.is_api_tradable ?? null,
    },
    confirmToken: token,
    confirmTokenExpiresAt: expiresAt,
    nextStep:
      "NOTHING has been placed. To place this order — which moves REAL MONEY in the user's Robinhood brokerage account — show the user this preview, get their explicit approval, then call brokerage_submit_order with the confirmToken plus the EXACT same order params. The token expires in 5 minutes and dies on any param change.",
  });
}

export interface SubmitOrderArgs extends BuildOrderArgs {
  confirmToken: string;
}

/**
 * Step 2 of 2 — PLACES A REAL ORDER. Refuses without a fresh, matching
 * confirm token from brokerage_build_order under the same credentials.
 */
export async function submitOrder(creds: BrokerageCreds, args: SubmitOrderArgs): Promise<BkResult> {
  const account = await resolveAccountNumber(creds, args.accountNumber);
  if ("error" in account) return account.error;
  const params: OrderParams = { ...args, accountNumber: account.accountNumber };

  const shapeError = validateOrderShape(params);
  if (shapeError) return bkFail(400, shapeError);

  const verdict = verifyConfirmToken(creds, params, args.confirmToken);
  if (!verdict.ok) return bkFail(403, verdict.reason);

  const { key, config } = orderConfig(params);
  const clientOrderId = randomUUID();
  const res = await brokerageRequest(
    creds,
    "POST",
    `/api/v2/crypto/trading/orders/?account_number=${encodeURIComponent(params.accountNumber)}`,
    {
      client_order_id: clientOrderId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      [key]: config,
    },
  );
  if (!res.ok) return res;
  return bkOk({
    kind: "brokerage_order_receipt",
    placed: true,
    clientOrderId,
    order: res.data,
    note: "REAL order placed in the user's Robinhood brokerage account. Use brokerage_orders to track state; brokerage_cancel_order cancels while open.",
  });
}

/** Cancel one open order by its Robinhood order id. */
export async function cancelOrder(creds: BrokerageCreds, orderId: string): Promise<BkResult> {
  const res = await brokerageRequest(creds, "POST", `/api/v2/crypto/trading/orders/${encodeURIComponent(orderId)}/cancel/`);
  if (!res.ok) return res;
  return bkOk({ kind: "brokerage_cancel_receipt", orderId, result: res.data, note: "Cancel submitted — verify with brokerage_orders; fills that raced the cancel stand." });
}

// ── Reads used by the tool surface ─────────────────────────────────────────

export const brokerageReads = {
  async accounts(creds: BrokerageCreds): Promise<BkResult> {
    const res = await brokerageRequest(creds, "GET", "/api/v2/crypto/trading/accounts/");
    if (!res.ok) return res;
    return bkOk({ apiKey: maskApiKey(creds.apiKey), credentialSource: creds.source, ...(res.data as object) });
  },

  async holdings(creds: BrokerageCreds, args: { accountNumber?: string; assetCodes?: string[] }): Promise<BkResult> {
    const account = await resolveAccountNumber(creds, args.accountNumber);
    if ("error" in account) return account.error;
    const codes = (args.assetCodes ?? []).map((c) => `&asset_code=${encodeURIComponent(c.toUpperCase())}`).join("");
    const page = await brokeragePaginate(creds, `/api/v2/crypto/trading/holdings/?account_number=${encodeURIComponent(account.accountNumber)}${codes}`);
    if (!page.ok) return bkFail(page.status, page.message);
    return bkOk({ accountNumber: account.accountNumber, count: page.results.length, holdings: page.results, ...(page.truncated ? { note: "More pages exist — filter by assetCodes for the rest." } : {}) });
  },

  async tradingPairs(creds: BrokerageCreds, args: { symbols?: string[] }): Promise<BkResult> {
    const q = (args.symbols ?? []).map((s, i) => `${i === 0 ? "?" : "&"}symbol=${encodeURIComponent(s.toUpperCase())}`).join("");
    const page = await brokeragePaginate(creds, `/api/v2/crypto/trading/trading_pairs/${q}`);
    if (!page.ok) return bkFail(page.status, page.message);
    return bkOk({ count: page.results.length, pairs: page.results, ...(page.truncated ? { note: "List truncated — pass symbols to look up specific pairs." } : {}) });
  },

  async bestBidAsk(creds: BrokerageCreds, args: { symbols: string[] }): Promise<BkResult> {
    const q = args.symbols.map((s, i) => `${i === 0 ? "?" : "&"}symbol=${encodeURIComponent(s.toUpperCase())}`).join("");
    return brokerageRequest(creds, "GET", `/api/v2/crypto/marketdata/best_bid_ask/${q}`);
  },

  async estimatedPrice(creds: BrokerageCreds, args: { symbol: string; side: "bid" | "ask" | "both"; quantity: string }): Promise<BkResult> {
    return brokerageRequest(
      creds,
      "GET",
      `/api/v2/crypto/trading/estimated_price/?symbol=${encodeURIComponent(args.symbol.toUpperCase())}&side=${args.side}&quantity=${encodeURIComponent(args.quantity)}`,
    );
  },

  async orders(
    creds: BrokerageCreds,
    args: { accountNumber?: string; orderId?: string; symbol?: string; side?: OrderSide; type?: OrderType; state?: string; limit?: number },
  ): Promise<BkResult> {
    const account = await resolveAccountNumber(creds, args.accountNumber);
    if ("error" in account) return account.error;
    const acct = `account_number=${encodeURIComponent(account.accountNumber)}`;
    if (args.orderId) return brokerageRequest(creds, "GET", `/api/v2/crypto/trading/orders/${encodeURIComponent(args.orderId)}/?${acct}`);
    const filters = [
      args.symbol ? `symbol=${encodeURIComponent(args.symbol.toUpperCase())}` : null,
      args.side ? `side=${args.side}` : null,
      args.type ? `type=${args.type}` : null,
      args.state ? `state=${args.state}` : null,
      args.limit ? `limit=${args.limit}` : null,
    ]
      .filter(Boolean)
      .join("&");
    const page = await brokeragePaginate(creds, `/api/v2/crypto/trading/orders/?${acct}${filters ? `&${filters}` : ""}`, 3);
    if (!page.ok) return bkFail(page.status, page.message);
    return bkOk({ accountNumber: account.accountNumber, count: page.results.length, orders: page.results, ...(page.truncated ? { note: "More pages exist — narrow with symbol/state/created filters." } : {}) });
  },
};
