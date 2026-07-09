// AaveKit GraphQL client — the OFFICIAL Aave v4 API (api.v4.aave.com/graphql,
// no auth, no key). It serves both halves of this MCP: read queries (markets,
// reserves, positions, balances, activity) and transaction-PREPARATION
// queries that return unsigned calldata. The API never signs and never
// submits — and neither does this service.
//
// Every query below was validated against the live API on 2026-07-09
// (introspection is disabled upstream; the docs' GraphQL tabs drift from the
// live schema — e.g. UserSupplyItem's real fields are balance/principal/
// withdrawable/interest, not the documented amount/earned — so the shapes
// here are the probed truth, pinned by fixtures in tests/).

const API_URL = () => process.env.AAVE_API_URL ?? "https://api.v4.aave.com/graphql";

// Cap payloads returned through MCP so a huge response can't blow up the
// agent's context. Clipping happens at the TOOL layer, after shaping.
const MAX_RESPONSE_CHARS = 24_000;

// Injectable seam for tests — production passes nothing (global fetch).
export interface AaveOpts {
  fetchImpl?: typeof fetch;
}

export interface AaveResult {
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
    note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — narrow your filters (a specific spoke, fewer items, a shorter window). \`preview\` is a raw (clipped) JSON string.`,
    preview: serialized.slice(0, MAX_RESPONSE_CHARS),
  };
}

export const isEvmAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s);

/** POST one GraphQL operation. GraphQL-level errors surface as ok:false. */
export async function gqlRequest(
  query: string,
  variables: Record<string, unknown>,
  opts?: AaveOpts,
): Promise<AaveResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(API_URL(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) return { ok: false, status: res.status, data: parsed };

  const body = parsed as { data?: unknown; errors?: { message?: string }[] };
  if (body?.errors?.length) {
    return {
      ok: false,
      status: 400,
      data: body.errors.map((e) => e.message ?? "unknown GraphQL error").join("; "),
    };
  }
  return { ok: true, status: res.status, data: body?.data ?? null };
}

// ── Value helpers ────────────────────────────────────────────────────────────
// AaveKit scalars: DecimalNumber {value:"1.23"}, PercentNumber {value:"0.045"
// fraction, normalized:"4.5" percent}, ExchangeAmount {value:"12.3456",
// symbol:"$"}. Shape everything to plain strings/numbers the planner can read.

interface PercentLike {
  value?: string | null;
  normalized?: string | null;
}
interface AmountLike {
  value?: string | null;
  symbol?: string | null;
}

