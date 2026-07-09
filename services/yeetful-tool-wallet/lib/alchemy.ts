// Alchemy-backed multichain wallet reads. One Data API call prices a wallet's
// whole portfolio across every covered chain (balances + metadata + USD
// prices); per-chain RPC calls cover transfers and transaction receipts.
// Read-only by construction — no keys held, nothing signed, nothing sent.
//
// Requires ALCHEMY_API_KEY (server-side env). Response shapes were probed
// live 2026-07-09; the one quirk: requests say "polygon-mainnet", responses
// say "matic-mainnet" (lib/chains.ts maps both).

import { CHAINS, chainByNet, type WalletChain } from "./chains";

export const MAX_RESPONSE_CHARS = 24_000;

// Injectable seam for tests — production passes nothing (global fetch).
export interface WalletOpts {
  fetchImpl?: typeof fetch;
}

function apiKey(): string {
  const k = process.env.ALCHEMY_API_KEY;
  if (!k) throw new Error("ALCHEMY_API_KEY is not configured on this service.");
  return k;
}

const DATA_BASE = () => process.env.ALCHEMY_DATA_URL ?? "https://api.g.alchemy.com";
const RPC_HOST = (net: string) => process.env.ALCHEMY_RPC_URL_TEMPLATE?.replace("{net}", net) ?? `https://${net}.g.alchemy.com`;

/** Clip an already-shaped payload to the MCP size budget. */
export function clip(data: unknown): unknown {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — narrow with chains/limit/minUsd. \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

export const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);

export function requireAddress(s: string, what = "owner"): `0x${string}` {
  if (!isEvmAddress(s)) {
    throw new Error(
      `A valid \`${what}\` wallet address is required (0x…). For the connected user pass "$USER_ADDRESS"; never guess or reuse an address from conversation.`,
    );
  }
  return s as `0x${string}`;
}

async function postJson(url: string, body: unknown, opts?: WalletOpts, timeoutMs = 15_000): Promise<unknown> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? JSON.stringify((parsed as { error: unknown }).error).slice(0, 300)
        : typeof parsed === "string"
          ? parsed.slice(0, 300)
          : `HTTP ${res.status}`;
    throw new Error(`Alchemy request failed: ${msg}`);
  }
  return parsed;
}

async function rpc(chain: WalletChain, method: string, params: unknown[], opts?: WalletOpts): Promise<unknown> {
  const json = (await postJson(`${RPC_HOST(chain.net)}/v2/${apiKey()}`, { jsonrpc: "2.0", id: 1, method, params }, opts)) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`${chain.label} RPC ${method}: ${json.error.message ?? "unknown error"}`);
  return json.result;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Alchemy returns balances as 0x-hex or decimal strings — both parse via BigInt. */
export function balanceToUnits(raw: string | null | undefined, decimals: number): number {
  if (!raw) return 0;
  try {
    const atoms = BigInt(raw);
    if (atoms === 0n) return 0;
    return Number(atoms) / 10 ** decimals;
  } catch {
    return 0;
  }
}

