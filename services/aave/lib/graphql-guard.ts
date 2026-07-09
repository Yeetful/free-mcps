// Guardrails for the raw-GraphQL escape hatch (`graphql_query` tool) —
// the RR12 tier pattern, same role as snapshot's graphql-guard and
// hyperliquid's info-guard.
//
// The AaveKit API is public and unauthenticated, and even its transaction
// queries only PREPARE calldata (nothing executes server-side) — so the risk
// of exposing it is hosting abuse plus tool-surface confusion, not fund
// safety. The guard is structural: parse with the reference parser and
// enforce shape (single read-only query op, allowlisted root fields, bounded
// size/depth), never sanitize with regexes. Transaction PREPARATION is
// deliberately NOT in the allowlist — the build_* tools own that path so
// every prepared transaction flows through their summary + approval shaping.
import { Kind, parse, type DocumentNode, type SelectionSetNode } from "graphql";

/** Read-only root query fields the escape hatch may select (api.v4.aave.com). */
export const ALLOWED_ROOT_FIELDS = new Set([
  "chains",
  "hubs",
  "hub",
  "spokes",
  "spoke",
  "reserves",
  "reserve",
  "reserveHolders",
  "userPositions",
  "userPosition",
  "userSupplies",
  "userBorrows",
  "userBalances",
  "userTransactionHistory",
  "activities",
  "hasProcessedKnownTransaction",
]);

const MAX_QUERY_CHARS = 4_000;
const MAX_DEPTH = 8; // AaveKit nests deeper than most (amount→exchange→…)

export type GuardResult = { ok: true } | { ok: false; error: string };

function depthOf(set: SelectionSetNode): number {
  let deepest = 0;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD && sel.selectionSet) {
      deepest = Math.max(deepest, depthOf(sel.selectionSet));
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      // Inline fragments are required for AaveKit's unions (TokenAmount,
      // activities items) — they don't add a JSON level, so no +1.
      deepest = Math.max(deepest, depthOf(sel.selectionSet) - 1);
    }
  }
  return 1 + deepest;
}

/**
 * Validate a raw query for the escape hatch: a single read-only `query`
 * operation, allowlisted root fields, no fragment definitions or
 * introspection, bounded depth. Returns a planner-legible error on rejection.
 */
export function guardQuery(query: string): GuardResult {
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `Query is ${query.length} chars (max ${MAX_QUERY_CHARS}) — select fewer fields.` };
  }

  let doc: DocumentNode;
  try {
    doc = parse(query, { noLocation: true });
  } catch (e) {
    return { ok: false, error: `GraphQL syntax error: ${e instanceof Error ? e.message : String(e)}` };
  }

  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (doc.definitions.length !== ops.length) {
    return { ok: false, error: "Fragment definitions are not supported — inline the selection (`... on Type { … }` inline fragments are fine)." };
  }
  if (ops.length !== 1) {
    return { ok: false, error: `Exactly one operation per call (got ${ops.length}).` };
  }
  const op = ops[0];
  if (op.kind !== Kind.OPERATION_DEFINITION || op.operation !== "query") {
    return {
      ok: false,
      error: `Read-only: only \`query\` operations are allowed (got \`${"operation" in op ? op.operation : "unknown"}\`).`,
    };
  }

  for (const sel of op.selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      return { ok: false, error: "Select root fields directly (no fragment spreads at the root)." };
    }
    const name = sel.name.value;
    if (name === "__schema" || name === "__type") {
      return { ok: false, error: "Introspection is disabled upstream — the tool description lists the queryable root fields." };
    }
    if (name !== "__typename" && !ALLOWED_ROOT_FIELDS.has(name)) {
      return {
        ok: false,
        error: `Root field \`${name}\` is not exposed. Available: ${[...ALLOWED_ROOT_FIELDS].join(", ")}. Transaction building lives in the build_* tools.`,
      };
    }
  }

  const depth = depthOf(op.selectionSet);
  if (depth > MAX_DEPTH) {
    return { ok: false, error: `Query depth ${depth} exceeds the max of ${MAX_DEPTH} — flatten the selection.` };
  }

  return { ok: true };
}
