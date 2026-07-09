// Shared offline fixtures — shapes mirror the live Alchemy responses (probed
// 2026-07-09 with the real key). Note polygon: requested "polygon-mainnet",
// answered "matic-mainnet".

export const OWNER = "0x5EaaBd731d2Bc0490C2D47e41858e9b0629455a0";

const hex = (n: bigint) => "0x" + n.toString(16);

export const TOKENS_BY_ADDRESS_FIXTURE = {
  data: {
    tokens: [
      {
        network: "base-mainnet",
        tokenAddress: null, // native ETH
        tokenBalance: hex(1_010_000_000_000_000n), // 0.00101 ETH
        tokenMetadata: { symbol: null, decimals: null, name: null },
        tokenPrices: [{ currency: "usd", value: "1740" }],
      },
      {
        network: "base-mainnet",
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenBalance: hex(4_864_600n), // 4.8646 USDC
        tokenMetadata: { symbol: "USDC", decimals: 6, name: "USD Coin" },
        tokenPrices: [{ currency: "usd", value: "0.9997" }],
      },
      {
        network: "arb-mainnet",
        tokenAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        tokenBalance: hex(544_643n), // 0.544643 USDC
        tokenMetadata: { symbol: "USDC", decimals: 6, name: "USD Coin" },
        tokenPrices: [{ currency: "usd", value: "0.9997" }],
      },
      {
        // spam airdrop: priced at ~nothing → hidden as dust
        network: "base-mainnet",
        tokenAddress: "0x1111111111111111111111111111111111111111",
        tokenBalance: hex(1_000_000_000_000_000_000_000n),
        tokenMetadata: { symbol: "FREE-MONEY", decimals: 18, name: "airdrop.scam" },
        tokenPrices: [{ currency: "usd", value: "0.0000000001" }],
      },
      {
        // unpriced non-native → hidden as dust
        network: "matic-mainnet",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        tokenBalance: hex(5_000_000_000_000_000_000n),
        tokenMetadata: { symbol: "MYSTERY", decimals: 18, name: null },
        tokenPrices: [],
      },
      {
        // polygon native under the RESPONSE slug matic-mainnet
        network: "matic-mainnet",
        tokenAddress: null,
        tokenBalance: hex(2_500_000_000_000_000_000n), // 2.5 POL
        tokenMetadata: { symbol: null, decimals: null, name: null },
        tokenPrices: [{ currency: "usd", value: "0.40" }],
      },
      {
        // zero balance → dropped silently
        network: "eth-mainnet",
        tokenAddress: null,
        tokenBalance: "0x0",
        tokenMetadata: { symbol: null, decimals: null, name: null },
        tokenPrices: [{ currency: "usd", value: "1740" }],
      },
    ],
  },
};

export function transfersFixture(direction: "from" | "to") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      transfers:
        direction === "from"
          ? [
              {
                hash: "0xdeposit",
                from: OWNER.toLowerCase(),
                to: "0x7ff0d96c9f0528f0ff8dd948b2d316806fe3c7f2",
                value: 0.55,
                asset: "USDC",
                category: "erc20",
                metadata: { blockTimestamp: "2026-07-09T15:35:00.000Z" },
              },
            ]
          : [
              {
                hash: "0xincoming",
                from: "0x9999999999999999999999999999999999999999",
                to: OWNER.toLowerCase(),
                value: 1.25,
                asset: "ETH",
                category: "external",
                metadata: { blockTimestamp: "2026-07-08T10:00:00.000Z" },
              },
            ],
    },
  };
}

type Handler = (url: string, body: Record<string, unknown>) => { status?: number; body: unknown } | null;

/** Tiny fetch mock: first handler that returns non-null wins. */
export function mockFetch(...handlers: Handler[]): typeof fetch {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    for (const h of handlers) {
      const hit = h(url, body);
      if (hit) {
        return new Response(JSON.stringify(hit.body), {
          status: hit.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch in test: ${url} ${JSON.stringify(body).slice(0, 120)}`);
  }) as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl;
}

export const callsOf = (f: typeof fetch) => (f as unknown as { calls: { url: string; body: Record<string, unknown> }[] }).calls;

export const dataApiHandler: Handler = (url) =>
  url.includes("/assets/tokens/by-address") ? { body: TOKENS_BY_ADDRESS_FIXTURE } : null;

export const transfersHandler: Handler = (url, body) => {
  if (body.method !== "alchemy_getAssetTransfers") return null;
  const params = (body.params as Record<string, unknown>[])[0] ?? {};
  return { body: transfersFixture(params.fromAddress ? "from" : "to") };
};
