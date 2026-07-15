// Robinhood Crypto Trading API (the BROKERAGE — trading.robinhood.com, the
// user's actual Robinhood crypto account; nothing to do with Robinhood Chain
// RPC reads elsewhere in this service). Ed25519 request signing per
// docs.robinhood.com/crypto/trading:
//
//   x-api-key    = the credential's API key ("rh-api-<uuid>")
//   x-timestamp  = unix SECONDS, only valid for 30s
//   x-signature  = base64( Ed25519_sign( "{apiKey}{timestamp}{path}{method}{body}" ) )
//
// where `path` includes the query string exactly as sent, `method` is
// uppercase, and `body` is the EXACT body string transmitted (omitted
// entirely for body-less requests). The private key is a base64-encoded
// 32-byte Ed25519 seed. We always sign the same JSON string we transmit.
//
// MULTI-TENANCY: this service is hosted publicly at a *-mcp.yeetful.com
// subdomain, so the server's own env credentials must never serve strangers.
// Per-request credentials arrive via the x-robinhood-api-key +
// x-robinhood-private-key HTTP headers and always take precedence; the
// ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY env fallback exists for
// local/self-hosted deployments only. With neither, tools return a
// bring-your-own-key setup message instead of failing cryptically.

import { ed25519 } from "@noble/curves/ed25519";

export const BROKERAGE_BASE = "https://trading.robinhood.com";

/** Per-request credential headers (lowercase — HTTP headers arrive lowercased). */
export const API_KEY_HEADER = "x-robinhood-api-key";
export const PRIVATE_KEY_HEADER = "x-robinhood-private-key";

/** Docs-accurate setup instructions, returned when no credentials are found. */
export const SETUP_MESSAGE =
  "No Robinhood Crypto Trading API credentials. This tool talks to YOUR Robinhood brokerage account, so you must bring your own key pair: " +
  "(1) generate an Ed25519 key pair (docs.robinhood.com/crypto/trading — 'Creating a key pair'), " +
  "(2) register the PUBLIC key in your Robinhood crypto account settings (web classic) to get an API key ('rh-api-…'), " +
  `(3) send both with each MCP request as HTTP headers: '${API_KEY_HEADER}: <your rh-api-… key>' and '${PRIVATE_KEY_HEADER}: <base64 32-byte Ed25519 private-key seed>'. ` +
  "Self-hosted deployments may instead set the ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY environment variables. " +
  "Robinhood never sees Yeetful, and this service never stores your key.";

export interface BrokerageCreds {
  apiKey: string;
  /** 32-byte Ed25519 private-key seed. */
  seed: Uint8Array;
  source: "request" | "env";
}

export interface BkResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export const bkOk = (data: unknown): BkResult => ({ ok: true, status: 200, data });
export const bkFail = (status: number, message: string): BkResult => ({ ok: false, status, data: message });

// ── Credential resolution ──────────────────────────────────────────────────

function decodeSeed(b64: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(b64.trim(), "base64");
    // Round-trip check: reject strings that silently decode to garbage.
    if (bytes.length !== 32) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  // Fetch-style header records are lowercase already; be tolerant anyway.
  const raw = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : undefined;
  return typeof raw === "string" ? raw : undefined;
}

/** The MCP SDK hands tool callbacks `extra.requestInfo.headers` on Streamable HTTP. */
export type ToolExtra = { requestInfo?: { headers?: Record<string, unknown> } } | undefined;

/**
 * Resolve credentials: per-request headers first (multi-tenant hosted path),
 * env second (self-hosted), setup message when neither is present.
 */
export function resolveCreds(extra: ToolExtra): { creds: BrokerageCreds } | { error: string } {
  const headers = extra?.requestInfo?.headers;
  const headerKey = headerValue(headers, API_KEY_HEADER);
  const headerSeed = headerValue(headers, PRIVATE_KEY_HEADER);

  if (headerKey || headerSeed) {
    if (!headerKey || !headerSeed)
      return { error: `Incomplete per-request credentials: send BOTH '${API_KEY_HEADER}' and '${PRIVATE_KEY_HEADER}' headers.` };
    const seed = decodeSeed(headerSeed);
    if (!seed) return { error: `'${PRIVATE_KEY_HEADER}' must be the base64-encoded 32-byte Ed25519 private-key seed from your generated key pair.` };
    return { creds: { apiKey: headerKey.trim(), seed, source: "request" } };
  }

  const envKey = process.env.ROBINHOOD_API_KEY;
  const envSeed = process.env.ROBINHOOD_PRIVATE_KEY;
  if (envKey && envSeed) {
    const seed = decodeSeed(envSeed);
    if (!seed) return { error: "ROBINHOOD_PRIVATE_KEY env var is not a base64-encoded 32-byte Ed25519 seed." };
    return { creds: { apiKey: envKey.trim(), seed, source: "env" } };
  }

  return { error: SETUP_MESSAGE };
}

