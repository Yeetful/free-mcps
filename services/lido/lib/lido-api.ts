// Lido's public HTTP APIs (no auth, no key) — three small surfaces:
//   • eth-api.lido.fi        — protocol APR (7-day SMA + latest)
//   • reward-history-backend — per-address reward events + totals (the same
//                              backend stake.lido.fi's Reward History tab uses)
//   • wq-api.lido.fi         — withdrawal-queue wait-time estimates
// Response shapes below are the LIVE probed truth (validated 2026-07-13),
// pinned by fixtures in tests/.

const APR_API = () => process.env.LIDO_ETH_API_URL ?? "https://eth-api.lido.fi";
const REWARD_API = () => process.env.LIDO_REWARD_API_URL ?? "https://reward-history-backend.lido.fi";
const WQ_API = () => process.env.LIDO_WQ_API_URL ?? "https://wq-api.lido.fi";

// Cap payloads returned through MCP so a huge response can't blow up the
// agent's context. Clipping happens at the TOOL layer, after shaping.
const MAX_RESPONSE_CHARS = 24_000;

// Injectable seam for tests — production passes nothing (global fetch).
export interface LidoOpts {
  fetchImpl?: typeof fetch;
}

export interface LidoResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Clip an already-shaped payload to the MCP size budget. */
export function clip(data: unknown): unknown {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data);
  if (serialized.length <= MAX_RESPONSE_CHARS) return data;
  return {
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — ask for fewer items (a smaller limit or a narrower window). \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

export const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);

async function getJson(url: string, opts?: LidoOpts): Promise<LidoResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (e) {
    return { ok: false, status: 502, data: `Lido API unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

// ── APR ──────────────────────────────────────────────────────────────────────

export interface AprInfo {
  smaAprPct: number | null; // 7-day simple moving average, percent
  latestAprPct: number | null; // most recent daily rebase, percent
  asOf: string | null; // ISO time of the latest datapoint
}

/** Protocol staking APR — 7-day SMA + the latest daily value. */
export async function fetchApr(opts?: LidoOpts): Promise<LidoResult> {
  const r = await getJson(`${APR_API()}/v1/protocol/steth/apr/sma`, opts);
  if (!r.ok) return r;
  const d = r.data as { data?: { smaApr?: number; aprs?: { timeUnix?: number; apr?: number }[] } };
  const aprs = d?.data?.aprs ?? [];
  const last = aprs[aprs.length - 1];
  const info: AprInfo = {
    smaAprPct: d?.data?.smaApr ?? null,
    latestAprPct: last?.apr ?? null,
    asOf: last?.timeUnix ? new Date(last.timeUnix * 1000).toISOString() : null,
  };
  return { ok: true, status: 200, data: info };
}

// ── Reward history (earnings) ────────────────────────────────────────────────

interface RewardEventRaw {
  type?: string;
  rewards?: string; // stETH wei
  change?: string;
  balance?: string; // stETH wei after the event
  apr?: string;
  blockTime?: string;
  currencyChange?: string;
}

export interface RewardHistory {
  totalRewardsStEth: string; // decimal stETH
  totalRewardsUsd: number | null;
  averageAprPct: number | null;
  stEthUsdPrice: number | null;
  totalEvents: number;
  events: {
    type: string;
    date: string;
    rewardStEth: string;
    balanceStEth: string;
    aprPct: number | null;
  }[];
}

const weiToEth = (wei: string | undefined): string => {
  if (!wei || !/^-?\d+$/.test(wei)) return "0";
  const neg = wei.startsWith("-");
  const digits = (neg ? wei.slice(1) : wei).padStart(19, "0");
  const whole = digits.slice(0, -18).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-18).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};

/**
 * Per-address staking earnings from Lido's reward-history backend: daily
 * rebase reward events + lifetime totals. `onlyRewards` drops transfers so
 * the events read as pure earnings; currency=usd prices each event.
 */
export async function fetchRewards(
  args: { address: string; limit?: number; onlyRewards?: boolean },
  opts?: LidoOpts,
): Promise<LidoResult> {
  const limit = Math.min(Math.max(args.limit ?? 14, 1), 60);
  const qs = new URLSearchParams({
    address: args.address,
    currency: "usd",
    onlyRewards: String(args.onlyRewards ?? true),
    archiveRate: "true",
    sort: "desc",
    skip: "0",
    limit: String(limit),
  });
  const r = await getJson(`${REWARD_API()}/?${qs}`, opts);
  if (!r.ok) {
    // The backend refuses addresses with >6000 stETH transfers (422) with a
    // legible message — surface it as text, not a JSON blob.
    const msg = (r.data as { message?: string })?.message;
    return msg
      ? { ok: false, status: r.status, data: `Lido reward-history API: ${msg} (\`position\` still shows the CURRENT staked value.)` }
      : r;
  }
  const d = r.data as {
    events?: RewardEventRaw[];
    totals?: { ethRewards?: string; currencyRewards?: string };
    averageApr?: string;
    stETHCurrencyPrice?: { usd?: number };
    totalItems?: number;
  };
  const events = (d?.events ?? []).map((e) => ({
    type: e.type ?? "event",
    date: e.blockTime ? new Date(Number(e.blockTime) * 1000).toISOString().slice(0, 10) : "?",
    rewardStEth: weiToEth(e.rewards ?? e.change),
    balanceStEth: weiToEth(e.balance),
    aprPct: e.apr ? Number(Number(e.apr).toFixed(3)) : null,
  }));
  const usdPrice = d?.stETHCurrencyPrice?.usd ?? null;
  const totalStEth = weiToEth(d?.totals?.ethRewards);
  const shaped: RewardHistory = {
    totalRewardsStEth: totalStEth,
    totalRewardsUsd:
      d?.totals?.currencyRewards != null
        ? Number(Number(d.totals.currencyRewards).toFixed(2))
        : usdPrice != null
          ? Number((Number(totalStEth) * usdPrice).toFixed(2))
          : null,
    averageAprPct: d?.averageApr ? Number(Number(d.averageApr).toFixed(3)) : null,
    stEthUsdPrice: usdPrice,
    totalEvents: d?.totalItems ?? events.length,
    events,
  };
  return { ok: true, status: 200, data: shaped };
}

