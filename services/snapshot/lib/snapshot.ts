// Snapshot hub GraphQL client. snapshot.box is the app; hub.snapshot.org is the
// API — a single free, public POST GraphQL endpoint, NO auth required. An
// optional SNAPSHOT_API_KEY only raises rate limits; it is held server-side and
// never exposed to paying clients. (Read tools are x402-paid for hosting +
// convenience over public data.)

const SNAPSHOT_HUB = process.env.SNAPSHOT_HUB_URL ?? "https://hub.snapshot.org";
const GRAPHQL_URL = `${SNAPSHOT_HUB}/graphql`;

// Cap response size returned through MCP so a huge page can't blow up the
// agent's context. Callers can narrow `first` for more.
const MAX_RESPONSE_CHARS = 24_000;

// Injectable seams for tests — production passes neither (env key optional, global fetch).
export interface SnapshotOpts {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

export interface SnapshotResult {
  ok: boolean;
  status: number;
  data: unknown;
  truncated: boolean;
}

/** POST a GraphQL query to the Snapshot hub. No auth needed; key is optional. */
export async function snapshotQuery(
  query: string,
  variables?: Record<string, unknown>,
  opts?: SnapshotOpts,
): Promise<SnapshotResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = opts?.apiKey ?? process.env.SNAPSHOT_API_KEY;
  if (key) headers["x-api-key"] = key; // optional rate-limit key

  const res = await doFetch(GRAPHQL_URL, {
    method: "POST",
    headers,
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

  // GraphQL returns 200 with an `errors` array on a bad query — surface that as
  // a non-ok result so the tool reports it instead of returning empty `data`.
  let ok = res.ok;
  let data: unknown = parsed;
  if (parsed && typeof parsed === "object") {
    const body = parsed as { data?: unknown; errors?: unknown };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      ok = false;
      data = { errors: body.errors };
    } else if ("data" in body) {
      data = body.data;
    }
  }

  // Trim oversized payloads. Return a raw clipped string (never re-parse a cut
  // JSON fragment — that would throw on a perfectly good large response).
  let truncated = false;
  if (typeof data !== "string") {
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_RESPONSE_CHARS) {
      truncated = true;
      data = {
        note: `Response truncated to ~${MAX_RESPONSE_CHARS} chars — lower \`first\` or narrow your query. \`preview\` is a raw (clipped) JSON string.`,
        preview: serialized.slice(0, MAX_RESPONSE_CHARS),
      };
    }
  }

  return { ok, status: res.status, data, truncated };
}

// ── Typed query wrappers ─────────────────────────────────────────────────────
// Field names VERIFIED against a live hub.snapshot.org query (2026-06-16):
// proposals carry id/title/state/choices/type/scores_total/end/space{id,name}.

const PROPOSAL_FIELDS = `id title state type choices scores scores_total
  start end snapshot author quorum space { id name network symbol }`;

export const queries = {
  /** Recent proposals, optionally filtered by space + state (active|closed|pending). */
  listProposals: (
    args: { space?: string; state?: string; first?: number },
    opts?: SnapshotOpts,
  ) => {
    const where: Record<string, unknown> = {};
    if (args.space) where.space_in = [args.space];
    if (args.state) where.state = args.state;
    return snapshotQuery(
      `query ($first: Int!, $where: ProposalWhere) {
        proposals(first: $first, orderBy: "created", orderDirection: desc, where: $where) {
          id title state type choices scores_total end space { id name }
        }
      }`,
      { first: args.first ?? 10, where },
      opts,
    );
  },

  /** One proposal in full — the body, choices, scores, type, and voting window. */
  getProposal: (id: string, opts?: SnapshotOpts) =>
    snapshotQuery(
      `query ($id: String!) { proposal(id: $id) { ${PROPOSAL_FIELDS} body } }`,
      { id },
      opts,
    ),

  /** Votes cast on a proposal, highest voting-power first. */
  listVotes: (proposal: string, first?: number, opts?: SnapshotOpts) =>
    snapshotQuery(
      `query ($proposal: String!, $first: Int!) {
        votes(first: $first, where: { proposal: $proposal }, orderBy: "vp", orderDirection: desc) {
          id voter choice vp reason created
        }
      }`,
      { proposal, first: first ?? 20 },
      opts,
    ),

  /** Space (DAO) metadata. */
  getSpace: (id: string, opts?: SnapshotOpts) =>
    snapshotQuery(
      `query ($id: String!) {
        space(id: $id) { id name about network symbol proposalsCount followersCount }
      }`,
      { id },
      opts,
    ),

  /** Browse spaces, most followed first. */
  listSpaces: (first?: number, opts?: SnapshotOpts) =>
    snapshotQuery(
      `query ($first: Int!) {
        spaces(first: $first, orderBy: "followersCount", orderDirection: desc) {
          id name network proposalsCount followersCount
        }
      }`,
      { first: first ?? 20 },
      opts,
    ),
};

/** Fetch just the fields prepare_vote needs to build correct typed data. */
export interface ProposalForVote {
  id: string;
  title: string;
  type: string;
  state: string;
  choices: string[];
  space: { id: string };
  end: number;
}

export async function fetchProposalForVote(
  id: string,
  opts?: SnapshotOpts,
): Promise<ProposalForVote> {
  const r = await snapshotQuery(
    `query ($id: String!) {
      proposal(id: $id) { id title type state choices end space { id } }
    }`,
    { id },
    opts,
  );
  if (!r.ok) throw new Error(`Snapshot query failed: ${JSON.stringify(r.data)}`);
  const proposal = (r.data as { proposal?: ProposalForVote } | null)?.proposal;
  if (!proposal) throw new Error(`Proposal not found: ${id}`);
  return proposal;
}
