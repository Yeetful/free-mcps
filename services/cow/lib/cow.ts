// CoW Protocol order-book API client. api.cow.fi is free and public — no API
// key. One deployment per chain at https://api.cow.fi/{network}/api/v1; the
// settlement + vault-relayer contracts are the SAME addresses on every chain.
//
// Facts below were verified against the live API 2026-07-06 (version
// v2.368.3): supported networks probed one by one (optimism/lens 404),
// solver_competition lives on /api/v2 (the v1 path is 404), /auction is 403
// at the edge (nginx) and deliberately not exposed here.

const API_URL = () => process.env.COW_API_URL ?? "https://api.cow.fi";

// Cap payloads returned through MCP so a huge response can't blow up the
// agent's context. Clipping happens at the TOOL layer (after shaping).
const MAX_RESPONSE_CHARS = 24_000;

/** Clip an already-shaped payload to the MCP size budget. */
export function clip(data: unknown): unknown {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — narrow your filters (fewer chains, lower limit). \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

// ── Chains ───────────────────────────────────────────────────────────────────

/** Settlement contract — same address on every supported chain (verified in
 *  the bundled docs corpus: reference/core/signing_schemes). */
export const SETTLEMENT_CONTRACT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;
/** GPv2VaultRelayer — the spender the sell token must be approved to. */
export const VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;

export interface ChainInfo {
  /** Friendly name (the `chain` enum value). */
  name: string;
  /** The api.cow.fi network path segment. */
  network: string;
  chainId: number;
  native: string;
  /** explorer.cow.fi path prefix ("" for mainnet). */
  explorerPrefix: string;
}

export const CHAINS: Record<string, ChainInfo> = {
  mainnet: { name: "mainnet", network: "mainnet", chainId: 1, native: "ETH", explorerPrefix: "" },
  gnosis: { name: "gnosis", network: "xdai", chainId: 100, native: "xDAI", explorerPrefix: "gc" },
  arbitrum: { name: "arbitrum", network: "arbitrum_one", chainId: 42161, native: "ETH", explorerPrefix: "arb1" },
  base: { name: "base", network: "base", chainId: 8453, native: "ETH", explorerPrefix: "base" },
  avalanche: { name: "avalanche", network: "avalanche", chainId: 43114, native: "AVAX", explorerPrefix: "avax" },
  polygon: { name: "polygon", network: "polygon", chainId: 137, native: "POL", explorerPrefix: "pol" },
  bnb: { name: "bnb", network: "bnb", chainId: 56, native: "BNB", explorerPrefix: "bnb" },
  sepolia: { name: "sepolia", network: "sepolia", chainId: 11155111, native: "ETH", explorerPrefix: "sepolia" },
};

export const CHAIN_NAMES = Object.keys(CHAINS) as [string, ...string[]];

// Friendly aliases → canonical chain name.
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "mainnet", eth: "mainnet", "1": "mainnet",
  xdai: "gnosis", gnosischain: "gnosis", "100": "gnosis",
  arbitrum_one: "arbitrum", arb: "arbitrum", "42161": "arbitrum",
  "8453": "base",
  avax: "avalanche", "43114": "avalanche",
  matic: "polygon", "137": "polygon",
  bsc: "bnb", binance: "bnb", "56": "bnb",
  "11155111": "sepolia",
};

/** Resolve a friendly chain name/alias/id to ChainInfo, or null. */
export function resolveChain(chain?: string): ChainInfo | null {
  const key = (chain ?? "mainnet").trim().toLowerCase();
  return CHAINS[key] ?? CHAINS[CHAIN_ALIASES[key] ?? ""] ?? null;
}

export function explorerOrderUrl(chain: ChainInfo, uid: string): string {
  const prefix = chain.explorerPrefix ? `/${chain.explorerPrefix}` : "";
  return `https://explorer.cow.fi${prefix}/orders/${uid}`;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// Injectable seam for tests — production passes nothing (global fetch).
export interface CowOpts {
  fetchImpl?: typeof fetch;
}

export interface CowResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function request(
  chain: ChainInfo,
  method: "GET" | "POST",
  versionedPath: string, // "/v1/quote", "/v2/solver_competition/latest"
  body?: unknown,
  opts?: CowOpts,
): Promise<CowResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`${API_URL()}/${chain.network}/api${versionedPath}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

/** GET a v1/v2 order-book path (path INCLUDES the version, e.g. "/v1/version"). */
export const apiGet = (chain: ChainInfo, versionedPath: string, opts?: CowOpts) =>
  request(chain, "GET", versionedPath, undefined, opts);

/** POST to a v1 order-book path. */
export const apiPost = (chain: ChainInfo, versionedPath: string, body: unknown, opts?: CowOpts) =>
  request(chain, "POST", versionedPath, body, opts);

/** DELETE with a signed OrderCancellations body. */
export async function apiDelete(
  chain: ChainInfo,
  versionedPath: string,
  body: unknown,
  opts?: CowOpts,
): Promise<CowResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`${API_URL()}/${chain.network}/api${versionedPath}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

// ── Quote (verified against the live API 2026-07-06) ───────────────────────

export interface QuoteRequest {
  sellToken: string;
  buyToken: string;
  from: string;
  receiver?: string;
  kind: "sell" | "buy";
  sellAmountBeforeFee?: string;
  buyAmountAfterFee?: string;
  validFor?: number;
  appData?: string;
  partiallyFillable?: boolean;
}

export interface QuoteSide {
  sellToken: string;
  buyToken: string;
  receiver: string | null;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string;
  appDataHash?: string;
  feeAmount: string;
  kind: "sell" | "buy";
  partiallyFillable: boolean;
  sellTokenBalance: string;
  buyTokenBalance: string;
  signingScheme: string;
}

export interface QuoteResponse {
  quote: QuoteSide;
  from: string;
  expiration: string;
  id: number | null;
  verified: boolean;
}

export const postQuote = (chain: ChainInfo, req: QuoteRequest, opts?: CowOpts) =>
  apiPost(chain, "/v1/quote", req, opts);

export const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);
export const isOrderUid = (s: string): boolean => /^0x[a-fA-F0-9]{112}$/.test(s);
