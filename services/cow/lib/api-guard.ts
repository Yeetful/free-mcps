// Guard for the `api_get` escape hatch (RR12 tier pattern — same role as
// hyperliquid's info-guard and snapshot's graphql-guard). The order-book API
// is read-only over GET by construction (order placement is POST /orders,
// cancellation is DELETE — neither reachable through this tool), so the
// guard's job is scope + hygiene: only documented read paths pass, query
// strings stay small, and nothing outside /api/v1 + /api/v2 can be reached.

const ADDR = "0x[a-fA-F0-9]{40}";
const UID = "0x[a-fA-F0-9]{112}";
const HASH = "0x[a-fA-F0-9]{64}";

// Path patterns, anchored. Paths INCLUDE the API version prefix.
// NOT listed on purpose: /v1/auction (403 at api.cow.fi's edge, probed
// 2026-07-06) and anything under /v1/solver_competition (it moved to /v2).
export const ALLOWED_GET_PATHS: { pattern: RegExp; example: string }[] = [
  { pattern: new RegExp(`^/v1/orders/${UID}$`), example: "/v1/orders/{orderUid}" },
  { pattern: new RegExp(`^/v1/account/${ADDR}/orders$`), example: "/v1/account/{owner}/orders?limit=10" },
  { pattern: new RegExp(`^/v1/trades$`), example: "/v1/trades?owner=0x… (or ?orderUid=0x…)" },
  { pattern: new RegExp(`^/v1/token/${ADDR}/native_price$`), example: "/v1/token/{address}/native_price" },
  { pattern: new RegExp(`^/v1/app_data/${HASH}$`), example: "/v1/app_data/{appDataHash}" },
  { pattern: new RegExp(`^/v1/users/${ADDR}/total_surplus$`), example: "/v1/users/{address}/total_surplus" },
  { pattern: new RegExp(`^/v1/version$`), example: "/v1/version" },
  { pattern: new RegExp(`^/v2/solver_competition/latest$`), example: "/v2/solver_competition/latest" },
  { pattern: new RegExp(`^/v2/solver_competition/by_tx_hash/${HASH}$`), example: "/v2/solver_competition/by_tx_hash/{txHash}" },
  { pattern: new RegExp(`^/v2/solver_competition/${UID}$`), example: "/v2/solver_competition/{auctionIdOrOrderUid}" },
];

export const ALLOWED_PATH_EXAMPLES = ALLOWED_GET_PATHS.map((p) => p.example);

const MAX_QUERY_CHARS = 500;

export type GuardResult = { ok: true; path: string; query: string } | { ok: false; error: string };

export function guardApiGet(rawPath: unknown): GuardResult {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, error: "path must be a string like \"/v1/trades?owner=0x…\"" };
  }
  if (rawPath.length > 700) {
    return { ok: false, error: "path too long" };
  }
  const qIdx = rawPath.indexOf("?");
  const path = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
  const query = qIdx === -1 ? "" : rawPath.slice(qIdx + 1);

  if (!path.startsWith("/")) {
    return { ok: false, error: "path must start with '/', e.g. /v1/version" };
  }
  if (path.includes("..") || path.includes("//") || /\s/.test(rawPath)) {
    return { ok: false, error: "path contains forbidden characters" };
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `query string too long (max ${MAX_QUERY_CHARS} chars)` };
  }
  if (query.includes("#") || query.includes("?")) {
    return { ok: false, error: "query string contains forbidden characters" };
  }
  if (!ALLOWED_GET_PATHS.some((p) => p.pattern.test(path))) {
    return {
      ok: false,
      error: `path "${path}" is not in the read-only allowlist. Allowed: ${ALLOWED_PATH_EXAMPLES.join(" · ")}`,
    };
  }
  return { ok: true, path, query };
}
