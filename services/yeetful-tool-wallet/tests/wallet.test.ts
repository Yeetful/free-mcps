import { describe, expect, it } from "vitest";
import { resolveChain, resolveChains, CHAINS } from "@/lib/chains";
import { clip, getPortfolio, getRecentTransactions, getTokenBalance, getTransactionStatus } from "@/lib/alchemy";
import { OWNER, callsOf, dataApiHandler, mockFetch, transfersHandler } from "./fixtures";

describe("chain resolution", () => {
  it("accepts keys, names, and chainIds", () => {
    expect(resolveChain("base").label).toBe("Base");
    expect(resolveChain("Arbitrum").key).toBe("arb");
    expect(resolveChain("8453").key).toBe("base");
    expect(resolveChain("polygon").key).toBe("pol");
    expect(resolveChain("matic").key).toBe("pol");
    expect(resolveChain("binance").key).toBe("bsc");
    expect(resolveChain("robinhood").key).toBe("rh");
    expect(resolveChain("Robinhood Chain").key).toBe("rh");
    expect(resolveChain("4663").key).toBe("rh");
  });

  it("rejects unknown chains with the covered list", () => {
    expect(() => resolveChain("solana")).toThrow(/Unknown chain "solana"/);
  });

  it("defaults to all chains and de-dupes filters", () => {
    expect(resolveChains()).toHaveLength(CHAINS.length);
    expect(resolveChains(["base", "8453", "Base"])).toHaveLength(1);
  });
});

describe("portfolio", () => {
  it("prices holdings across chains, filters spam, sorts richest-first", async () => {
    const f = mockFetch(dataApiHandler);
    const p = await getPortfolio({ owner: OWNER, chains: resolveChains(["base", "arbitrum", "polygon", "eth"]) }, { fetchImpl: f });

    expect(p.kind).toBe("portfolio"); // the pretty-render contract
    expect(p.owner).toBe(OWNER);
    // USDC base 4.86 + USDC arb 0.54 + ETH 1.76 + POL 1.00 ≈ 8.16; spam+unpriced hidden
    expect(p.totalUsd).toBeGreaterThan(8);
    expect(p.totalUsd).toBeLessThan(9);
    expect(p.hiddenDust).toBe(2);
    expect(p.holdings[0].symbol).toBe("USDC");
    expect(p.holdings[0].chain).toBe("Base");
    // matic-mainnet response slug maps back to Polygon
    expect(p.holdings.some((h) => h.chain === "Polygon" && h.native)).toBe(true);
    // zero-balance eth-mainnet row dropped → chains subtotals only for chains with holdings
    expect(p.chains.map((c) => c.chain).sort()).toEqual(["Arbitrum", "Base", "Polygon"]);
    expect(p.summary).toContain("$");
    expect(p.summary).toContain("fetched just now");

    // The request covers the asked networks in ONE Data API call.
    const call = callsOf(f)[0];
    expect(call.url).toContain("/assets/tokens/by-address");
    const nets = (call.body.addresses as { networks: string[] }[])[0].networks;
    expect(nets).toContain("base-mainnet");
    expect(nets).toContain("polygon-mainnet");
  });

  it("nativeOnly skips ERC-20s (gas_balances path)", async () => {
    const f = mockFetch(dataApiHandler);
    await getPortfolio({ owner: OWNER, chains: resolveChains(), nativeOnly: true, minUsd: 0 }, { fetchImpl: f });
    expect(callsOf(f)[0].body.includeErc20Tokens).toBe(false);
  });

  it("refuses a bad owner address with $USER_ADDRESS guidance", async () => {
    const f = mockFetch(dataApiHandler);
    await expect(getPortfolio({ owner: "$USER_ADDRESS", chains: resolveChains() }, { fetchImpl: f })).rejects.toThrow(/USER_ADDRESS/);
  });
});

describe("recent transactions", () => {
  it("merges both directions across chains, newest first, with explorer links", async () => {
    const f = mockFetch(transfersHandler);
    const r = await getRecentTransactions({ owner: OWNER, chains: resolveChains(["base"]) }, { fetchImpl: f });
    expect(r.kind).toBe("activity");
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0].hash).toBe("0xdeposit"); // 07-09 beats 07-08
    expect(r.transactions[0].direction).toBe("out");
    expect(r.transactions[0].explorerUrl).toBe("https://basescan.org/tx/0xdeposit");
    expect(r.transactions[1].direction).toBe("in");
  });

  it("flags homoglyph-spoofed asset symbols as suspicious (live scam pattern)", async () => {
    const f = mockFetch((url, body) => {
      if (body.method !== "alchemy_getAssetTransfers") return null;
      const params = (body.params as Record<string, unknown>[])[0] ?? {};
      if (!params.toAddress) return { body: { jsonrpc: "2.0", id: 1, result: { transfers: [] } } };
      return {
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            transfers: [
              {
                hash: "0xscam",
                from: "0x8888888888888888888888888888888888888888",
                to: OWNER.toLowerCase(),
                value: 0.55,
                asset: "U឵S឵Dꓚ", // homoglyph "USDC" seen live
                category: "erc20",
                metadata: { blockTimestamp: "2026-07-09T16:00:00.000Z" },
              },
            ],
          },
        },
      };
    });
    const r = await getRecentTransactions({ owner: OWNER, chains: resolveChains(["base"]) }, { fetchImpl: f });
    expect(r.transactions[0].suspicious).toBe(true);
    expect(r.transactions[0].asset).toContain("scam");
    expect(r.transactions[0].asset).not.toContain("឵");
  });

  it("survives one chain failing (independent fetches)", async () => {
    const f = mockFetch((url, body) => {
      if (body.method !== "alchemy_getAssetTransfers") return null;
      if (url.includes("arb-mainnet")) return { status: 500, body: { error: "boom" } };
      return transfersHandler(url, body);
    });
    const r = await getRecentTransactions({ owner: OWNER, chains: resolveChains(["base", "arb"]) }, { fetchImpl: f });
    expect(r.transactions.length).toBeGreaterThan(0);
  });
});

