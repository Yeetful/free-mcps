// ─────────────────────────────────────────────────────────────────────────
//  Robinhood Chain (chain id 4663, Arbitrum Orbit L2, mainnet 2026-07-01)
//  address book. Sources, fetched 2026-07-14:
//    · Stock/ETF token addresses — docs.robinhood.com/chain/contracts
//    · Chainlink feed proxies    — Chainlink reference data for network
//      "robinhood-mainnet" (docs.chain.link → feeds-robinhood-mainnet.json);
//      every feed is additionally description()-checked live by `pnpm smoke`.
//    · Morpho core + IRM         — docs.morpho.org addresses (chain 4663),
//      bytecode verified via eth_getCode 2026-07-14.
//    · Uniswap v4 quoter/router  — Uniswap deployments/4663.md, bytecode
//      verified via eth_getCode (same pins the Yeetful website uses).
//    · Bridge (L1 side)          — docs.robinhood.com/chain/protocol-contracts.
//  Stock tokens are 18-decimal ERC-20s with the ERC-8056 Scaled-UI extension
//  (uiMultiplier folds in splits/dividends); their Chainlink feeds ALREADY
//  include that multiplier, so a feed price × a raw balance is the correct
//  USD value — never apply the multiplier twice.
// ─────────────────────────────────────────────────────────────────────────

export const CHAIN_ID = 4663;
export const L1_CHAIN_ID = 1;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export type Address = `0x${string}`;

export interface RegistryToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  /** Chainlink USD feed proxy (8 decimals) — null when Chainlink lists none. */
  feed: Address | null;
  kind: "stock" | "etf" | "money";
}

// ── Money tokens ─────────────────────────────────────────────────────────
// No USDC on Robinhood Chain — USDG (Paxos Global Dollar, 6 decimals!) is
// the quote/loan currency everywhere (Uniswap v4 stock pools, Morpho).
export const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDE: Address = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34";

