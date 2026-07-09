// Construction-only transaction building via the AaveKit API's transaction-
// PREPARATION queries. The API returns unsigned {to,data,value,chainId}
// calldata (validated server-side against the sender's REAL balances,
// allowances, and health factor); this module reshapes each ExecutionPlan
// into ordered `send_transaction` steps for Yeetful's transaction layer —
// the same {action:'send_transaction', tx:{…}} contract the uniswap sibling
// uses, so the chat renders approve→act chains as sign buttons. Nothing here
// (or upstream) ever signs or submits.
//
// Input-shape quirks are the LIVE schema, not the docs (validated 2026-07-09):
// supply/borrow take {erc20:{value}}, withdraw takes FLAT {erc20:{exact|max}},
// repay nests {erc20:{value:{exact|max}}}; domain failures (no position,
// HF<1, over borrowing power) arrive as top-level GraphQL errors — gqlRequest
// already surfaces those as legible ok:false strings.
import { DEFAULT_CHAIN_ID, gqlRequest, type AaveOpts, type AaveResult } from "./aave";

/** A transaction for the USER to sign — the transaction-layer contract. */
export interface SendTransactionAction {
  action: "send_transaction";
  label: string;
  summary: string;
  tx: { to: string; data: string; value: string; chainId: number };
}

interface GqlTx {
  to?: string;
  from?: string;
  data?: string;
  value?: string;
  chainId?: number;
  operations?: string[] | null;
}
interface GqlDecimal {
  value?: string;
  decimals?: number;
}

const TR_FIELDS = "to from data value chainId operations";

const SUPPLY_QUERY = `query Supply($request: SupplyRequest!) {
  supply(request: $request) {
    __typename
    ... on TransactionRequest { ${TR_FIELDS} }
    ... on Erc20ApprovalRequired {
      reason
      requiredAmount { value decimals }
      currentAllowance { value decimals }
      approvals { byTransaction { ${TR_FIELDS} } }
      originalTransaction { ${TR_FIELDS} }
    }
    ... on PreContractActionRequired {
      reason
      transaction { ${TR_FIELDS} }
      originalTransaction { ${TR_FIELDS} }
    }
    ... on InsufficientBalanceError {
      required { value decimals }
      available { value decimals }
    }
  }
}`;

const WITHDRAW_QUERY = `query Withdraw($request: WithdrawRequest!) {
  withdraw(request: $request) {
    __typename
    ... on TransactionRequest { ${TR_FIELDS} }
    ... on PreContractActionRequired {
      reason
      transaction { ${TR_FIELDS} }
      originalTransaction { ${TR_FIELDS} }
    }
    ... on InsufficientBalanceError {
      required { value decimals }
      available { value decimals }
    }
  }
}`;

const BORROW_QUERY = `query Borrow($request: BorrowRequest!) {
  borrow(request: $request) {
    __typename
    ... on TransactionRequest { ${TR_FIELDS} }
    ... on PreContractActionRequired {
      reason
      transaction { ${TR_FIELDS} }
      originalTransaction { ${TR_FIELDS} }
    }
  }
}`;

const REPAY_QUERY = `query Repay($request: RepayRequest!) {
  repay(request: $request) {
    __typename
    ... on TransactionRequest { ${TR_FIELDS} }
    ... on Erc20ApprovalRequired {
      reason
      requiredAmount { value decimals }
      currentAllowance { value decimals }
      approvals { byTransaction { ${TR_FIELDS} } }
      originalTransaction { ${TR_FIELDS} }
    }
    ... on PreContractActionRequired {
      reason
      transaction { ${TR_FIELDS} }
      originalTransaction { ${TR_FIELDS} }
    }
    ... on InsufficientBalanceError {
      required { value decimals }
      available { value decimals }
    }
  }
}`;

const SET_COLLATERAL_QUERY = `query SetCollateral($request: SetUserSuppliesAsCollateralRequest!) {
  setUserSuppliesAsCollateral(request: $request) {
    __typename
    ... on TransactionRequest { ${TR_FIELDS} }
  }
}`;

const PREVIEW_QUERY = `query Preview($request: PreviewRequest!) {
  preview(request: $request) {
    __typename
    healthFactor {
      __typename
      ... on HealthFactorVariation { current after }
      ... on HealthFactorError { reason current after }
    }
    netApy { current { value normalized } after { value normalized } }
    netCollateral { current { value symbol } after { value symbol } }
    remainingBorrowingPower { current { value symbol } after { value symbol } }
    reserveRates {
      supplyApy { current { value normalized } after { value normalized } }
      borrowApy { current { value normalized } after { value normalized } }
    }
  }
}`;

