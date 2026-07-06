// Guard for the raw `info_query` escape hatch. The /info endpoint is
// read-only by construction (trading lives on /exchange, which this service
// never touches), so the guard's job is scope + hygiene, not safety-critical
// filtering: only documented read types pass, request bodies stay small, and
// `type` is required so arbitrary junk can't be relayed.

export const ALLOWED_INFO_TYPES = new Set([
  // market data
  "allMids",
  "meta",
  "metaAndAssetCtxs",
  "spotMeta",
  "spotMetaAndAssetCtxs",
  "l2Book",
  "recentTrades",
  "candleSnapshot",
  "fundingHistory",
  "predictedFundings",
  "perpDexs",
  "perpsAtOpenInterestCap",
  "tokenDetails",
  "spotDeployState",
  "exchangeStatus",
  // user data (public by address)
  "clearinghouseState",
  "spotClearinghouseState",
  "openOrders",
  "frontendOpenOrders",
  "historicalOrders",
  "orderStatus",
  "userFills",
  "userFillsByTime",
  "userTwapSliceFills",
  "userFunding",
  "userNonFundingLedgerUpdates",
  "portfolio",
  "userFees",
  "userRateLimit",
  "subAccounts",
  "activeAssetData",
  "referral",
  // vaults + staking
  "vaultDetails",
  "userVaultEquities",
  "delegations",
  "delegatorSummary",
  "delegatorHistory",
  "delegatorRewards",
]);

const MAX_BODY_CHARS = 2_000;

export type GuardResult = { ok: true } | { ok: false; error: string };

export function guardInfoRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "request must be a JSON object like {\"type\":\"userFees\",\"user\":\"0x…\"}" };
  }
  const type = (body as { type?: unknown }).type;
  if (typeof type !== "string") {
    return { ok: false, error: "request needs a string `type` field" };
  }
  if (!ALLOWED_INFO_TYPES.has(type)) {
    return {
      ok: false,
      error: `type "${type}" is not in the read-only allowlist. Allowed: ${[...ALLOWED_INFO_TYPES].join(", ")}`,
    };
  }
  if (JSON.stringify(body).length > MAX_BODY_CHARS) {
    return { ok: false, error: `request body too large (max ${MAX_BODY_CHARS} chars)` };
  }
  return { ok: true };
}