export function trimAmount(n: number): string {
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const usd = (n: number): number => Math.round(n * 100) / 100;

// ── Portfolio (balances + USD prices, all chains in one call) ────────────────

interface AlchemyToken {
  network?: string;
  tokenAddress?: string | null;
  tokenBalance?: string | null;
  tokenMetadata?: { symbol?: string | null; decimals?: number | null; name?: string | null } | null;
  tokenPrices?: { currency?: string; value?: string }[] | null;
}

export interface Holding {
  symbol: string;
  name: string | null;
  chain: string;
  /** Human units, formatted. */
  balance: string;
  priceUsd: number | null;
  valueUsd: number | null;
  native?: boolean;
  address: string | null;
}

export interface PortfolioView {
  /** The pretty-render contract the Yeetful chat recognizes. */
  kind: "portfolio";
  owner: string;
  totalUsd: number;
  chains: { chain: string; usd: number; holdings: number }[];
  holdings: Holding[];
  hiddenDust: number;
  updatedAt: string;
  summary: string;
}

export async function getPortfolio(
  args: { owner: string; chains: WalletChain[]; minUsd?: number; nativeOnly?: boolean },
  opts?: WalletOpts,
): Promise<PortfolioView> {
  const owner = requireAddress(args.owner);
  const minUsd = args.minUsd ?? 0.01;
  const json = (await postJson(
    `${DATA_BASE()}/data/v1/${apiKey()}/assets/tokens/by-address`,
    {
      addresses: [{ address: owner, networks: args.chains.map((c) => c.net) }],
      withMetadata: true,
      withPrices: true,
      includeNativeTokens: true,
      includeErc20Tokens: !args.nativeOnly,
    },
    opts,
  )) as { data?: { tokens?: AlchemyToken[] } };

  const tokens = Array.isArray(json.data?.tokens) ? json.data.tokens : [];
  const holdings: Holding[] = [];
  let hiddenDust = 0;

  for (const t of tokens) {
    const chain = chainByNet(t.network ?? "");
    if (!chain) continue;
    const isNative = !t.tokenAddress;
    const decimals = typeof t.tokenMetadata?.decimals === "number" ? t.tokenMetadata.decimals : 18;
    const units = balanceToUnits(t.tokenBalance, decimals);
    if (units <= 0) continue;
    const symbol = (isNative ? chain.native : (t.tokenMetadata?.symbol ?? "")).trim();
    if (!symbol) continue;
    const priceStr = (t.tokenPrices ?? []).find((p) => (p.currency ?? "usd").toLowerCase() === "usd")?.value;
    const priceUsd = priceStr != null && Number.isFinite(Number(priceStr)) ? Number(priceStr) : null;
    const valueUsd = priceUsd === null ? null : usd(units * priceUsd);
    // Unpriced or sub-threshold non-native holdings are usually airdrop spam —
    // count them so the answer can say "…and N dust tokens hidden".
    if (!isNative && (valueUsd === null || valueUsd < minUsd)) {
      hiddenDust++;
      continue;
    }
    holdings.push({
      symbol,
      name: t.tokenMetadata?.name ?? null,
      chain: chain.label,
      balance: trimAmount(units),
      priceUsd,
      valueUsd,
      ...(isNative ? { native: true } : {}),
      address: t.tokenAddress ?? null,
    });
  }

  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const totalUsd = usd(holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0));

  const byChain = new Map<string, { usd: number; holdings: number }>();
  for (const h of holdings) {
    const row = byChain.get(h.chain) ?? { usd: 0, holdings: 0 };
    row.usd = usd(row.usd + (h.valueUsd ?? 0));
    row.holdings++;
    byChain.set(h.chain, row);
  }
  const chains = args.chains
    .filter((c) => byChain.has(c.label))
    .map((c) => ({ chain: c.label, ...byChain.get(c.label)! }));

  const top = holdings.slice(0, 3).map((h) => `${h.balance} ${h.symbol} (${h.chain})`).join(", ");
  return {
    kind: "portfolio",
    owner,
    totalUsd,
    chains,
    holdings,
    hiddenDust,
    updatedAt: new Date().toISOString(),
    summary:
      holdings.length === 0
        ? `No holdings ≥ $${minUsd} found for ${owner} on ${args.chains.map((c) => c.label).join(", ")}.`
        : `$${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} across ${chains.length} chain${chains.length === 1 ? "" : "s"} — top: ${top}${hiddenDust ? ` (+${hiddenDust} dust/unpriced hidden)` : ""}. Live on-chain data via Alchemy, fetched just now.`,
  };
}

// ── Recent transfers (per chain, merged newest-first) ───────────────────────

interface AlchemyTransfer {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: number | null;
  asset?: string | null;
  category?: string;
  metadata?: { blockTimestamp?: string };
}

