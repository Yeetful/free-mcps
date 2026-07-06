import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { queries, snapshotQuery, fetchProposalForVote, type SnapshotResult } from "./snapshot";
import { guardQuery, ALLOWED_ROOT_FIELDS } from "./graphql-guard";
import { buildVoteTypedData, submitVote, resolveChoiceLabel, type SnapshotChoice } from "./vote";

function present(result: SnapshotResult) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Snapshot API error (HTTP ${result.status}): ${JSON.stringify(result.data)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const firstArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("How many to return (default 10–20, max 100).");

/** Register the Snapshot DAO governance tool surface. */
export function registerSnapshotTools(server: Server): void {
  // ── Read tools ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_proposals",
    {
      title: "List DAO Proposals",
      description:
        "Recent Snapshot governance proposals. Filter by `space` (e.g. aave.eth), `state` (active|closed|pending), and/or `follower` (an EVM address — only proposals in the spaces that address follows; the join is done server-side, so 'what can I vote on' / 'do I have open proposals' is one call with follower + state=active). The default — active proposals across all DAOs — answers 'what DAO votes are live right now'.",
      inputSchema: {
        space: z.string().optional().describe("Snapshot space id, e.g. aave.eth, ens.eth."),
        follower: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .optional()
          .describe("EVM address — scope to proposals in the spaces this address follows (their governance feed)."),
        // Planners/users say "open" for live votes — coerce the common aliases
        // instead of failing validation on the obvious intent.
        state: z
          .preprocess(
            (v) => (v === "open" || v === "live" || v === "ongoing" ? "active" : v),
            z.enum(["active", "closed", "pending"]).optional(),
          )
          .describe("Proposal state filter: active | closed | pending ('open'/'live' are accepted as active)."),
        first: firstArg,
      },
    },
    async ({ space, state, first, follower }) =>
      present(await queries.listProposals({ space, state, first, follower })),
  );

  server.registerTool(
    "get_proposal",
    {
      title: "Get Proposal",
      description:
        "Full detail for one proposal: body, choices, scores, type, author, and voting window. Use the proposal `id` from list_proposals.",
      inputSchema: { id: z.string().min(1).describe("Proposal id (0x… hash).") },
    },
    async ({ id }) => present(await queries.getProposal(id)),
  );

  server.registerTool(
    "list_votes",
    {
      title: "List Votes",
      description: "Votes cast on a proposal, highest voting-power first.",
      inputSchema: {
        proposal: z.string().min(1).describe("Proposal id (0x… hash)."),
        first: firstArg,
      },
    },
    async ({ proposal, first }) => present(await queries.listVotes(proposal, first)),
  );

  server.registerTool(
    "get_space",
    {
      title: "Get Space",
      description: "Metadata for a DAO space (about, network, proposal/follower counts).",
      inputSchema: { id: z.string().min(1).describe("Space id, e.g. aave.eth.") },
    },
    async ({ id }) => present(await queries.getSpace(id)),
  );

  server.registerTool(
    "list_spaces",
    {
      title: "List Spaces",
      description: "Browse DAO spaces, most-followed first.",
      inputSchema: { first: firstArg },
    },
    async ({ first }) => present(await queries.listSpaces(first)),
  );

  // ── Escape hatch ───────────────────────────────────────────────────────────
  // The curated tools cover the common intents; this exposes the hub's FULL
  // read surface for the long tail (author filters, time windows, follows,
  // voting power…) so new intents don't each need a new tool. READ-ONLY by
  // structure (graphql-guard) — anything signable stays in the curated
  // prepare_vote/submit_vote pair.
  server.registerTool(
    "graphql_query",
    {
      title: "Raw GraphQL Query (read-only)",
      description: [
        "Escape hatch: run any READ-ONLY GraphQL query against the Snapshot hub for filters the other tools don't cover. One `query` operation; no mutations, fragments, or introspection; responses truncated ~24k chars.",
        `Root fields: ${[...ALLOWED_ROOT_FIELDS].join(", ")}.`,
        'Useful where-filters — proposals(where:): space_in, state (active|closed|pending), author, author_in, title_contains, start_gte/start_lte, end_gte/end_lte · votes(where:): proposal, voter, space_in, vp_gte · follows(where:): follower, space_in · spaces(where:): id_in.',
        'List args: first (max 100), skip, orderBy (field name string, e.g. "created", "vp", "followersCount"), orderDirection (asc|desc). Pass user values via `variables`, not string interpolation.',
        'Example — spaces an address follows: query($f: String!){ follows(where:{follower:$f}){ space { id name } created } } with variables {"f":"0x…"}.',
      ].join("\n"),
      inputSchema: {
        query: z.string().min(3).max(4000).describe("The GraphQL query document (single read-only operation)."),
        variables: z
          .preprocess(
            // Planners often pass variables as a JSON string — accept both.
            (v) => {
              if (typeof v !== "string") return v;
              try {
                return JSON.parse(v);
              } catch {
                return v;
              }
            },
            z.record(z.unknown()).optional(),
          )
          .describe('GraphQL variables as an object (or JSON string), e.g. {"f":"0xabc…"}.'),
      },
    },
    async ({ query, variables }) => {
      const guard = guardQuery(query, variables);
      if (!guard.ok) return fail(`Query rejected: ${guard.error}`);
      return present(await snapshotQuery(query, variables));
    },
  );

  // ── Vote tools ─────────────────────────────────────────────────────────────
  // prepare_vote builds the EIP-712 "signing string" the USER signs with their
  // own wallet (the voter's address holds the voting power — never the server).
  server.registerTool(
    "prepare_vote",
    {
      title: "Prepare Vote (EIP-712)",
      description:
        "Build the EIP-712 typed data for a Snapshot vote, ready for the voter to sign with their own wallet. Provide EITHER `choice` (1-indexed: a number for single-choice/basic, a number array for approval/ranked-choice, or a {index:weight} map for weighted/quadratic) OR `choiceText` (a human label like \"For\", \"yes\", \"Against\", \"option 2\", or \"A, C\" — resolved against the proposal's choices server-side). Returns the typed data plus a human summary; the signed result goes back through submit_vote.",
      inputSchema: {
        proposal: z.string().min(1).describe("Proposal id (0x… hash) to vote on."),
        from: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .describe("The voter's wallet address (the signer)."),
        choice: z
          .union([z.number().int(), z.array(z.number().int()), z.record(z.number()), z.string()])
          .optional()
          .describe("1-indexed choice. number | number[] | {index:weight} per proposal type."),
        choiceText: z
          .string()
          .optional()
          .describe('Human choice label, e.g. "For", "yes", "Against", "option 2", "A and C".'),
        reason: z.string().optional().describe("Optional reason attached to the vote."),
      },
    },
    async ({ proposal, from, choice, choiceText, reason }) => {
      try {
        const p = await fetchProposalForVote(proposal);
        if (p.state !== "active") {
          return fail(`Proposal is "${p.state}", not active — voting is closed. (${p.title})`);
        }
        let resolved: SnapshotChoice | undefined = choice;
        if (resolved === undefined && choiceText !== undefined) {
          resolved = resolveChoiceLabel(choiceText, p.choices, p.type);
        }
        if (resolved === undefined) {
          return fail("Provide a `choice` or a `choiceText` to vote.");
        }
        const typedData = buildVoteTypedData({
          from,
          space: p.space.id,
          proposalId: p.id,
          proposalType: p.type,
          choice: resolved,
          reason,
        });
        const picked = Array.isArray(resolved)
          ? resolved.map((c) => p.choices[c - 1]).filter(Boolean)
          : typeof resolved === "number"
            ? [p.choices[resolved - 1]].filter(Boolean)
            : typeof resolved === "object" && resolved !== null
              ? Object.keys(resolved as Record<string, number>).map((k) => p.choices[Number(k) - 1])
              : [];
        return ok({
          action: "sign_vote",
          proposal: { id: p.id, title: p.title, type: p.type, choices: p.choices, space: p.space.id },
          choice: resolved,
          choiceLabels: picked,
          summary: `Vote on "${p.title}" (${p.space.id}) — selecting ${picked.join(", ") || JSON.stringify(choice)}. Sign with ${from} to cast it.`,
          typedData,
          submit: {
            tool: "submit_vote",
            note: "Sign the typedData with the voter's wallet, then call submit_vote with { address, sig, typedData }.",
          },
        });
      } catch (e) {
        return fail(`Could not prepare vote: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "submit_vote",
    {
      title: "Submit Signed Vote",
      description:
        "Relay a user-signed vote to the Snapshot sequencer. Provide the voter `address`, the EIP-712 `sig`, and the exact `typedData` returned by prepare_vote. Returns the Snapshot receipt (id / ipfs).",
      inputSchema: {
        address: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .describe("The voter's wallet address."),
        sig: z.string().min(1).describe("EIP-712 signature of the typed data."),
        typedData: z
          .object({
            domain: z.record(z.unknown()),
            types: z.record(z.unknown()),
            message: z.record(z.unknown()),
            primaryType: z.string().optional(),
          })
          .describe("The exact typedData object from prepare_vote."),
      },
    },
    async ({ address, sig, typedData }) => {
      const r = await submitVote({ address, sig, typedData: typedData as never });
      if (!r.ok) {
        return fail(
          `Snapshot sequencer rejected the vote (HTTP ${r.status}): ${JSON.stringify(r.data)}`,
        );
      }
      return ok({ action: "vote_submitted", receipt: r.data });
    },
  );
}

// JSON Schema for the PRIMARY tool, used in the Bazaar discovery extension. Kept
// in sync with list_proposals above (this is what the validator reads).
export const PRIMARY_TOOL = {
  name: "list_proposals",
  description:
    "Recent Snapshot DAO governance proposals (filter by space + state + follower). Other tools: get_proposal, list_votes, get_space, list_spaces, graphql_query (read-only escape hatch for any hub filter), prepare_vote (build EIP-712 vote), submit_vote (relay signed vote).",
  inputSchema: {
    type: "object",
    properties: {
      space: { type: "string", description: "Snapshot space id, e.g. aave.eth." },
      state: { type: "string", enum: ["active", "closed", "pending"], description: "Proposal state." },
      follower: { type: "string", description: "EVM address — only proposals in spaces this address follows." },
      first: { type: "number", description: "How many to return (max 100)." },
    },
    required: [],
    additionalProperties: false,
  },
  example: { state: "active", first: 10 },
} as const;
