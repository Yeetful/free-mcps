// The chains this service covers — the top EVM ecosystems Alchemy's Data API
// serves on one key (probed live 2026-07-09, Robinhood Chain 2026-07-13: all
// return balances in a single tokens/by-address call). Every tool speaks
// friendly names AND Alchemy network slugs; note Alchemy REQUESTS
// "polygon-mainnet" but its RESPONSES say "matic-mainnet" — both map to `pol`.

export interface WalletChain {
  /** Short key used in tool args ("base", "arb", …). */
  key: string;
  /** Alchemy network slug used in requests. */
  net: string;
  label: string;
  /** Native currency symbol. */
  native: string;
  explorerTx: string;
  explorerAddress: string;
}

export const CHAINS: WalletChain[] = [
  { key: "eth", net: "eth-mainnet", label: "Ethereum", native: "ETH", explorerTx: "https://etherscan.io/tx/", explorerAddress: "https://etherscan.io/address/" },
  { key: "base", net: "base-mainnet", label: "Base", native: "ETH", explorerTx: "https://basescan.org/tx/", explorerAddress: "https://basescan.org/address/" },
  { key: "arb", net: "arb-mainnet", label: "Arbitrum", native: "ETH", explorerTx: "https://arbiscan.io/tx/", explorerAddress: "https://arbiscan.io/address/" },
  { key: "op", net: "opt-mainnet", label: "Optimism", native: "ETH", explorerTx: "https://optimistic.etherscan.io/tx/", explorerAddress: "https://optimistic.etherscan.io/address/" },
  { key: "pol", net: "polygon-mainnet", label: "Polygon", native: "POL", explorerTx: "https://polygonscan.com/tx/", explorerAddress: "https://polygonscan.com/address/" },
  { key: "bsc", net: "bnb-mainnet", label: "BNB Chain", native: "BNB", explorerTx: "https://bscscan.com/tx/", explorerAddress: "https://bscscan.com/address/" },
  { key: "avax", net: "avax-mainnet", label: "Avalanche", native: "AVAX", explorerTx: "https://snowtrace.io/tx/", explorerAddress: "https://snowtrace.io/address/" },
  { key: "scroll", net: "scroll-mainnet", label: "Scroll", native: "ETH", explorerTx: "https://scrollscan.com/tx/", explorerAddress: "https://scrollscan.com/address/" },
  { key: "gnosis", net: "gnosis-mainnet", label: "Gnosis", native: "xDAI", explorerTx: "https://gnosisscan.io/tx/", explorerAddress: "https://gnosisscan.io/address/" },
  { key: "rh", net: "robinhood-mainnet", label: "Robinhood Chain", native: "ETH", explorerTx: "https://robinhoodchain.blockscout.com/tx/", explorerAddress: "https://robinhoodchain.blockscout.com/address/" },
];

const ALIASES: Record<string, string> = {
  ethereum: "eth",
  mainnet: "eth",
  arbitrum: "arb",
  "arbitrum one": "arb",
  optimism: "op",
  polygon: "pol",
  matic: "pol",
  bnb: "bsc",
  "bnb chain": "bsc",
  binance: "bsc",
  avalanche: "avax",
  xdai: "gnosis",
  robinhood: "rh",
  "robinhood chain": "rh",
};

const CHAIN_IDS: Record<string, string> = {
  "1": "eth",
  "8453": "base",
  "42161": "arb",
  "10": "op",
  "137": "pol",
  "56": "bsc",
  "43114": "avax",
  "534352": "scroll",
  "100": "gnosis",
  "4663": "rh",
};

const BY_KEY = new Map(CHAINS.map((c) => [c.key, c]));
// Responses use matic-mainnet for polygon — accept both slugs when mapping back.
const BY_NET = new Map<string, WalletChain>([
  ...CHAINS.map((c) => [c.net, c] as const),
  ["matic-mainnet", BY_KEY.get("pol")!],
]);

export const chainByNet = (net: string): WalletChain | undefined => BY_NET.get(net);

/** Normalize a user-supplied chain (name, key, or EVM chainId) to its entry. */
export function resolveChain(input: string): WalletChain {
  const raw = input.trim().toLowerCase();
  const key = CHAIN_IDS[raw] ?? ALIASES[raw] ?? raw;
  const chain = BY_KEY.get(key);
  if (!chain) {
    throw new Error(`Unknown chain "${input}". Covered chains: ${CHAINS.map((c) => `${c.key} (${c.label})`).join(", ")}.`);
  }
  return chain;
}

/** Resolve an optional chains filter to entries (default: every covered chain). */
export function resolveChains(inputs?: string[]): WalletChain[] {
  if (!inputs || inputs.length === 0) return CHAINS;
  const seen = new Set<string>();
  const out: WalletChain[] = [];
  for (const input of inputs) {
    const c = resolveChain(input);
    if (!seen.has(c.key)) {
      seen.add(c.key);
      out.push(c);
    }
  }
  return out;
}
