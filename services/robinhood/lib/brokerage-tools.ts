// The Robinhood BROKERAGE tool surface (Crypto Trading API — the user's real
// Robinhood crypto account at trading.robinhood.com). Registered alongside
// the Robinhood Chain tools; every tool resolves credentials per-request
// (multi-tenant hosted) with an env fallback for self-hosted deployments —
// see lib/brokerage.ts.
//
// Consent model: there is no wallet signature in a brokerage flow, so writes
// are fail-closed two-step — brokerage_build_order (read-only preview + one-
// time confirm token) then brokerage_submit_order (token + exact params or
// refusal). Submission moves REAL MONEY.

import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { clip } from "./util";
import { resolveCreds, type BkResult, type ToolExtra } from "./brokerage";
import {
  ORDER_SIDES,
  ORDER_TYPES,
  brokerageReads,
  buildOrder,
  cancelOrder,
  submitOrder,
} from "./brokerage-orders";

function present(result: BkResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result.data === "string" ? result.data : `Robinhood brokerage error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(result.data)) }] };
}

function credsError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// ── Shared arg schemas ───────────────────────────────────────────────────────

const pairSymbolArg = z
  .string()
  .regex(/^[A-Za-z0-9]{1,15}-USD$/i)
  .transform((s) => s.toUpperCase())
  .describe('Crypto trading pair against USD, e.g. "BTC-USD", "ETH-USD" (brokerage symbols, not token addresses).');

const accountNumberArg = z
  .string()
  .min(1)
  .max(40)
  .optional()
  .describe("Robinhood crypto account number. Omit to use the credential's first (usually only) account.");

const decimalArg = (what: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .describe(what);

const sideArg = z.enum(ORDER_SIDES).describe('"buy" or "sell".');
const typeArg = z.enum(ORDER_TYPES).describe('Order type: "market", "limit", "stop_loss", or "stop_limit".');

const orderArgSchemas = {
  accountNumber: accountNumberArg,
  symbol: pairSymbolArg,
  side: sideArg,
  type: typeArg,
  assetQuantity: decimalArg('Crypto amount as a decimal string, e.g. "0.001" BTC. Market orders require this; limit/stop orders take this OR quoteAmount.').optional(),
  quoteAmount: decimalArg('USD notional as a decimal string, e.g. "25". Limit/stop orders only — exactly one of assetQuantity/quoteAmount.').optional(),
  limitPrice: decimalArg("Limit price in USD (limit and stop_limit orders).").optional(),
  stopPrice: decimalArg("Stop trigger price in USD (stop_loss and stop_limit orders).").optional(),
  timeInForce: z.enum(["gtc"]).optional().describe('Time in force for non-market orders. Only "gtc" (good-til-canceled) is supported; default "gtc".'),
};

const BYOK_NOTE =
  " Uses YOUR Robinhood API credentials: per-request 'x-robinhood-api-key' + 'x-robinhood-private-key' headers (env vars on self-hosted deployments).";

/** Register the Robinhood brokerage (Crypto Trading API) tool surface. */
export function registerBrokerageTools(server: Server): void {
  // ── Reads ──────────────────────────────────────────────────────────────
  server.registerTool(
    "brokerage_accounts",
    {
      title: "Brokerage: Crypto Trading Accounts",
      description:
        "The user's Robinhood CRYPTO BROKERAGE account(s) — account number, status, buying power, and fee-tier info from the Robinhood Crypto Trading API (this is the real Robinhood app account, NOT an on-chain wallet). Answers 'what's my Robinhood crypto buying power?'." +
        BYOK_NOTE,
      inputSchema: {},
    },
    async (_args, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.accounts(c.creds));
    },
  );

  server.registerTool(
    "brokerage_holdings",
    {
      title: "Brokerage: Crypto Holdings",
      description:
        "Crypto held in the user's Robinhood brokerage account — total and available quantity per asset (BTC, ETH, …). This is custodial brokerage crypto, separate from any on-chain wallet. Answers 'how much BTC do I hold on Robinhood?'." +
        BYOK_NOTE,
      inputSchema: {
        accountNumber: accountNumberArg,
        assetCodes: z.array(z.string().min(1).max(15)).max(20).optional().describe('Filter by asset codes, e.g. ["BTC","ETH"]. Omit for all holdings.'),
      },
    },
    async ({ accountNumber, assetCodes }, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.holdings(c.creds, { accountNumber, assetCodes }));
    },
  );

  server.registerTool(
    "brokerage_trading_pairs",
    {
      title: "Brokerage: Tradable Pairs",
      description:
        "Crypto pairs tradable through the Robinhood brokerage API (BTC-USD, ETH-USD, …) with min/max order sizes, price increments, and tradability status. Answers 'what crypto can I trade on Robinhood?'." +
        BYOK_NOTE,
      inputSchema: {
        symbols: z.array(pairSymbolArg).max(20).optional().describe("Specific pairs to look up. Omit for the full tradable list."),
      },
    },
    async ({ symbols }, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.tradingPairs(c.creds, { symbols }));
    },
  );

  server.registerTool(
    "brokerage_best_bid_ask",
    {
      title: "Brokerage: Best Bid/Ask",
      description:
        "Live best bid and ask per crypto pair from Robinhood's partner exchanges (spread included; excludes order-size impact and fees). Answers 'what's BTC trading at on Robinhood?'." +
        BYOK_NOTE,
      inputSchema: {
        symbols: z.array(pairSymbolArg).min(1).max(20).describe('Pairs to quote, e.g. ["BTC-USD"].'),
      },
    },
    async ({ symbols }, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.bestBidAsk(c.creds, { symbols }));
    },
  );

  server.registerTool(
    "brokerage_estimated_price",
    {
      title: "Brokerage: Estimated Execution Price",
      description:
        "Estimated execution price for hypothetical order sizes on one pair — ask side prices a buy, bid side a sell, and up to 10 quantities can be checked at once. The pre-trade cost check. Answers 'what would 0.1 BTC cost me on Robinhood?'." +
        BYOK_NOTE,
      inputSchema: {
        symbol: pairSymbolArg,
        side: z.enum(["bid", "ask", "both"]).describe('Book side: "ask" prices a BUY, "bid" prices a SELL, "both" returns both.'),
        quantity: z
          .string()
          .regex(/^\d+(\.\d+)?(,\d+(\.\d+)?){0,9}$/)
          .describe('Asset quantity, or up to 10 comma-separated quantities, e.g. "0.1" or "0.1,1,2.5".'),
      },
    },
    async ({ symbol, side, quantity }, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.estimatedPrice(c.creds, { symbol, side, quantity }));
    },
  );

  server.registerTool(
    "brokerage_orders",
    {
      title: "Brokerage: Orders",
      description:
        "The user's Robinhood crypto orders — pass orderId for one order's full state (fills, average price, fees), or filter the list by symbol/side/type/state. Answers 'is my Robinhood BTC order filled?'." +
        BYOK_NOTE,
      inputSchema: {
        accountNumber: accountNumberArg,
        orderId: z.string().uuid().optional().describe("One order's id (UUID) for a detailed lookup. Omit to list."),
        symbol: pairSymbolArg.optional(),
        side: sideArg.optional(),
        type: typeArg.optional(),
        state: z.enum(["open", "canceled", "partially_filled", "filled", "failed", "pending"]).optional().describe("Filter by order state."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default API-defined)."),
      },
    },
    async (args, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await brokerageReads.orders(c.creds, args));
    },
  );

  // ── Writes (fail-closed two-step; REAL money) ──────────────────────────
  server.registerTool(
    "brokerage_build_order",
    {
      title: "Brokerage: Build Order (step 1 of 2 — preview only)",
      description:
        "STEP 1 of the guarded order flow — READ-ONLY. Validates a crypto order (market/limit/stop_loss/stop_limit) against live Robinhood trading-pair limits and estimated execution price, then returns a full-cost PREVIEW (estimated USD notional, exact order config) plus a one-time confirmToken (5-minute TTL). NOTHING is placed. Show the user the preview and get their explicit approval before ever calling brokerage_submit_order — that second call moves REAL MONEY in their Robinhood brokerage account." +
        BYOK_NOTE,
      inputSchema: orderArgSchemas,
    },
    async (args, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await buildOrder(c.creds, args));
    },
  );

  server.registerTool(
    "brokerage_submit_order",
    {
      title: "Brokerage: Submit Order (step 2 of 2 — MOVES REAL MONEY)",
      description:
        "STEP 2 — PLACES A REAL ORDER in the user's Robinhood brokerage account, spending their actual money. Requires the confirmToken from brokerage_build_order plus the EXACT same order params; refuses on any mismatch, credential change, or token older than 5 minutes. Never call this without the user's explicit approval of the step-1 preview. Construction and submission are deliberately separate calls — there is no one-shot order tool.",
      inputSchema: {
        ...orderArgSchemas,
        confirmToken: z.string().min(20).describe("The one-time confirmToken from brokerage_build_order (expires 5 minutes after the preview)."),
      },
    },
    async (args, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await submitOrder(c.creds, args));
    },
  );

  server.registerTool(
    "brokerage_cancel_order",
    {
      title: "Brokerage: Cancel Order",
      description:
        "Cancel one OPEN Robinhood crypto order by id. Cancellation is best-effort — a fill that races the cancel stands; verify the final state with brokerage_orders." +
        BYOK_NOTE,
      inputSchema: {
        orderId: z.string().uuid().describe("The order id (UUID) from brokerage_orders or the submit receipt."),
      },
    },
    async ({ orderId }, extra) => {
      const c = resolveCreds(extra as ToolExtra);
      if ("error" in c) return credsError(c.error);
      return present(await cancelOrder(c.creds, orderId));
    },
  );
}
