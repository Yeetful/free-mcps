import { describe, it, expect } from "vitest";
import { fromAtoms, isResolved, knownSymbols, resolveToken, symbolFor, toAtoms } from "@/lib/tokens";

describe("token symbol resolution", () => {
  it("resolves curated symbols per chain, case-insensitively", () => {
    const usdc = resolveToken("mainnet", "usdc");
    expect(isResolved(usdc) && usdc.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(isResolved(usdc) && usdc.decimals).toBe(6);

    const wxdai = resolveToken("gnosis", "wxDAI");
    expect(isResolved(wxdai) && wxdai.decimals).toBe(18);

    const cow = resolveToken("base", "COW");
    expect(isResolved(cow) && cow.address).toBe("0xc694a91e6b071bF030A18BD3053A7fE09B6DaE69");
  });

  it("the SAME symbol maps to DIFFERENT addresses per chain", () => {
    const m = resolveToken("mainnet", "USDC");
    const b = resolveToken("base", "USDC");
    const g = resolveToken("gnosis", "USDC");
    expect(isResolved(m) && isResolved(b) && isResolved(g)).toBe(true);
    const addrs = [m, b, g].map((t) => (t as { address: string }).address);
    expect(new Set(addrs).size).toBe(3);
  });

  it("BNB-chain stables carry 18 decimals (the classic footgun)", () => {
    const usdc = resolveToken("bnb", "USDC");
    expect(isResolved(usdc) && usdc.decimals).toBe(18);
  });

  it("raw addresses pass through with reverse-symbol display + decimalsHint", () => {
    const t = resolveToken("mainnet", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(isResolved(t) && t.symbol).toBe("USDC");
    expect(isResolved(t) && t.decimals).toBe(6); // known → real decimals

    const unknown = resolveToken("mainnet", "0x" + "1".repeat(40), 9);
    expect(isResolved(unknown) && unknown.decimals).toBe(9);

    const noHint = resolveToken("mainnet", "0x" + "1".repeat(40));
    expect(isResolved(noHint) && noHint.decimals).toBe(-1); // unknown flagged
  });

  it("unknown symbols error with the chain's known list", () => {
    const t = resolveToken("mainnet", "PEPE");
    expect(isResolved(t)).toBe(false);
    expect(!isResolved(t) && t.error).toContain("WETH");
  });

  it("aliases: AVAX→WAVAX, POL/WMATIC→WPOL, BNB→WBNB", () => {
    const avax = resolveToken("avalanche", "AVAX");
    const wavax = resolveToken("avalanche", "WAVAX");
    expect(JSON.stringify({ ...(avax as object), symbol: 0 })).toBe(JSON.stringify({ ...(wavax as object), symbol: 0 }));
    const pol = resolveToken("polygon", "WMATIC");
    expect(isResolved(pol) && pol.address).toBe("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270");
  });

  it("symbolFor reverse-looks-up case-insensitively", () => {
    expect(symbolFor("mainnet", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe("USDC");
    expect(symbolFor("mainnet", "0x" + "9".repeat(40))).toBe("0x" + "9".repeat(40));
  });

  it("every chain has a curated map", () => {
    for (const chain of ["mainnet", "gnosis", "arbitrum", "base", "avalanche", "polygon", "bnb", "sepolia"]) {
      expect(knownSymbols(chain).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("amount math", () => {
  it("round-trips human ↔ atoms with real decimals", () => {
    expect(toAtoms("100", 6)).toBe("100000000");
    expect(toAtoms(0.5, 18)).toBe("500000000000000000");
    expect(toAtoms("0.000001", 6)).toBe("1");
    expect(fromAtoms("57272097068364180", 18)).toBe("0.05727209706836418");
    expect(fromAtoms(100000000n, 6)).toBe("100");
  });

  it("throws on garbage amounts", () => {
    expect(() => toAtoms("abc", 6)).toThrow();
  });
});