/** Just the stETH/USD price (rides the reward-history response). Fail-soft. */
export async function fetchStEthUsd(opts?: LidoOpts): Promise<number | null> {
  // Any valid address works — price metadata is global. NOT the zero/0x11…
  // vanity addresses (they carry thousands of dust transfers and the backend
  // 422s past 6000); a random constant with no history keeps it tiny forever.
  const r = await fetchRewards({ address: "0x9C1e4691dc4B0Cae7A9A88f75Fb2AefD7A9b1E4c", limit: 1 }, opts);
  if (!r.ok) return null;
  return (r.data as RewardHistory).stEthUsdPrice;
}

// ── Withdrawal-queue wait estimate ───────────────────────────────────────────

/** Estimated finalization wait for a NEW withdrawal request of `amount` stETH. */
export async function fetchQueueWait(amountStEth: string, opts?: LidoOpts): Promise<LidoResult> {
  const r = await getJson(`${WQ_API()}/v2/request-time/calculate?amount=${encodeURIComponent(amountStEth)}`, opts);
  if (!r.ok) return r;
  const d = r.data as { requestInfo?: { finalizationIn?: number; finalizationAt?: string; type?: string } };
  const ms = d?.requestInfo?.finalizationIn ?? null;
  return {
    ok: true,
    status: 200,
    data: {
      estimatedWaitHours: ms != null ? Number((ms / 3_600_000).toFixed(1)) : null,
      estimatedFinalizationAt: d?.requestInfo?.finalizationAt ?? null,
      drivenBy: d?.requestInfo?.type ?? null,
    },
  };
}
