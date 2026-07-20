import { NextResponse, type NextRequest } from "next/server";
import { paymentProxy, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

/**
 * The OPTIONAL paid door for a free MCP service.
 *
 * Ported from @yeetful/x402-service-kit's proven v2 wiring (proxy.ts +
 * config.ts, validated against anthropic-mcp + the Bazaar validator) and
 * adapted for the free fleet's model: ONE codebase serves BOTH tiers.
 * `/mcp` stays the free, rate-limited front door; `/paid/mcp` serves the
 * IDENTICAL tool surface gated by an x402 v2 payment challenge — pay-per-call,
 * no throttle. Free and paid can never drift because both routes register the
 * same tools; the only difference is which front door the request came through.
 *
 * Unlike service-kit (where payment is the product and a missing
 * PAYMENT_ADDRESS must fail the deploy loudly), a free service may ship with
 * the paid door declared but unconfigured. In that case the door FAILS CLOSED:
 * paid paths return 503 pointing at the free door — never silently free-serve
 * a path that advertises itself as paid, and never crash the free tier over
 * missing paid-tier env.
 */

// x402 v2 uses CAIP-2 network ids. Map legacy v1 names so X402_NETWORK=base /
// base-sepolia keeps working.
export function toCaip2(n: string): Network {
  const map: Record<string, string> = {
    base: "eip155:8453",
    "base-sepolia": "eip155:84532",
  };
  return (map[n] ?? n) as Network;
}

export interface X402DoorConfig {
  paymentAddress: `0x${string}`;
  network: Network;
  priceUsd: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}

/** Read the paid door's env. Returns null (door closed) when PAYMENT_ADDRESS
 *  is unset — no fallback pay-to address, ever: a misconfigured deploy must
 *  never route USDC to the wrong wallet. */
export function loadX402DoorConfig(): X402DoorConfig | null {
  const paymentAddress = process.env.PAYMENT_ADDRESS;
  if (!paymentAddress) return null;
  return {
    paymentAddress: paymentAddress as `0x${string}`,
    network: toCaip2(process.env.X402_NETWORK ?? "base"),
    priceUsd: process.env.X402_PRICE_USD ?? "0.02",
    // Read directly by @coinbase/x402's `facilitator`; surfaced for debug only.
    cdpApiKeyId: process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  };
}

/** Normalized facts about one settled payment (decoupled from @x402/core wire
 *  types so earn-tracking callers don't import the payment stack). */
export interface SettledPayment {
  amountUsd: number;
  payer?: string;
  txHash?: string;
  network: string;
}

export interface McpDiscoveryInput {
  toolName: string;
  inputSchema: Record<string, unknown>;
  output?: { example?: unknown };
}

/** Bazaar discovery block for the paid door's challenge. Keep info.input
 *  MINIMAL ({type, toolName, inputSchema}) — agentic.market's stricter parser
 *  rejects the optional description/transport/example keys service-kit learned
 *  this the hard way. */
export function mcpDiscovery(input: McpDiscoveryInput): Record<string, unknown> {
  return declareDiscoveryExtension({
    toolName: input.toolName,
    inputSchema: input.inputSchema,
    output: input.output,
  });
}

export interface PaidDoorOptions {
  /** Path pattern the gate prices, e.g. "/paid/:transport". */
  routeKey: string;
  /** Human/agent-facing resource description (keywords + tool list). */
  description: string;
  /** Bazaar discovery extension from mcpDiscovery(). Optional. */
  discovery?: Record<string, unknown>;
  maxTimeoutSeconds?: number;
  mimeType?: string;
  /** Fired AFTER a successful settlement. Fire-and-forget side effects only —
   *  runs inside the settle path; thrown errors are swallowed. */
  onSettled?: (payment: SettledPayment) => void;
}

/**
 * Build the paid-door middleware. Route ONLY paid paths here from the
 * service's proxy.ts — the returned function assumes the caller already
 * scoped it by pathname:
 *
 *   const paid = createPaidDoorProxy({ routeKey: "/paid/:transport", ... });
 *   const free = createRateLimitProxy();
 *   export function proxy(req: NextRequest) {
 *     if (req.nextUrl.pathname.startsWith("/paid/")) return paid(req);
 *     return free(req);
 *   }
 *   export const config = { matcher: ["/mcp", "/sse", "/paid/mcp", "/paid/sse"] };
 */
export function createPaidDoorProxy(
  opts: PaidDoorOptions,
): (req: NextRequest) => Promise<NextResponse | undefined> | NextResponse | undefined {
  const cfg = loadX402DoorConfig();

  if (!cfg) {
    // Door declared but unconfigured → fail closed with a pointer to the free
    // tier. 503 (not 402): there is no way to pay a door with no pay-to wallet.
    return () =>
      NextResponse.json(
        {
          error: "paid_door_unconfigured",
          message:
            "This deployment's paid door is not configured (PAYMENT_ADDRESS unset). Use the free endpoint at /mcp — same tools, per-IP rate limit.",
        },
        { status: 503 },
      );
  }

  const routes = {
    [opts.routeKey]: {
      accepts: {
        scheme: "exact",
        price: `$${cfg.priceUsd}` as const,
        network: cfg.network,
        payTo: cfg.paymentAddress,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
      },
      description: opts.description,
      mimeType: opts.mimeType ?? "application/json",
      ...(opts.discovery ? { extensions: opts.discovery } : {}),
    },
  };

  const cdpReady = !!cfg.cdpApiKeyId && !!cfg.cdpApiKeySecret;
  const facilitatorClient = new HTTPFacilitatorClient(
    cdpReady ? cdpFacilitator : { url: "https://x402.org/facilitator" },
  );

  const server = new x402ResourceServer(facilitatorClient)
    .register(cfg.network, new ExactEvmScheme())
    // Normalizes the bazaar payload on the way out; without it the extension
    // can be emitted unrecognized (stripped to `{}`).
    .registerExtension(bazaarResourceServerExtension);

  // The exact scheme settles the full configured price, so amountUsd is
  // cfg.priceUsd (NOT result.amount, atomic units). Human network name from
  // env, not result.network (a CAIP-2 id). Errors swallowed — telemetry must
  // never break or slow the paid response.
  if (opts.onSettled) {
    const onSettled = opts.onSettled;
    server.onAfterSettle(async (ctx) => {
      try {
        if (!ctx.result?.success) return;
        onSettled({
          amountUsd: Number(cfg.priceUsd),
          payer: ctx.result.payer,
          txHash: ctx.result.transaction,
          network: process.env.X402_NETWORK ?? "base",
        });
      } catch {
        /* swallowed */
      }
    });
  }

  const gate = paymentProxy(routes, server);
  return async (req: NextRequest) => {
    const res = await gate(req);
    if (!res || res.status !== 402) return res;
    return withChallengeBody(res);
  };
}

/**
 * Echo the v2 PAYMENT-REQUIRED header challenge as the 402's JSON body.
 *
 * @x402/next emits the full discovery document base64-encoded in the
 * PAYMENT-REQUIRED header but ships a body of `{}`. v1-era clients (and any
 * client that parses the body first and only header-falls-back on non-JSON —
 * `{}` IS valid JSON) see an empty `accepts` and refuse to pay. Serving the
 * same challenge in BOTH places makes every client generation happy.
 */
async function withChallengeBody(res: NextResponse): Promise<NextResponse> {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return res;

  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    /* non-JSON body → echo the header challenge */
  }
  if (hasUsableAccepts(body)) return res;

  let challenge: unknown;
  try {
    challenge = decodeChallengeHeader(header);
  } catch {
    return res;
  }
  if (!hasUsableAccepts(challenge)) return res;

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return NextResponse.json(challenge, { status: 402, headers });
}

function hasUsableAccepts(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const accepts = (value as { accepts?: unknown }).accepts;
  return Array.isArray(accepts) && accepts.length > 0;
}

/** Base64 → JSON, Node or edge runtime (Buffer when present, atob otherwise). */
function decodeChallengeHeader(b64: string): unknown {
  const json =
    typeof Buffer !== "undefined"
      ? Buffer.from(b64, "base64").toString("utf8")
      : new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  return JSON.parse(json);
}