/** PercentNumber → percent as a number (4.52 for 4.52% APY), or null. */
export function pct(p: PercentLike | null | undefined): number | null {
  const raw = p?.normalized ?? (p?.value != null ? String(Number(p.value) * 100) : null);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

/** ExchangeAmount → "$12.34"-style display string, or null. */
export function fiat(a: AmountLike | null | undefined): string | null {
  if (a?.value == null) return null;
  const n = Number(a.value);
  if (!Number.isFinite(n)) return a.value;
  return `${a.symbol ?? "$"}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const val = (d: { value?: string | null } | null | undefined): string | null => d?.value ?? null;

// ── Raw API shapes (only the slices we select) ───────────────────────────────

interface GqlToken {
  address?: string;
  info?: { name?: string; symbol?: string; decimals?: number };
}
interface GqlErc20Amount {
  amount?: { value?: string };
  exchange?: { value?: string; symbol?: string };
  token?: GqlToken;
}

// ── Read queries (validated live 2026-07-09) ────────────────────────────────

const HUBS_QUERY = `query($request: HubsRequest!) {
  hubs(request: $request) {
    address name
    chain { chainId name }
    summary {
      totalSupplied { current { value symbol } }
      totalBorrowed { current { value symbol } }
      utilizationRate { value normalized }
    }
  }
}`;

const SPOKES_QUERY = `query($request: SpokesRequest!) {
  spokes(request: $request) {
    id name address
    chain { chainId name }
    summary {
      totalSupplied { value symbol }
      totalBorrowed { value symbol }
      uniqueAssets
    }
    connectedHubs { hub { name address } }
  }
}`;

const RESERVES_QUERY = `query($request: ReservesRequest!) {
  reserves(request: $request) {
    id onChainId
    canBorrow canSupply canUseAsCollateral
    status { active frozen paused }
    settings {
      collateralFactor { value normalized }
      borrowCap { amount { value } }
      supplyCap { amount { value } }
    }
    summary {
      supplied { amount { value } exchange { value symbol } }
      borrowed { amount { value } exchange { value symbol } }
      supplyApy { value normalized }
      borrowApy { value normalized }
    }
    spoke { name address chain { chainId } }
    asset { underlying { address info { name symbol decimals } } }
  }
}`;

const USER_POSITIONS_QUERY = `query($request: UserPositionsRequest!) {
  userPositions(request: $request) {
    user createdAt
    spoke { name address chain { chainId } }
    totalSupplied { current { value symbol } }
    totalCollateral { current { value symbol } }
    totalDebt { current { value symbol } }
    netBalance { current { value symbol } }
    netApy { value normalized }
    netAccruedInterest { value symbol }
    healthFactor { current }
    maxBorrowingPower { value symbol }
    remainingBorrowingPower { value symbol }
  }
}`;

const USER_SUPPLIES_QUERY = `query($request: UserSuppliesRequest!) {
  userSupplies(request: $request) {
    isCollateral
    balance {
      amount { value }
      exchange { value symbol }
      token { address info { name symbol decimals } }
    }
    principal { amount { value } }
    withdrawable { amount { value } }
    interest { amount { value } exchange { value symbol } }
    reserve { spoke { name address } summary { supplyApy { value normalized } } }
  }
}`;

const USER_BORROWS_QUERY = `query($request: UserBorrowsRequest!) {
  userBorrows(request: $request) {
    debt {
      amount { value }
      exchange { value symbol }
      token { address info { name symbol decimals } }
    }
    principal { amount { value } }
    interest { amount { value } exchange { value symbol } }
    reserve { spoke { name address } summary { borrowApy { value normalized } } }
  }
}`;

const USER_BALANCES_QUERY = `query($request: UserBalancesRequest!) {
  userBalances(request: $request) {
    info { name symbol decimals }
    totalAmount { value }
    exchange { value symbol }
    balances {
      __typename
      ... on Erc20Amount { token { address } }
    }
    highestSupplyApy: supplyApy(metric: HIGHEST) { value normalized }
  }
}`;

const ACTIVITIES_QUERY = `query($request: ActivitiesRequest!) {
  activities(request: $request) {
    items {
      __typename
      ... on SupplyActivity   { timestamp txHash spoke { name } supplied  { amount { value } token { info { symbol } } } }
      ... on BorrowActivity   { timestamp txHash spoke { name } borrowed  { amount { value } token { info { symbol } } } }
      ... on RepayActivity    { timestamp txHash spoke { name } repaid    { amount { value } token { info { symbol } } } }
      ... on WithdrawActivity { timestamp txHash spoke { name } withdrawn { amount { value } token { info { symbol } } } }
    }
    pageInfo { next }
  }
}`;

// The AaveKit deployment is Ethereum-only today; the chainId arg exists so
// new chains are a parameter, not a code change.
export const DEFAULT_CHAIN_ID = 1;

const spokeRef = (address: string, chainId: number) => ({ spoke: { address, chainId } });

const shapeToken = (t: GqlToken | null | undefined) => ({
  symbol: t?.info?.symbol ?? null,
  name: t?.info?.name ?? null,
  address: t?.address ?? null,
  decimals: t?.info?.decimals ?? null,
});

// ── Typed query wrappers (the curated tool surface) ─────────────────────────

export const queries = {
  /** Hubs + spokes in one view — "what markets does Aave v4 have?" */
  markets: async (args: { chainId?: number }, opts?: AaveOpts): Promise<AaveResult> => {
    const chainIds = [args.chainId ?? DEFAULT_CHAIN_ID];
    const [hubs, spokes] = await Promise.all([
      gqlRequest(HUBS_QUERY, { request: { query: { chainIds } } }, opts),
      gqlRequest(SPOKES_QUERY, { request: { query: { chainIds } } }, opts),
    ]);
    if (!hubs.ok) return hubs;
    if (!spokes.ok) return spokes;
    const hubList = ((hubs.data as { hubs?: Record<string, any>[] })?.hubs ?? []).map((h) => ({
      name: h.name,
      address: h.address,
      chain: h.chain?.name ?? null,
      chainId: h.chain?.chainId ?? null,
      totalSuppliedUsd: fiat(h.summary?.totalSupplied?.current),
      totalBorrowedUsd: fiat(h.summary?.totalBorrowed?.current),
      utilizationPct: pct(h.summary?.utilizationRate),
    }));
    const spokeList = ((spokes.data as { spokes?: Record<string, any>[] })?.spokes ?? []).map((s) => ({
      name: s.name,
      address: s.address,
      chainId: s.chain?.chainId ?? null,
      totalSuppliedUsd: fiat(s.summary?.totalSupplied),
      totalBorrowedUsd: fiat(s.summary?.totalBorrowed),
      assets: s.summary?.uniqueAssets ?? null,
      hubs: (s.connectedHubs ?? []).map((c: { hub?: { name?: string } }) => c.hub?.name).filter(Boolean),
    }));
    return {
      ok: true,
      status: 200,
      data: {
        architecture:
          "Aave v4 is hub-and-spoke: hubs pool liquidity, spokes are the markets users supply/borrow on. Pass a spoke address to `reserves` to list its pools.",
        hubs: hubList,
        spokes: spokeList,
      },
    };
  },

  /** Reserve (pool) list with live APYs — "where can I earn on USDC?" */
  reserves: async (
    args: { spokeAddress?: string; chainId?: number; symbols?: string[]; first?: number },
    opts?: AaveOpts,
  ): Promise<AaveResult> => {
    const chainId = args.chainId ?? DEFAULT_CHAIN_ID;
    const query = args.spokeAddress ? spokeRef(args.spokeAddress, chainId) : { chainIds: [chainId] };
    const r = await gqlRequest(RESERVES_QUERY, { request: { query } }, opts);
    if (!r.ok) return r;
    const wanted = args.symbols?.map((s) => s.toUpperCase());
    let reserves = ((r.data as { reserves?: Record<string, any>[] })?.reserves ?? [])
      .map((res) => ({
        reserveId: res.id,
        spoke: res.spoke?.name ?? null,
        spokeAddress: res.spoke?.address ?? null,
        asset: shapeToken(res.asset?.underlying),
        canSupply: res.canSupply ?? null,
        canBorrow: res.canBorrow ?? null,
        canUseAsCollateral: res.canUseAsCollateral ?? null,
        active: res.status?.active === true && res.status?.frozen !== true && res.status?.paused !== true,
        collateralFactorPct: pct(res.settings?.collateralFactor),
        supplyCap: val(res.settings?.supplyCap?.amount),
        borrowCap: val(res.settings?.borrowCap?.amount),
        supplied: val(res.summary?.supplied?.amount),
        suppliedUsd: fiat(res.summary?.supplied?.exchange),
        borrowed: val(res.summary?.borrowed?.amount),
        borrowedUsd: fiat(res.summary?.borrowed?.exchange),
        supplyApyPct: pct(res.summary?.supplyApy),
        borrowApyPct: pct(res.summary?.borrowApy),
        _usd: Number(res.summary?.supplied?.exchange?.value ?? 0),
      }))
      .filter((res) => !wanted || (res.asset.symbol && wanted.includes(res.asset.symbol.toUpperCase())));
    reserves.sort((a, b) => b._usd - a._usd);
    const total = reserves.length;
    const first = Math.min(args.first ?? 30, 100);
    reserves = reserves.slice(0, first);
    return {
      ok: true,
      status: 200,
      data: {
        count: total,
        ...(total > first ? { note: `Showing top ${first} of ${total} by supplied USD — filter by spokeAddress/symbols or raise first.` } : {}),
        reserves: reserves.map(({ _usd, ...rest }) => rest),
      },
    };
  },

  /**
   * Full account view for an address: per-spoke positions (health factor,
   * net APY, borrowing power) + every supply (with earned interest) + every
   * borrow (with accrued debt). This is the "$USER_ADDRESS portfolio" tool.
   */
  portfolio: async (args: { user: string; chainId?: number }, opts?: AaveOpts): Promise<AaveResult> => {
    const chainIds = [args.chainId ?? DEFAULT_CHAIN_ID];
    const userChains = { userChains: { user: args.user, chainIds } };
    const [positions, supplies, borrows] = await Promise.all([
      gqlRequest(USER_POSITIONS_QUERY, { request: { user: args.user, filter: { chainIds } } }, opts),
      gqlRequest(USER_SUPPLIES_QUERY, { request: { query: userChains, orderBy: { amount: "DESC" } } }, opts),
      gqlRequest(USER_BORROWS_QUERY, { request: { query: userChains, orderBy: { amount: "DESC" } } }, opts),
    ]);
    if (!positions.ok) return positions;

    const posList = ((positions.data as { userPositions?: Record<string, any>[] })?.userPositions ?? []).map((p) => ({
      spoke: p.spoke?.name ?? null,
      spokeAddress: p.spoke?.address ?? null,
      chainId: p.spoke?.chain?.chainId ?? null,
      since: p.createdAt ?? null,
      totalSuppliedUsd: fiat(p.totalSupplied?.current),
      totalCollateralUsd: fiat(p.totalCollateral?.current),
      totalDebtUsd: fiat(p.totalDebt?.current),
      netBalanceUsd: fiat(p.netBalance?.current),
      netApyPct: pct(p.netApy),
      netAccruedInterestUsd: fiat(p.netAccruedInterest),
      healthFactor: p.healthFactor?.current ?? null,
      maxBorrowingPowerUsd: fiat(p.maxBorrowingPower),
      remainingBorrowingPowerUsd: fiat(p.remainingBorrowingPower),
    }));

    const supplyList = supplies.ok
      ? ((supplies.data as { userSupplies?: Record<string, any>[] })?.userSupplies ?? []).map((s) => {
          const b = s.balance as GqlErc20Amount | undefined;
          return {
            spoke: s.reserve?.spoke?.name ?? null,
            spokeAddress: s.reserve?.spoke?.address ?? null,
            token: shapeToken(b?.token),
            balance: val(b?.amount),
            balanceUsd: fiat(b?.exchange),
            principal: val(s.principal?.amount),
            withdrawable: val(s.withdrawable?.amount),
            earnedInterest: val(s.interest?.amount),
            earnedInterestUsd: fiat(s.interest?.exchange),
            isCollateral: s.isCollateral ?? null,
            supplyApyPct: pct(s.reserve?.summary?.supplyApy),
          };
        })
      : [];

    const borrowList = borrows.ok
      ? ((borrows.data as { userBorrows?: Record<string, any>[] })?.userBorrows ?? []).map((b) => {
          const d = b.debt as GqlErc20Amount | undefined;
          return {
            spoke: b.reserve?.spoke?.name ?? null,
            spokeAddress: b.reserve?.spoke?.address ?? null,
            token: shapeToken(d?.token),
            debt: val(d?.amount),
            debtUsd: fiat(d?.exchange),
            principal: val(b.principal?.amount),
            accruedInterest: val(b.interest?.amount),
            accruedInterestUsd: fiat(b.interest?.exchange),
            borrowApyPct: pct(b.reserve?.summary?.borrowApy),
          };
        })
      : [];

    return {
      ok: true,
      status: 200,
      data: {
        user: args.user,
        ...(posList.length === 0
          ? { note: "No Aave v4 positions for this address. `balances` shows what they could supply; `reserves` lists the pools." }
          : {}),
        positions: posList,
        supplies: supplyList,
        borrows: borrowList,
      },
    };
  },

  /** Wallet balances of Aave-listed tokens + best supply APY for each. */
  balances: async (args: { user: string; chainId?: number }, opts?: AaveOpts): Promise<AaveResult> => {
    const chainIds = [args.chainId ?? DEFAULT_CHAIN_ID];
    const r = await gqlRequest(
      USER_BALANCES_QUERY,
      { request: { user: args.user, filter: { chains: { chainIds } } } },
      opts,
    );
    if (!r.ok) return r;
    const balances = ((r.data as { userBalances?: Record<string, any>[] })?.userBalances ?? [])
      .map((b) => ({
        symbol: b.info?.symbol ?? null,
        name: b.info?.name ?? null,
        decimals: b.info?.decimals ?? null,
        native: (b.balances ?? []).some((x: { __typename?: string }) => x.__typename === "NativeAmount"),
        address: (b.balances ?? []).find((x: { token?: { address?: string } }) => x.token?.address)?.token?.address ?? null,
        amount: val(b.totalAmount),
        usd: fiat(b.exchange),
        bestSupplyApyPct: pct(b.highestSupplyApy),
        _usd: Number(b.exchange?.value ?? 0),
      }))
      .filter((b) => Number(b.amount ?? 0) > 0)
      .sort((a, b) => b._usd - a._usd)
      .map(({ _usd, ...rest }) => rest);
    return {
      ok: true,
      status: 200,
      data: {
        user: args.user,
        note: "Tokens this wallet holds that Aave v4 lists, with the best available supply APY — what could be put to work. Use build_supply to prepare the deposit.",
        balances,
      },
    };
  },

  /** Recent supply/borrow/repay/withdraw history for an address. */
  activities: async (
    args: { user: string; chainId?: number; cursor?: string },
    opts?: AaveOpts,
  ): Promise<AaveResult> => {
    const chainIds = [args.chainId ?? DEFAULT_CHAIN_ID];
    const request: Record<string, unknown> = {
      query: { chainIds },
      user: args.user,
      types: ["SUPPLY", "BORROW", "REPAY", "WITHDRAW"],
    };
    if (args.cursor) request.cursor = args.cursor;
    const r = await gqlRequest(ACTIVITIES_QUERY, { request }, opts);
    if (!r.ok) return r;
    const data = (r.data as { activities?: { items?: Record<string, any>[]; pageInfo?: { next?: string | null } } })
      ?.activities;
    const items = (data?.items ?? []).map((a) => {
      const leg = a.supplied ?? a.borrowed ?? a.repaid ?? a.withdrawn;
      return {
        type: String(a.__typename ?? "").replace(/Activity$/, "").toUpperCase(),
        timestamp: a.timestamp ?? null,
        spoke: a.spoke?.name ?? null,
        amount: val(leg?.amount),
        symbol: leg?.token?.info?.symbol ?? null,
        txHash: a.txHash ?? null,
      };
    });
    return {
      ok: true,
      status: 200,
      data: { user: args.user, activities: items, nextCursor: data?.pageInfo?.next ?? null },
    };
  },
};