// ReserveId (base64 chainId::spoke::onChainId) is what every tx query wants —
// resolve it from the human inputs (spoke address + token address). The same
// asset can appear as separate supply-only / borrow-only reserve rows on one
// spoke, so the op decides which leg wins.
const RESERVE_LOOKUP_QUERY = `query($request: ReservesRequest!) {
  reserves(request: $request) {
    id canSupply canBorrow
    spoke { name address }
    asset { underlying { address info { symbol decimals } } }
  }
}`;

interface ResolvedReserve {
  id: string;
  symbol: string;
  decimals: number | null;
  spokeName: string;
}

async function resolveReserve(
  args: { spokeAddress: string; currency: string; chainId: number; need: "supply" | "borrow" },
  opts?: AaveOpts,
): Promise<ResolvedReserve | AaveResult> {
  const r = await gqlRequest(
    RESERVE_LOOKUP_QUERY,
    { request: { query: { tokens: [{ address: args.currency, chainId: args.chainId }] } } },
    opts,
  );
  if (!r.ok) return r;
  const rows = ((r.data as { reserves?: Record<string, any>[] })?.reserves ?? []).filter(
    (x) => typeof x.spoke?.address === "string",
  );
  if (rows.length === 0) {
    return {
      ok: false,
      status: 404,
      data: `No Aave v4 reserve lists token ${args.currency} on chain ${args.chainId}. Use \`reserves\` to see what's listed.`,
    };
  }
  const onSpoke = rows.filter((x) => x.spoke.address.toLowerCase() === args.spokeAddress.toLowerCase());
  if (onSpoke.length === 0) {
    const where = rows.map((x) => `${x.spoke.name} (${x.spoke.address})`).join(", ");
    return {
      ok: false,
      status: 404,
      data: `Token ${args.currency} isn't listed on spoke ${args.spokeAddress}. It IS listed on: ${where}.`,
    };
  }
  const pick = onSpoke.find((x) => (args.need === "supply" ? x.canSupply : x.canBorrow)) ?? onSpoke[0];
  return {
    id: pick.id as string,
    symbol: pick.asset?.underlying?.info?.symbol ?? "token",
    decimals: pick.asset?.underlying?.info?.decimals ?? null,
    spokeName: pick.spoke?.name ?? args.spokeAddress,
  };
}

const isErr = (v: unknown): v is AaveResult =>
  typeof v === "object" && v !== null && "ok" in v && (v as AaveResult).ok === false;

const step = (label: string, summary: string, tx: GqlTx): SendTransactionAction => ({
  action: "send_transaction",
  label,
  summary,
  tx: {
    to: tx.to ?? "",
    data: tx.data ?? "0x",
    value: tx.value ?? "0",
    chainId: tx.chainId ?? DEFAULT_CHAIN_ID,
  },
});

const submitWith = (finalOp: string) =>
  `Each step is an UNSIGNED transaction for the USER's wallet (eth_sendTransaction), in order — this service never signs. After the final step confirms, call check_transaction with the tx hash and operation ${finalOp}, then re-read portfolio.`;

/**
 * Reshape an ExecutionPlan union member into ordered send_transaction steps.
 * Returns AaveResult so upstream domain errors and typed error members read
 * the same way to the planner.
 */
function planToResult(
  plan: Record<string, any> | null | undefined,
  op: { label: string; opEnum: string; summary: string; symbol: string; spokeName: string },
): AaveResult {
  if (!plan?.__typename) {
    return { ok: false, status: 502, data: "AaveKit returned no execution plan." };
  }

  if (plan.__typename === "InsufficientBalanceError") {
    const req = plan.required as GqlDecimal | undefined;
    const avail = plan.available as GqlDecimal | undefined;
    return {
      ok: false,
      status: 400,
      data: `Insufficient balance: this needs ${req?.value ?? "?"} ${op.symbol} but the wallet holds ${avail?.value ?? "?"} ${op.symbol}. Nothing was built.`,
    };
  }

  const steps: SendTransactionAction[] = [];
  let allowance: Record<string, unknown> | undefined;

  if (plan.__typename === "Erc20ApprovalRequired") {
    const approvals = (plan.approvals ?? []) as { byTransaction?: GqlTx }[];
    approvals.forEach((a, i) => {
      if (!a.byTransaction) return;
      const label = approvals.length > 1 ? `approve ${i + 1}/${approvals.length}` : "approve";
      steps.push(
        step(
          label,
          `Approve ${plan.requiredAmount?.value ?? ""} ${op.symbol} for Aave v4 ${op.spokeName}${approvals.length > 1 && i === 0 ? " (allowance reset first — this token requires it)" : ""}`,
          a.byTransaction,
        ),
      );
    });
    allowance = {
      requiredAllowance: plan.requiredAmount?.value ?? null,
      currentAllowance: plan.currentAllowance?.value ?? null,
    };
    if (plan.originalTransaction) steps.push(step(op.label, op.summary, plan.originalTransaction as GqlTx));
  } else if (plan.__typename === "PreContractActionRequired") {
    if (plan.transaction) {
      steps.push(step("prepare", `Required first: ${plan.reason ?? "pre-contract action"}`, plan.transaction as GqlTx));
    }
    if (plan.originalTransaction) steps.push(step(op.label, op.summary, plan.originalTransaction as GqlTx));
  } else if (plan.__typename === "TransactionRequest") {
    steps.push(step(op.label, op.summary, plan as GqlTx));
  } else {
    return { ok: false, status: 502, data: `Unexpected execution plan type: ${plan.__typename}` };
  }

  if (steps.length === 0) {
    return { ok: false, status: 502, data: `Execution plan (${plan.__typename}) carried no transaction.` };
  }

  return {
    ok: true,
    status: 200,
    data: {
      operation: op.label,
      spoke: op.spokeName,
      asset: op.symbol,
      ...(allowance ?? {}),
      steps,
      submit_with: submitWith(op.opEnum),
    },
  };
}

