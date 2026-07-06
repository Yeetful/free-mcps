import { describe, it, expect } from "vitest";
import { fillMatches, orderUpdateSettles, awaitSettlement, TERMINAL_ORDER_STATUSES } from "@/lib/watch";

// ── Pure matchers ────────────────────────────────────────────────────────────

describe("fillMatches", () => {
  it("matches any fill when no filter is set", () => {
    expect(fillMatches({ coin: "ETH", oid: 1 }, {})).toBe(true);
  });

  it("matches by numeric oid", () => {
    expect(fillMatches({ coin: "ETH", oid: 42 }, { oid: 42 })).toBe(true);
    expect(fillMatches({ coin: "ETH", oid: 43 }, { oid: 42 })).toBe(false);
  });

  it("matches by cloid case-insensitively", () => {
    const cloid = "0x" + "AB".repeat(16);
    expect(fillMatches({ coin: "ETH", oid: 1, cloid }, { oid: cloid.toLowerCase() })).toBe(true);
  });

  it("filters by coin case-insensitively", () => {
    expect(fillMatches({ coin: "ETH", oid: 1 }, { coin: "eth" })).toBe(true);
    expect(fillMatches({ coin: "BTC", oid: 1 }, { coin: "eth" })).toBe(false);
  });
});

describe("orderUpdateSettles", () => {
  it("settles on terminal statuses only", () => {
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(orderUpdateSettles({ order: { oid: 7, coin: "ETH" }, status }, { oid: 7 })).toBe(true);
    }
    expect(orderUpdateSettles({ order: { oid: 7, coin: "ETH" }, status: "open" }, { oid: 7 })).toBe(false);
    expect(orderUpdateSettles({ order: { oid: 7, coin: "ETH" }, status: "triggered" }, { oid: 7 })).toBe(false);
  });

  it("ignores terminal updates for other orders", () => {
    expect(orderUpdateSettles({ order: { oid: 8, coin: "ETH" }, status: "filled" }, { oid: 7 })).toBe(false);
  });
});

// ── awaitSettlement with a fake WebSocket ────────────────────────────────────

class FakeWS {
  static instances: FakeWS[] = [];
  static onConstruct: ((ws: FakeWS) => void) | null = null;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.();
      FakeWS.onConstruct?.(this);
    });
  }
  send(m: string) {
    this.sent.push(m);
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const asWS = FakeWS as unknown as typeof WebSocket;

const USER = "0x" + "a".repeat(40);

const orderStatusFetch = (payload: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;

describe("awaitSettlement", () => {
  it("returns instantly (no WS) when the order already settled", async () => {
    const bomb = function () {
      throw new Error("WS must not be opened for an already-settled order");
    } as unknown as typeof WebSocket;
    const r = await awaitSettlement(
      { user: USER, oid: 42 },
      {
        fetchImpl: orderStatusFetch({ status: "order", order: { status: "filled", order: { oid: 42 } } }),
        WebSocketImpl: bomb,
      },
    );
    expect(r).toMatchObject({ settled: true, outcome: "already_settled" });
    expect(r.note).toContain("filled");
  });

  it("errors on an unknown oid instead of waiting for nothing", async () => {
    const r = await awaitSettlement(
      { user: USER, oid: 42 },
      { fetchImpl: orderStatusFetch({ status: "unknownOid" }), WebSocketImpl: asWS },
    );
    expect(r).toMatchObject({ settled: false, outcome: "error" });
  });

  it("subscribes to userFills + orderUpdates and settles on a terminal order update", async () => {
    FakeWS.instances.length = 0;
    FakeWS.onConstruct = (ws) => {
      ws.emit({ channel: "orderUpdates", data: [{ order: { oid: 7, coin: "ETH" }, status: "filled", statusTimestamp: 1 }] });
    };
    const r = await awaitSettlement(
      { user: USER, oid: 7, timeoutSeconds: 2 },
      { fetchImpl: orderStatusFetch({ status: "order", order: { status: "open", order: { oid: 7 } } }), WebSocketImpl: asWS },
    );
    FakeWS.onConstruct = null;
    expect(r).toMatchObject({ settled: true, outcome: "order_terminal" });
    expect(r.orderUpdates).toHaveLength(1);
    const subs = FakeWS.instances[0]!.sent.map((s) => JSON.parse(s) as { subscription: { type: string; user: string } });
    expect(subs.map((s) => s.subscription.type).sort()).toEqual(["orderUpdates", "userFills"]);
    expect(subs.every((s) => s.subscription.user === USER)).toBe(true);
    expect(FakeWS.instances[0]!.closed).toBe(true);
  });

  it("ignores snapshot fills without an oid but settles on a live fill", async () => {
    FakeWS.onConstruct = (ws) => {
      ws.emit({ channel: "userFills", data: { user: USER, isSnapshot: true, fills: [{ coin: "ETH", oid: 1 }] } });
      ws.emit({ channel: "userFills", data: { user: USER, fills: [{ coin: "ETH", oid: 2, px: "1770" }] } });
    };
    const r = await awaitSettlement({ user: USER, timeoutSeconds: 2 }, { WebSocketImpl: asWS });
    FakeWS.onConstruct = null;
    expect(r).toMatchObject({ settled: true, outcome: "fill" });
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ oid: 2 });
  });

  it("counts a snapshot fill as settlement when watching a specific oid", async () => {
    FakeWS.onConstruct = (ws) => {
      ws.emit({ channel: "userFills", data: { user: USER, isSnapshot: true, fills: [{ coin: "ETH", oid: 42 }] } });
    };
    const r = await awaitSettlement(
      { user: USER, oid: 42, timeoutSeconds: 2 },
      { fetchImpl: orderStatusFetch({ status: "order", order: { status: "open", order: { oid: 42 } } }), WebSocketImpl: asWS },
    );
    FakeWS.onConstruct = null;
    expect(r).toMatchObject({ settled: true, outcome: "fill" });
  });

  it("times out cleanly when nothing settles", async () => {
    FakeWS.onConstruct = (ws) => {
      // A non-matching, non-terminal update should be captured but not settle.
      ws.emit({ channel: "orderUpdates", data: [{ order: { oid: 9, coin: "ETH" }, status: "open", statusTimestamp: 1 }] });
    };
    const r = await awaitSettlement({ user: USER, timeoutSeconds: 1 }, { WebSocketImpl: asWS });
    FakeWS.onConstruct = null;
    expect(r).toMatchObject({ settled: false, outcome: "timeout" });
    expect(r.orderUpdates).toHaveLength(1);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1000);
  });
});