const MONEY: RegistryToken[] = [
  { symbol: "WETH", name: "Wrapped Ether", address: WETH, decimals: 18, feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", kind: "money" },
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, feed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", kind: "money" },
  { symbol: "USDe", name: "Ethena USDe", address: USDE, decimals: 18, feed: "0xb9fB4e65744E4178894f7C61CF80E8a48A5f224a", kind: "money" },
];

// ── Tokenized stocks (all 18 decimals) ───────────────────────────────────
const STOCKS: Array<[string, string, Address, Address | null]> = [
  ["AAPL", "Apple", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"],
  ["AMD", "Advanced Micro Devices", "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72"],
  ["AMZN", "Amazon", "0x12f190a9F9d7D37a250758b26824B97CE941bF54", "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"],
  ["BABA", "Alibaba", "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984"],
  // Chainlink lists no BE feed yet — priced null until one ships.
  ["BE", "Bloom Energy", "0x822CC93fFD030293E9842c30BBD678F530701867", null],
  ["COIN", "Coinbase", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "0xA3a468A452940B7D6b69991207B508c609a98Ef2"],
  ["CRCL", "Circle", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a"],
  ["CRWV", "CoreWeave", "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", "0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C"],
  ["GOOGL", "Alphabet", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "0xF6f373a037c30F0e5010d854385cA89185AE638b"],
  ["INTC", "Intel", "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", "0x3f390C5C24628Ac7C489515402235FeAD71D1913"],
  ["META", "Meta Platforms", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "0x7C38C00C30BEe9378381E7B6135d7283356D71b1"],
  ["MSFT", "Microsoft", "0xe93237C50D904957Cf27E7B1133b510C669c2e74", "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E"],
  ["MU", "Micron", "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596"],
  ["NVDA", "NVIDIA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"],
  ["ORCL", "Oracle", "0xb0992820E760d836549ba69BC7598b4af75dEE03", "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844"],
  ["PLTR", "Palantir", "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"],
  ["SNDK", "Sandisk", "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", "0xfb133Fa4B7b385802B693a293606682Df47109A3"],
  ["SPCX", "SpaceX (pre-IPO)", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb"],
  ["TSLA", "Tesla", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "0x4A1166a659A55625345e9515b32adECea5547C38"],
  ["USAR", "USA Rare Earth", "0xd917B029C761D264c6A312BBbcDA868658eF86a6", "0xA994d3684e8400A6c8078226925779FdeE682DD9"],
];

// ── Tokenized ETFs (all 18 decimals) ─────────────────────────────────────
const ETFS: Array<[string, string, Address, Address | null]> = [
  ["QQQ", "Invesco QQQ (Nasdaq-100)", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", "0x80901d846d5D7B030F26B480776EE3b29374C2ae"],
  ["SGOV", "iShares 0-3 Month Treasury", "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", "0xa0DF4ee0fFf975306345875E3548Fcc519577A11"],
  ["SLV", "iShares Silver Trust", "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", "0x209b73908e92Ae021826eD79609845451Ecba2ce"],
  ["SPY", "SPDR S&P 500", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "0x319724394D3A0e3669269846abE664Cd621f9f6A"],
  // Robinhood's ticker is CUSO; the Chainlink feed is branded "Robinhood
  // USO / USD" (same underlying US Oil fund) — smoke checks description().
  ["CUSO", "United States Oil Fund", "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c"],
];

export const TOKENS: RegistryToken[] = [
  ...MONEY,
  ...STOCKS.map(([symbol, name, address, feed]) => ({ symbol, name, address, decimals: 18, feed, kind: "stock" as const })),
  ...ETFS.map(([symbol, name, address, feed]) => ({ symbol, name, address, decimals: 18, feed, kind: "etf" as const })),
];

const BY_SYMBOL = new Map(TOKENS.map((t) => [t.symbol.toUpperCase(), t]));
const BY_ADDRESS = new Map(TOKENS.map((t) => [t.address.toLowerCase(), t]));

/** Resolve a symbol ("AAPL", case-insensitive) or 0x address to a registry token. */
export function resolveToken(symbolOrAddress: string): RegistryToken | null {
  const s = symbolOrAddress.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return BY_ADDRESS.get(s.toLowerCase()) ?? null;
  return BY_SYMBOL.get(s.toUpperCase()) ?? null;
}

export function tokenByAddress(address: string): RegistryToken | null {
  return BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

// ── Uniswap v4 (the stock-token venue — stocks trade in v4-ONLY pools
//    quoted against USDG; there is no v3 route for them) ─────────────────
export const V4_QUOTER: Address = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
export const UNIVERSAL_ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// ── Morpho (the lending venue — docs.robinhood.com lists Morpho as the
//    chain's lending protocol; NOT the cross-chain 0xBBBB… singleton) ─────
export const MORPHO: Address = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
export const MORPHO_IRM: Address = "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1";
export const MORPHO_API = "https://blue-api.morpho.org/graphql";

/**
 * Fallback market ids so `lending_position` keeps working when the Morpho
 * API is down: the curated (listed) USDG markets plus the first stock-
 * collateral market, snapshotted 2026-07-14. Params always come from
 * on-chain idToMarketParams — these are just ids to scan.
 */
export const FALLBACK_MARKET_IDS: `0x${string}`[] = [
  "0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6", // USDG / USDe
  "0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7", // USDG / syrupUSDG
  "0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114", // USDG / spUSDG
  "0xf4dff250826a86627545e5c6594b3b249db3ad2ec5eed56c02833d2a67acf445", // USDG / TSLA
];

// ── Canonical Arbitrum bridge (Ethereum ↔ Robinhood Chain) ───────────────
/** L1 Delayed Inbox — `depositEth()` credits the SENDER's address on L2. */
export const L1_INBOX: Address = "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D";
/** ArbSys precompile on L2 — `withdrawEth(destination)` starts an L2→L1 exit. */
export const ARB_SYS: Address = "0x0000000000000000000000000000000000000064";
export const BRIDGE_UI = "https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain";