describe("token balance", () => {
  it("reads native via eth_getBalance", async () => {
    const f = mockFetch((url, body) => (body.method === "eth_getBalance" ? { body: { jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" } } : null));
    const r = await getTokenBalance({ owner: OWNER, chain: resolveChain("base"), token: "native" }, { fetchImpl: f });
    expect(r.balance).toBe("1");
    expect(r.native).toBe(true);
  });

  it("reads an ERC-20 with live metadata decimals", async () => {
    const f = mockFetch(
      (url, body) =>
        body.method === "alchemy_getTokenBalances"
          ? { body: { jsonrpc: "2.0", id: 1, result: { tokenBalances: [{ tokenBalance: "0x84fa3" }] } } } // 544675? no: 0x84fa3 = 544675
          : null,
      (url, body) =>
        body.method === "alchemy_getTokenMetadata"
          ? { body: { jsonrpc: "2.0", id: 1, result: { symbol: "USDC", decimals: 6, name: "USD Coin" } } }
          : null,
    );
    const r = await getTokenBalance(
      { owner: OWNER, chain: resolveChain("arbitrum"), token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
      { fetchImpl: f },
    );
    expect(r.token).toBe("USDC");
    expect(r.decimals).toBe(6);
    expect(String(r.balance)).toContain("0.54");
  });

  it("guides symbol inputs toward portfolio", async () => {
    const f = mockFetch();
    await expect(getTokenBalance({ owner: OWNER, chain: resolveChain("base"), token: "USDC" }, { fetchImpl: f })).rejects.toThrow(
      /portfolio/,
    );
  });
});

describe("transaction status", () => {
  const HASH = "0x" + "ab".repeat(32);

  it("reports CONFIRMED with confirmation count and fresh-data pointer", async () => {
    const f = mockFetch(
      (url, body) =>
        body.method === "eth_getTransactionReceipt"
          ? { body: { jsonrpc: "2.0", id: 1, result: { status: "0x1", blockNumber: "0x64", from: OWNER, to: "0xdead", logs: [{}] } } }
          : null,
      (url, body) => (body.method === "eth_blockNumber" ? { body: { jsonrpc: "2.0", id: 1, result: "0x6e" } } : null),
    );
    const r = await getTransactionStatus({ chain: resolveChain("base"), hash: HASH }, { fetchImpl: f });
    expect(r.status).toBe("CONFIRMED");
    expect(r.confirmations).toBe(11);
    expect(String(r.explanation)).toContain("portfolio");
  });

  it("explains REVERTED and pending", async () => {
    const reverted = mockFetch(
      (url, body) =>
        body.method === "eth_getTransactionReceipt"
          ? { body: { jsonrpc: "2.0", id: 1, result: { status: "0x0", blockNumber: "0x64" } } }
          : null,
      (url, body) => (body.method === "eth_blockNumber" ? { body: { jsonrpc: "2.0", id: 1, result: "0x65" } } : null),
    );
    const r1 = await getTransactionStatus({ chain: resolveChain("base"), hash: HASH }, { fetchImpl: reverted });
    expect(r1.status).toBe("REVERTED");
    expect(String(r1.explanation)).toContain("no state changed");

    const pending = mockFetch(
      (url, body) => (body.method === "eth_getTransactionReceipt" ? { body: { jsonrpc: "2.0", id: 1, result: null } } : null),
      (url, body) => (body.method === "eth_blockNumber" ? { body: { jsonrpc: "2.0", id: 1, result: "0x65" } } : null),
    );
    const r2 = await getTransactionStatus({ chain: resolveChain("base"), hash: HASH }, { fetchImpl: pending });
    expect(r2.status).toBe("PENDING_OR_UNKNOWN");
  });

  it("rejects malformed hashes", async () => {
    const f = mockFetch();
    await expect(getTransactionStatus({ chain: resolveChain("base"), hash: "0x123" }, { fetchImpl: f })).rejects.toThrow(/64-hex/);
  });
});

describe("clip", () => {
  it("truncates oversized payloads", () => {
    const clipped = clip({ rows: "x".repeat(30_000) }) as { note: string };
    expect(clipped.note).toContain("truncated");
  });
});
