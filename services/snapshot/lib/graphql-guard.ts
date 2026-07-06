// Guardrails for the raw-GraphQL escape hatch (`graphql_query` tool).
//
// The hub is a public, no-auth, read-only-by-design GraphQL API — the risk of
// exposing it is hosting abuse (huge/deep queries burning our rate budget),
// not data exposure. So the guard is structural: parse with the reference
// parser and enforce shape, never try to sanitize with regexes.
import { parse, Kind, type DocumentNode, type SelectionSetNode } from "graphql";

/** Root query fields the escape hatch may select (hub.snapshot.org schema). */
export const ALLOWED_ROOT_FIELDS = new Set([
  "space",
  "spaces",
  "ranking",
  "proposal",
  "proposals",
  "vote",
  "votes",
  "follows",
  "subscriptions",
  "users",
  "user",
  "statement",
  "statements",
  "vp",
  "messages",
  "aliases",
  "leaderboards",
  "strategies",
  "strategy",
  "networks",
  "plugins",
  "validations",
  "options",
]);

const MAX_QUERY_CHARS = 4_000;
const MAX_DEPTH = 6;
const MAX_FIRST = 100;

export type GuardResult = { ok: true } | { ok: false; error: string };

function depthOf(set: SelectionSetNode): number {
  let deepest = 0;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD && sel.selectionSet) {
      deepest = Math.max(deepest, depthOf(sel.selectionSet));
    }
  }
  return 1 + deepest;
}

/** Collect every `first:` argument value; literals checked directly, variables
 *  resolved against the caller's variables object. */
function firstViolation(
  doc: DocumentNode,
  variables: Record<string, unknown> | undefined,
): string | null {
  let violation: string | null = null;
  const visitSet = (set: SelectionSetNode) => {
    for (const sel of set.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      for (const arg of sel.arguments ?? []) {
        if (arg.name.value !== "first") continue;
        let value: number | undefined;
        if (arg.value.kind === Kind.INT) value = Number(arg.value.value);
        else if (arg.value.kind === Kind.VARIABLE) {
          const v = variables?.[arg.value.name.value];
          if (typeof v === "number") value = v;
        }
        if (value !== undefined && value > MAX_FIRST) {
          violation = `\`first: ${value}\` exceeds the max of ${MAX_FIRST} — page with \`skip\` instead.`;
        }
      }
      if (sel.selectionSet) visitSet(sel.selectionSet);
    }
  };
  for (const def of doc.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) visitSet(def.selectionSet);
  }
  return violation;
}

/**
 * Validate a raw query for the escape hatch: a single read-only `query`
 * operation, allowlisted root fields, no fragments/introspection, bounded
 * depth and page size. Returns a planner-legible error on rejection.
 */
export function guardQuery(
  query: string,
  variables?: Record<string, unknown>,
): GuardResult {
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
    // Fragments are the only other executable definition — the planner never
    // needs them and skipping them keeps depth accounting airtight.
    return { ok: false, error: "Fragment definitions are not supported — inline the selection." };
  }
  if (ops.length !== 1) {
    return { ok: false, error: `Exactly one operation per call (got ${ops.length}).` };
  }
  const op = ops[0];
  if (op.kind !== Kind.OPERATION_DEFINITION || op.operation !== "query") {
    return { ok: false, error: `Read-only: only \`query\` operations are allowed (got \`${"operation" in op ? op.operation : "unknown"}\`).` };
  }

  for (const sel of op.selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      return { ok: false, error: "Fragment spreads are not supported — select root fields directly." };
    }
    const name = sel.name.value;
    if (name === "__schema" || name === "__type") {
      return { ok: false, error: "Introspection is not exposed — the tool description lists the queryable root fields and where-filters." };
    }
    if (name !== "__typename" && !ALLOWED_ROOT_FIELDS.has(name)) {
      return {
        ok: false,
        error: `Root field \`${name}\` is not exposed. Available: ${[...ALLOWED_ROOT_FIELDS].join(", ")}.`,
      };
    }
  }

  const depth = depthOf(op.selectionSet);
  if (depth > MAX_DEPTH) {
    return { ok: false, error: `Query depth ${depth} exceeds the max of ${MAX_DEPTH} — flatten the selection.` };
  }

  const first = firstViolation(doc, variables);
  if (first) return { ok: false, error: first };

  return { ok: true };
}