/** "rh-api-6148…6be6" — safe to echo in previews/errors. Never echo the seed. */
export function maskApiKey(apiKey: string): string {
  return apiKey.length <= 12 ? "***" : `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`;
}

// ── Signing ────────────────────────────────────────────────────────────────

/**
 * Sign one request. `pathWithQuery` must be exactly what is sent on the wire
 * (query string included); `body` must be the EXACT string transmitted, or
 * undefined for body-less requests (then it is omitted from the message).
 */
export function signRequest(
  creds: BrokerageCreds,
  method: "GET" | "POST",
  pathWithQuery: string,
  body: string | undefined,
  timestampSec: number,
): Record<string, string> {
  const message = `${creds.apiKey}${timestampSec}${pathWithQuery}${method}${body ?? ""}`;
  const signature = ed25519.sign(new TextEncoder().encode(message), creds.seed);
  return {
    "x-api-key": creds.apiKey,
    "x-timestamp": String(timestampSec),
    "x-signature": Buffer.from(signature).toString("base64"),
  };
}

// ── HTTP (injectable seams for unit tests) ─────────────────────────────────

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Test seam. */
export function setBrokerageFetchForTests(fake: FetchLike | null) {
  fetchImpl = fake ?? ((...args) => fetch(...args));
}

let nowSec = () => Math.floor(Date.now() / 1000);
/** Test seam — timestamps are only valid for 30s, so tests pin the clock. */
export function setBrokerageClockForTests(fake: (() => number) | null) {
  nowSec = fake ?? (() => Math.floor(Date.now() / 1000));
}
export const brokerageNowSec = () => nowSec();

/**
 * One signed request to the brokerage API. The timestamp is generated at call
 * time (valid 30s) and the signature covers exactly what is transmitted.
 */
export async function brokerageRequest(
  creds: BrokerageCreds,
  method: "GET" | "POST",
  pathWithQuery: string,
  bodyObj?: unknown,
): Promise<BkResult> {
  // Sign the exact JSON string we transmit — NOT a Python-repr lookalike.
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const headers: Record<string, string> = {
    ...signRequest(creds, method, pathWithQuery, body, nowSec()),
    ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(`${BROKERAGE_BASE}${pathWithQuery}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (e.g. cancel returns plain text) — keep the text */
    }
    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      const hint =
        res.status === 401 || res.status === 403
          ? " (check the API key, that the registered PUBLIC key matches your private-key seed, and your machine clock — x-timestamp is only valid for 30s)"
          : res.status === 429
            ? " (Robinhood rate limit: ~100 req/min per account — back off and retry)"
            : "";
      return { ok: false, status: res.status, data: `Robinhood brokerage API HTTP ${res.status}${hint}: ${detail}` };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return bkFail(502, `Robinhood brokerage API request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Pagination ─────────────────────────────────────────────────────────────

interface Page {
  next?: string | null;
  previous?: string | null;
  results?: unknown[];
}

/**
 * Follow `next` cursors, collecting `results`. Only follows next-URLs on
 * trading.robinhood.com (the cursor URL comes from the response — never
 * follow it anywhere else). Capped at `maxPages`.
 */
export async function brokeragePaginate(
  creds: BrokerageCreds,
  firstPathWithQuery: string,
  maxPages = 10,
): Promise<{ ok: true; results: unknown[]; pages: number; truncated: boolean } | { ok: false; status: number; message: string }> {
  const results: unknown[] = [];
  let path: string | null = firstPathWithQuery;
  let pages = 0;
  while (path && pages < maxPages) {
    const res: BkResult = await brokerageRequest(creds, "GET", path);
    if (!res.ok) return { ok: false, status: res.status, message: String(res.data) };
    const page = res.data as Page;
    results.push(...(page.results ?? []));
    pages++;
    path = null;
    if (page.next) {
      if (!page.next.startsWith(`${BROKERAGE_BASE}/`)) {
        // Response-controlled URL pointing off-host — refuse to follow it.
        return { ok: true, results, pages, truncated: true };
      }
      path = page.next.slice(BROKERAGE_BASE.length);
    }
  }
  return { ok: true, results, pages, truncated: !!path };
}