// ── Public build surface ─────────────────────────────────────────────────────

export interface BuildArgs {
  spokeAddress: string;
  currency: string;
  user: string;
  amount?: string;
  max?: boolean;
  chainId?: number;
}

async function runBuild(
  args: BuildArgs,
  spec: {
    need: "supply" | "borrow";
    query: string;
    root: string;
    label: string;
    opEnum: string;
    amountShape: (a: { amount?: string; max?: boolean }) => Record<string, unknown>;
    summary: (symbol: string, spoke: string, amount: string) => string;
    extraRequest?: Record<string, unknown>;
  },
  opts?: AaveOpts,
): Promise<AaveResult> {
  const chainId = args.chainId ?? DEFAULT_CHAIN_ID;
  const reserve = await resolveReserve(
    { spokeAddress: args.spokeAddress, currency: args.currency, chainId, need: spec.need },
    opts,
  );
  if (isErr(reserve)) return reserve;
  const res = reserve as ResolvedReserve;

  const r = await gqlRequest(
    spec.query,
    {
      request: {
        sender: args.user,
        reserve: res.id,
        amount: spec.amountShape(args),
        ...(spec.extraRequest ?? {}),
      },
    },
    opts,
  );
  if (!r.ok) return r; // incl. server-side guardrails ("Bad user input - …")

  const plan = (r.data as Record<string, any>)?.[spec.root];
  const amountText = args.max ? `ALL ${res.symbol}` : `${args.amount} ${res.symbol}`;
  return planToResult(plan, {
    label: spec.label,
    opEnum: spec.opEnum,
    summary: spec.summary(res.symbol, res.spokeName, amountText),
    symbol: res.symbol,
    spokeName: res.spokeName,
  });
}

