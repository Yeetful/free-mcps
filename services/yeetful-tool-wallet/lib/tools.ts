import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { CHAINS, resolveChain, resolveChains } from "./chains";
import { clip, getPortfolio, getRecentTransactions, getTokenBalance, getTransactionStatus } from "./alchemy";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(clip(payload)) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded<T>(run: () => Promise<T> | T) {
  try {
    return ok(await run());
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Call failed.");
  }
}

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const CHAIN_LIST = CHAINS.map((c) => `${c.key} (${c.label})`).join(", ");

const ownerArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe(
    'The wallet address to inspect — for the connected user ALWAYS pass "$USER_ADDRESS"; never guess or reuse an address from conversation. Read-only: inspecting an address needs no signature.',
  );
const chainsArg = z
  .array(z.string())
  .max(9)
  .optional()
  .describe(`Chains to cover, e.g. ["base","arbitrum"]. Omit for ALL covered chains (${CHAIN_LIST}). Names, keys, and EVM chainIds all work.`);
const chainArg = z.string().describe(`One chain — name, key, or EVM chainId (${CHAIN_LIST}).`);

/** Register the multichain wallet tool surface. */
export function registerWalletTools(server: Server): void {
  server.registerTool(
    "chains",
    {
      title: "Covered Chains",
      description: "The chains this wallet service reads (top EVM ecosystems on one Alchemy key). Free, instant, no network calls.",
      inputSchema: {},
    },
    async () =>
      guarded(() => ({
        chains: CHAINS.map((c) => ({ key: c.key, label: c.label, native: c.native })),
        note: "All tools accept chain names, keys, or EVM chainIds. `portfolio` covers every chain in ONE call when the chains filter is omitted.",
      })),
  );

  server.registerTool(
    "portfolio",
    {
      title: "Multichain Portfolio (USD-priced)",
      description:
        'THE answer to "show my portfolio / what do I hold / what\'s my balance on X and Y": every native + ERC-20 holding across the covered chains in ONE call, live from Alchemy, priced to USD, spam filtered, sorted richest-first — with per-chain subtotals and a grand total. ALWAYS call this fresh after a transaction settles (a swap, bridge, transfer…) instead of reusing earlier numbers — balances change the moment a tx lands. Returns a structured `kind:"portfolio"` payload the Yeetful chat renders as a rich card; put the summary line in the reply and let the card carry the rows. Pass owner="$USER_ADDRESS" for the connected user.',
      inputSchema: {
        owner: ownerArg,
        chains: chainsArg,
        minUsd: z.number().min(0).max(1000).optional().describe("Hide holdings below this USD value (default 0.01 — filters airdrop spam)."),
      },
    },
    async ({ owner, chains, minUsd }) => guarded(() => getPortfolio({ owner, chains: resolveChains(chains), minUsd })),
  );

  server.registerTool(
    "gas_balances",
    {
      title: "Native Gas Balances (all chains)",
      description:
        'Just the NATIVE token balance on every covered chain in one call — "do I have gas on Arbitrum?" before building a transaction there. Cheaper and faster than a full portfolio when only gas matters.',
      inputSchema: { owner: ownerArg, chains: chainsArg },
    },
    async ({ owner, chains }) =>
      guarded(async () => {
        const p = await getPortfolio({ owner, chains: resolveChains(chains), nativeOnly: true, minUsd: 0 });
        return {
          owner: p.owner,
          gas: p.holdings.map((h) => ({ chain: h.chain, symbol: h.symbol, balance: h.balance, valueUsd: h.valueUsd })),
          note: "Native balances only (gas). Chains not listed have a zero balance — sending a transaction there needs gas first.",
        };
      }),
  );

  server.registerTool(
    "token_balance",
    {
      title: "One Token Balance (precise)",
      description:
        'A single token\'s live balance for a wallet on one chain — the precise post-transaction check ("did the USDC arrive on Arbitrum?"). token = the 0x contract address, or "native" for the chain\'s gas token. When the contract address is unknown, use `portfolio` instead (it resolves everything the wallet holds).',
      inputSchema: {
        owner: ownerArg,
        chain: chainArg,
        token: z.string().describe('The token\'s 0x contract address on that chain, or "native" for the gas token (ETH/POL/BNB/AVAX/xDAI).'),
      },
    },
    async ({ owner, chain, token }) => guarded(() => getTokenBalance({ owner, chain: resolveChain(chain), token })),
  );

  server.registerTool(
    "recent_transactions",
    {
      title: "Recent Transactions (multichain)",
      description:
        "A wallet's most recent sent + received transfers (external + ERC-20) across the covered chains, merged newest-first with explorer links. Use to answer \"what did I do recently?\", to find a deposit/delivery transaction after a swap, or to confirm an expected incoming transfer landed.",
      inputSchema: {
        owner: ownerArg,
        chains: chainsArg,
        limit: z.number().int().min(1).max(50).optional().describe("Max transfers returned after merging (default 10)."),
      },
    },
    async ({ owner, chains, limit }) => guarded(() => getRecentTransactions({ owner, chains: resolveChains(chains), limit })),
  );

  server.registerTool(
    "transaction_status",
    {
      title: "Transaction Status (did it confirm?)",
      description:
        "One transaction's live status by hash: CONFIRMED (with confirmation count), REVERTED (no state changed), or still pending — plus the explorer link. Call it right after the user signs something to narrate the confirmation, then re-read balances with `portfolio` to show the fresh numbers.",
      inputSchema: { chain: chainArg, hash: z.string().describe("The 0x…64-hex transaction hash.") },
    },
    async ({ chain, hash }) => guarded(() => getTransactionStatus({ chain: resolveChain(chain), hash })),
  );
}
