// Real-time settlement watching over the Hyperliquid WebSocket.
//
// An MCP tool call is request/response, but "did my order fill?" is an event.
// Bridge: open a WS INSIDE the tool call, subscribe to the user's fills +
// order updates, and resolve as soon as a matching event lands (or on
// timeout). The socket lives only for the duration of the call — bounded well
// under the route's maxDuration and under the server's 60s idle close, so no
// ping loop or reconnect logic is needed. Vercel-serverless-safe.
//
// (WS channel shapes per the Hyperliquid docs / @nktkas/hyperliquid:
//  userFills → {user, fills:[...], isSnapshot?} — first message is a snapshot;
//  orderUpdates → [{order:{coin,oid,cloid?,...}, status, statusTimestamp}].)

import { WS_URL, infoRequest, type HlOpts } from "./hyperliquid";

export const TERMINAL_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "marginCanceled",
  "rejected",
  "expired",
  "reduceOnlyCanceled",
  "liquidatedCanceled",
  "delistedCanceled",
]);

export interface WatchFilter {
  oid?: number | string; // numeric oid or 0x… cloid
  coin?: string;
}

interface WsFill {
  coin?: string;
  oid?: number;
  cloid?: string;
  [k: string]: unknown;
}

interface WsOrderUpdate {
  order?: { coin?: string; oid?: number; cloid?: string };
  status?: string;
  [k: string]: unknown;
}

const oidMatches = (filter: WatchFilter, oid?: number, cloid?: string): boolean => {
  if (filter.oid === undefined) return true;
  if (typeof filter.oid === "number") return oid === filter.oid;
  return typeof cloid === "string" && cloid.toLowerCase() === filter.oid.toLowerCase();
};

const coinMatches = (filter: WatchFilter, coin?: string): boolean =>
  !filter.coin || (coin ?? "").toUpperCase() === filter.coin.toUpperCase();

/** Does a userFills fill event match the watch filter? (pure — unit tested) */
export function fillMatches(fill: WsFill, filter: WatchFilter): boolean {
  return oidMatches(filter, fill.oid, fill.cloid) && coinMatches(filter, fill.coin);
}

/** Does an orderUpdates event match the filter AND end the order's life? */
export function orderUpdateSettles(update: WsOrderUpdate, filter: WatchFilter): boolean {
  if (!oidMatches(filter, update.order?.oid, update.order?.cloid)) return false;
  if (!coinMatches(filter, update.order?.coin)) return false;
  return typeof update.status === "string" && TERMINAL_ORDER_STATUSES.has(update.status);
}

export interface AwaitSettlementArgs extends WatchFilter {
  user: string;
  timeoutSeconds?: number;
}

export interface AwaitSettlementResult {
  settled: boolean;
  outcome: "already_settled" | "fill" | "order_terminal" | "timeout" | "error";
  elapsedMs: number;
  fills: WsFill[];
  orderUpdates: WsOrderUpdate[];
  order?: unknown; // orderStatus pre-check result, when an oid was given
  note: string;
}

// Injectable seams for tests.
export interface WatchOpts extends HlOpts {
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 45; // stay under the route's maxDuration (60s)

/**
 * Wait for a user's order to settle (fill / cancel / reject) or, with no
 * `oid`, for their next fill. Checks orderStatus over HTTP first so an
 * already-settled order returns instantly instead of waiting on an event
 * that will never re-fire.
 */
export async function awaitSettlement(
  args: AwaitSettlementArgs,
  opts?: WatchOpts,
): Promise<AwaitSettlementResult> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(args.timeoutSeconds ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1_000;

  // 1. Pre-check: if we're watching a specific order, it may already be done.
  if (args.oid !== undefined) {
    const r = await infoRequest({ type: "orderStatus", user: args.user, oid: args.oid }, opts);
    if (r.ok) {
      const data = r.data as { status?: string; order?: { status?: string; order?: unknown } };
      const orderState = data.order?.status;
      if (data.status === "order" && orderState && TERMINAL_ORDER_STATUSES.has(orderState)) {
        return {
          settled: true,
          outcome: "already_settled",
          elapsedMs: Date.now() - started,
          fills: [],
          orderUpdates: [],
          order: data.order,
          note: `Order ${args.oid} is already ${orderState} — no waiting needed.`,
        };
      }
      if (data.status === "unknownOid") {
        return {
          settled: false,
          outcome: "error",
          elapsedMs: Date.now() - started,
          fills: [],
          orderUpdates: [],
          note: `Order ${args.oid} is unknown for ${args.user} — check the oid/cloid and address.`,
        };
      }
    }
  }

  // 2. Live watch over WS.
  const WS = opts?.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) {
    return {
      settled: false,
      outcome: "error",
      elapsedMs: Date.now() - started,
      fills: [],
      orderUpdates: [],
      note: "WebSocket is unavailable in this runtime (needs Node ≥21). Poll order_status instead.",
    };
  }

  const fills: WsFill[] = [];
  const orderUpdates: WsOrderUpdate[] = [];

  return new Promise<AwaitSettlementResult>((resolve) => {
    let done = false;
    const ws = new WS(WS_URL());

    const finish = (partial: Pick<AwaitSettlementResult, "settled" | "outcome" | "note">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...partial, elapsedMs: Date.now() - started, fills, orderUpdates });
    };

    const timer = setTimeout(() => {
      finish({
        settled: false,
        outcome: "timeout",
        note:
          `No settlement within ${Math.round(timeoutMs / 1000)}s. ` +
          (orderUpdates.length > 0 || fills.length > 0
            ? "Non-terminal activity captured in fills/orderUpdates."
            : "The order may still be resting — check open_orders or call await_settlement again."),
      });
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: args.user } }));
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates", user: args.user } }));
    };

    ws.onerror = () => {
      finish({ settled: false, outcome: "error", note: "WebSocket connection to Hyperliquid failed." });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: { channel?: string; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.channel === "userFills") {
        const d = msg.data as { fills?: WsFill[]; isSnapshot?: boolean };
        // The first message replays recent fills as a snapshot. A snapshot
        // fill still SETTLES an oid-specific watch (it means the order filled
        // moments ago); without an oid, only NEW fills count.
        for (const fill of d?.fills ?? []) {
          if (!fillMatches(fill, args)) continue;
          if (d?.isSnapshot && args.oid === undefined) continue;
          fills.push(fill);
        }
        if (fills.length > 0) {
          finish({ settled: true, outcome: "fill", note: `Fill received for ${args.user}.` });
        }
      } else if (msg.channel === "orderUpdates") {
        const updates = (msg.data as WsOrderUpdate[]) ?? [];
        for (const u of updates) {
          if (oidMatches(args, u.order?.oid, u.order?.cloid) && coinMatches(args, u.order?.coin)) {
            orderUpdates.push(u);
          }
        }
        const terminal = updates.find((u) => orderUpdateSettles(u, args));
        if (terminal) {
          finish({
            settled: true,
            outcome: "order_terminal",
            note: `Order reached terminal status "${terminal.status}".`,
          });
        }
      }
    };
  });
}