async function transfersFor(chain: WalletChain, address: string, direction: "from" | "to", opts?: WalletOpts): Promise<AlchemyTransfer[]> {
  const params: Record<string, unknown> = {
    category: ["external", "erc20"],
    withMetadata: true,
    excludeZeroValue: true,
    order: "desc",
    maxCount: "0xf",
  };
  if (direction === "from") params.fromAddress = address;
  else params.toAddress = address;
  const result = (await rpc(chain, "alchemy_getAssetTransfers", [params], opts)) as { transfers?: AlchemyTransfer[] } | null;
  return Array.isArray(result?.transfers) ? result.transfers : [];
}

export interface ActivityRow {
  chain: string;
  direction: "in" | "out" | "self";
  asset: string;
  amount: string;
  counterparty: string;
  hash: string;
  timestamp: string | null;
  explorerUrl: string;
  /** Set when the asset symbol used non-ASCII homoglyphs — a scam-token tell. */
  suspicious?: boolean;
}

// Scam airdrops spoof real symbols with unicode homoglyphs ("U឵S឵Dꓚ" for
// USDC — seen live 2026-07-09). Strip them so the chat never renders a
// spoofed symbol as the real thing, and flag the row.
function sanitizeAsset(raw: string): { asset: string; suspicious: boolean } {
  const ascii = raw.replace(/[^\x20-\x7E]/g, "");
  if (ascii === raw) return { asset: raw, suspicious: false };
  return { asset: `${ascii || "???"} (spoofed symbol — likely scam token)`, suspicious: true };
}

const shortAddr = (a: string | null | undefined): string => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? "—"));

/**
 * Most recent sent + received transfers across the requested chains, merged
 * newest-first. Each chain fetches independently — one slow or failed chain
 * never blanks the rest.
 */
export async function getRecentTransactions(
  args: { owner: string; chains: WalletChain[]; limit?: number },
  opts?: WalletOpts,
): Promise<{ kind: "activity"; owner: string; transactions: ActivityRow[]; chainsCovered: string[]; summary: string }> {
  const owner = requireAddress(args.owner);
  const lower = owner.toLowerCase();
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

  const jobs = args.chains.flatMap((c) => [
    transfersFor(c, owner, "from", opts).then((ts) => ts.map((t) => ({ t, c }))).catch(() => []),
    transfersFor(c, owner, "to", opts).then((ts) => ts.map((t) => ({ t, c }))).catch(() => []),
  ]);
  const settled = (await Promise.all(jobs)).flat();

  const byKey = new Map<string, { t: AlchemyTransfer; c: WalletChain }>();
  for (const e of settled) {
    if (!e.t.hash) continue;
    const key = `${e.c.net}:${e.t.hash}`;
    if (!byKey.has(key)) byKey.set(key, e);
  }

  const rows = [...byKey.values()]
    .map(({ t, c }) => {
      const from = (t.from ?? "").toLowerCase();
      const to = (t.to ?? "").toLowerCase();
      const direction: ActivityRow["direction"] = from === lower && to === lower ? "self" : from === lower ? "out" : "in";
      const { asset, suspicious } = sanitizeAsset((t.asset || c.native).trim());
      return {
        chain: c.label,
        direction,
        asset,
        amount: typeof t.value === "number" && Number.isFinite(t.value) ? trimAmount(t.value) : "",
        counterparty: shortAddr(direction === "out" ? t.to : t.from),
        hash: t.hash as string,
        timestamp: t.metadata?.blockTimestamp ?? null,
        explorerUrl: c.explorerTx + t.hash,
        ...(suspicious ? { suspicious: true } : {}),
      };
    })
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
    .slice(0, limit);

  return {
    kind: "activity",
    owner,
    transactions: rows,
    chainsCovered: args.chains.map((c) => c.label),
    summary: rows.length
      ? `${rows.length} recent transfer${rows.length === 1 ? "" : "s"} for ${shortAddr(owner)} across ${args.chains.map((c) => c.label).join(", ")} (newest first, live via Alchemy).`
      : `No recent external/ERC-20 transfers found for ${shortAddr(owner)} on ${args.chains.map((c) => c.label).join(", ")}.`,
  };
}

// ── One token balance (the precise post-transaction check) ──────────────────

