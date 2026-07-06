// Pure unit tests for the read_contract escape-hatch guard — no network.
// Signature parsing, mutability policy, arg coercion, calldata encoding,
// and response truncation.
import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import {
  buildReadCall,
  KNOWN_CONTRACTS,
  MAX_RESPONSE_CHARS,
  parseSignature,
  presentResult,
  resolveContract,
} from "@/lib/read-guard";
import { QUOTER_V2, V3_FACTORY, WETH } from "@/lib/chain";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = "0x1111111111111111111111111111111111111111";

describe("contract resolution", () => {
  it("resolves named contracts to the Base deployments", () => {
    expect(resolveContract("v3_factory")).toBe(V3_FACTORY);
    expect(resolveContract("WETH")).toBe(WETH); // case-insensitive name
    expect(KNOWN_CONTRACTS.quoter_v2).toBe(QUOTER_V2);
  });
  it("checksums raw addresses and refuses junk", () => {
    expect(resolveContract(USDC.toLowerCase())).toBe(USDC);
    expect(() => resolveContract("uniswap")).toThrow(/Unknown contract/);
    expect(() => resolveContract("0x123")).toThrow(/Unknown contract/);
  });
});

describe("signature policy", () => {
  it("parses with or without the `function` prefix", () => {
    const a = parseSignature("function balanceOf(address) view returns (uint256)");
    const b = parseSignature("balanceOf(address) view returns (uint256)");
    expect(a.name).toBe("balanceOf");
    expect(b.name).toBe("balanceOf");
  });
  it("allows nonpayable (quoter simulations run via eth_call)", () => {
    const fn = parseSignature(
      "quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256, uint160, uint32, uint256)",
    );
    expect(fn.stateMutability).toBe("nonpayable");
  });
  it("refuses payable functions and non-functions", () => {
    expect(() => parseSignature("function deposit() payable")).toThrow(/not reads/);
    expect(() => parseSignature("event Transfer(address indexed from, address indexed to, uint256 value)")).toThrow();
    expect(() => parseSignature("not a signature at all(")).toThrow(/Could not parse/);
  });
});

describe("arg coercion + calldata", () => {
  it("encodes balanceOf with a coerced address (roundtrips)", () => {
    const { to, data, fn } = buildReadCall({
      contract: USDC,
      signature: "function balanceOf(address owner) view returns (uint256)",
      args: [WALLET],
    });
    expect(to).toBe(USDC);
    expect(data.startsWith("0x70a08231")).toBe(true); // balanceOf selector
    const decoded = decodeFunctionData({ abi: [fn], data });
    expect((decoded.args as string[])[0].toLowerCase()).toBe(WALLET);
  });
  it("accepts uints as numbers OR decimal strings", () => {
    const sig = "function getPool(address, address, uint24) view returns (address)";
    const a = buildReadCall({ contract: "v3_factory", signature: sig, args: [USDC, WETH, 500] });
    const b = buildReadCall({ contract: "v3_factory", signature: sig, args: [USDC, WETH, "500"] });
    expect(a.data).toBe(b.data);
  });
  it("refuses wrong arg count, bad addresses, and non-integer uints", () => {
    const sig = "function balanceOf(address) view returns (uint256)";
    expect(() => buildReadCall({ contract: USDC, signature: sig, args: [] })).toThrow(/takes 1 argument/);
    expect(() => buildReadCall({ contract: USDC, signature: sig, args: ["$USER_ADDRESS"] })).toThrow(/0x address/);
    expect(() =>
      buildReadCall({ contract: "v3_factory", signature: "function getPool(address, address, uint24) view returns (address)", args: [USDC, WETH, "0.5"] }),
    ).toThrow(/integer/);
  });
  it("coerces tuples from objects (quoter-style params)", () => {
    const { data, fn } = buildReadCall({
      contract: "quoter_v2",
      signature:
        "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
      args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: "100000000", fee: 500, sqrtPriceLimitX96: 0 }],
    });
    const decoded = decodeFunctionData({ abi: [fn], data });
    const p = (decoded.args as [{ amountIn: bigint; fee: number }])[0];
    expect(p.amountIn).toBe(100_000_000n);
    expect(p.fee).toBe(500);
  });
});

describe("result presentation", () => {
  const fn = parseSignature("function symbol() view returns (string)");
  it("stringifies bigints and names single outputs", () => {
    const bal = parseSignature("function balanceOf(address) view returns (uint256)");
    expect(presentResult(bal, 42n)).toEqual({ result: "42" });
  });
  it("names multi-output results", () => {
    const slot0 = parseSignature("function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)");
    expect(presentResult(slot0, [1n, 2, 3, 4])).toEqual({ sqrtPriceX96: "1", tick: 2, protocolFee: 3, lpFee: 4 });
  });
  it("truncates oversized payloads with a legible note", () => {
    const huge = presentResult(fn, "x".repeat(MAX_RESPONSE_CHARS + 1000)) as { truncated: boolean; preview: string };
    expect(huge.truncated).toBe(true);
    expect(huge.preview.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });
});