export const builds = {
  /** Supply (deposit) a token into a spoke's pool. */
  supply: (args: BuildArgs & { enableCollateral?: boolean }, opts?: AaveOpts): Promise<AaveResult> =>
    runBuild(
      args,
      {
        need: "supply",
        query: SUPPLY_QUERY,
        root: "supply",
        label: "supply",
        opEnum: "SPOKE_SUPPLY",
        amountShape: (a) => ({ erc20: { value: a.amount } }),
        summary: (sym, spoke, amt) => `Supply ${amt} to Aave v4 ${spoke} — starts earning the pool's supply APY`,
        ...(args.enableCollateral !== undefined ? { extraRequest: { enableCollateral: args.enableCollateral } } : {}),
      },
      opts,
    ),

  /** Withdraw a supplied token (exact amount or max). NOTE: flat AmountInput. */
  withdraw: (args: BuildArgs, opts?: AaveOpts): Promise<AaveResult> =>
    runBuild(
      args,
      {
        need: "supply",
        query: WITHDRAW_QUERY,
        root: "withdraw",
        label: "withdraw",
        opEnum: "SPOKE_WITHDRAW",
        amountShape: (a) => ({ erc20: a.max ? { max: true } : { exact: a.amount } }),
        summary: (sym, spoke, amt) => `Withdraw ${amt} from Aave v4 ${spoke} back to the wallet`,
      },
      opts,
    ),

  /** Borrow against supplied collateral. */
  borrow: (args: BuildArgs, opts?: AaveOpts): Promise<AaveResult> =>
    runBuild(
      args,
      {
        need: "borrow",
        query: BORROW_QUERY,
        root: "borrow",
        label: "borrow",
        opEnum: "SPOKE_BORROW",
        amountShape: (a) => ({ erc20: { value: a.amount } }),
        summary: (sym, spoke, amt) => `Borrow ${amt} from Aave v4 ${spoke} against supplied collateral`,
      },
      opts,
    ),

  /** Repay borrowed debt (exact or max — max quotes debt + accrued interest). */
  repay: (args: BuildArgs, opts?: AaveOpts): Promise<AaveResult> =>
    runBuild(
      args,
      {
        need: "borrow",
        query: REPAY_QUERY,
        root: "repay",
        label: "repay",
        opEnum: "SPOKE_REPAY",
        amountShape: (a) => ({ erc20: { value: a.max ? { max: true } : { exact: a.amount } } }),
        summary: (sym, spoke, amt) => `Repay ${amt} of debt on Aave v4 ${spoke}`,
      },
      opts,
    ),

  /** Toggle a supplied reserve's use-as-collateral flag. */
  setCollateral: async (
    args: { spokeAddress: string; currency: string; user: string; enable: boolean; chainId?: number },
    opts?: AaveOpts,
  ): Promise<AaveResult> => {
    const chainId = args.chainId ?? DEFAULT_CHAIN_ID;
    const reserve = await resolveReserve(
      { spokeAddress: args.spokeAddress, currency: args.currency, chainId, need: "supply" },
      opts,
    );
    if (isErr(reserve)) return reserve;
    const res = reserve as ResolvedReserve;
    const r = await gqlRequest(
      SET_COLLATERAL_QUERY,
      { request: { sender: args.user, changes: [{ reserve: res.id, enableCollateral: args.enable }] } },
      opts,
    );
    if (!r.ok) return r;
    const plan = (r.data as Record<string, any>)?.setUserSuppliesAsCollateral;
    return planToResult(plan, {
      label: "set_collateral",
      opEnum: "SPOKE_SET_USER_USING_AS_COLLATERAL",
      summary: `${args.enable ? "Enable" : "Disable"} ${res.symbol} as collateral on Aave v4 ${res.spokeName}`,
      symbol: res.symbol,
      spokeName: res.spokeName,
    });
  },

  /** Preview the position AFTER a hypothetical action — health factor first. */
  preview: async (
    args: BuildArgs & { action: "supply" | "borrow" | "withdraw" | "repay" },
    opts?: AaveOpts,
  ): Promise<AaveResult> => {
    const chainId = args.chainId ?? DEFAULT_CHAIN_ID;
    const need = args.action === "borrow" || args.action === "repay" ? "borrow" : "supply";
    const reserve = await resolveReserve(
      { spokeAddress: args.spokeAddress, currency: args.currency, chainId, need },
      opts,
    );
    if (isErr(reserve)) return reserve;
    const res = reserve as ResolvedReserve;

    // Each action mirrors its own tx query's amount shape (live-validated).
    const amount =
      args.action === "withdraw"
        ? { erc20: args.max ? { max: true } : { exact: args.amount } }
        : args.action === "repay"
          ? { erc20: { value: args.max ? { max: true } : { exact: args.amount } } }
          : { erc20: { value: args.amount } };
    const r = await gqlRequest(
      PREVIEW_QUERY,
      { request: { action: { [args.action]: { sender: args.user, reserve: res.id, amount } } } },
      opts,
    );
    if (!r.ok) return r;
    const p = (r.data as Record<string, any>)?.preview;
    if (!p) return { ok: false, status: 502, data: "AaveKit returned no preview." };

    const hf = p.healthFactor ?? {};
    const pctPair = (x: Record<string, any> | undefined) => ({
      current: x?.current?.normalized ?? null,
      after: x?.after?.normalized ?? null,
    });
    return {
      ok: true,
      status: 200,
      data: {
        action: args.action,
        asset: res.symbol,
        spoke: res.spokeName,
        amount: args.max ? "max" : args.amount,
        healthFactor: {
          current: hf.current ?? null,
          // after:null on a full repay = no debt left = infinite health factor.
          after: hf.after ?? (hf.__typename === "HealthFactorVariation" ? "∞ (no debt)" : null),
          ...(hf.reason ? { warning: hf.reason } : {}),
        },
        netApyPct: pctPair(p.netApy),
        netCollateralUsd: {
          current: p.netCollateral?.current?.value ?? null,
          after: p.netCollateral?.after?.value ?? null,
        },
        remainingBorrowingPowerUsd: {
          current: p.remainingBorrowingPower?.current?.value ?? null,
          after: p.remainingBorrowingPower?.after?.value ?? null,
        },
        poolRates: {
          supplyApyPct: pctPair(p.reserveRates?.supplyApy),
          borrowApyPct: pctPair(p.reserveRates?.borrowApy),
        },
        note: "Simulation only — nothing built or signed. If the after health factor is comfortable, proceed with the matching build_* tool.",
      },
    };
  },
};