export async function getTokenBalance(
  args: { owner: string; chain: WalletChain; token: string },
  opts?: WalletOpts,
): Promise<Record<string, unknown>> {
  const owner = requireAddress(args.owner);
  const wantNative = args.token.trim().toLowerCase() === "native" || args.token.trim().toUpperCase() === args.chain.native;

  if (wantNative) {
    const hex = (await rpc(args.chain, "eth_getBalance", [owner, "latest"], opts)) as string;
    const units = balanceToUnits(hex, 18);
    return {
      owner,
      chain: args.chain.label,
      token: args.chain.native,
      native: true,
      balance: trimAmount(units),
      note: `Live ${args.chain.label} balance, fetched just now.`,
    };
  }

  if (!isEvmAddress(args.token)) {
    throw new Error(
      `Pass the token's 0x contract address on ${args.chain.label}, or "native" for ${args.chain.native}. (Symbols are ambiguous across chains — \`portfolio\` resolves everything a wallet holds without needing addresses.)`,
    );
  }
  const result = (await rpc(args.chain, "alchemy_getTokenBalances", [owner, [args.token]], opts)) as {
    tokenBalances?: { contractAddress?: string; tokenBalance?: string | null }[];
  };
  const raw = result?.tokenBalances?.[0]?.tokenBalance ?? "0x0";
  const meta = (await rpc(args.chain, "alchemy_getTokenMetadata", [args.token], opts)) as {
    symbol?: string | null;
    decimals?: number | null;
    name?: string | null;
  } | null;
  const decimals = typeof meta?.decimals === "number" ? meta.decimals : 18;
  const units = balanceToUnits(raw, decimals);
  return {
    owner,
    chain: args.chain.label,
    token: meta?.symbol ?? args.token,
    name: meta?.name ?? null,
    address: args.token,
    balance: trimAmount(units),
    decimals,
    note: `Live ${args.chain.label} balance, fetched just now.`,
  };
}

// ── Transaction status (did it confirm?) ─────────────────────────────────────

export async function getTransactionStatus(
  args: { chain: WalletChain; hash: string },
  opts?: WalletOpts,
): Promise<Record<string, unknown>> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(args.hash.trim())) {
    throw new Error("Pass a 0x…64-hex transaction hash.");
  }
  const hash = args.hash.trim();
  const [receipt, blockHex] = await Promise.all([
    rpc(args.chain, "eth_getTransactionReceipt", [hash], opts) as Promise<{
      status?: string;
      blockNumber?: string;
      from?: string;
      to?: string;
      gasUsed?: string;
      logs?: unknown[];
    } | null>,
    rpc(args.chain, "eth_blockNumber", [], opts) as Promise<string>,
  ]);

  if (!receipt) {
    return {
      chain: args.chain.label,
      hash,
      status: "PENDING_OR_UNKNOWN",
      explanation: `No receipt on ${args.chain.label} yet — the transaction is still pending, was dropped, or the hash belongs to a different chain. Check the explorer link or retry in a few seconds.`,
      explorerUrl: args.chain.explorerTx + hash,
    };
  }
  const ok = receipt.status === "0x1";
  const confirmations = receipt.blockNumber ? Math.max(0, Number(BigInt(blockHex) - BigInt(receipt.blockNumber)) + 1) : 0;
  return {
    chain: args.chain.label,
    hash,
    status: ok ? "CONFIRMED" : "REVERTED",
    explanation: ok
      ? `Confirmed on ${args.chain.label} with ${confirmations} confirmation${confirmations === 1 ? "" : "s"}. Balances reflect it — re-read them with \`portfolio\` or \`token_balance\` to show the fresh numbers.`
      : `The transaction REVERTED on ${args.chain.label} — no state changed and no funds moved (gas was still spent).`,
    confirmations,
    from: receipt.from ?? null,
    to: receipt.to ?? null,
    logCount: Array.isArray(receipt.logs) ? receipt.logs.length : null,
    explorerUrl: args.chain.explorerTx + hash,
  };
}

export const COVERED = CHAINS;
