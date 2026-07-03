// Pure unit tests — no network. Calldata building, amount math, token
// sorting, v4 poolId derivation, and the swap builder's parameter validation.
import { describe, it, expect } from "vitest";
import { decodeFunctionData, zeroAddress } from "viem";
import { humanToAtoms, formatAtoms, sortTokens } from "@/lib/tokens";
import { v4PoolId } from "@/lib/quote";
import { buildWrap, buildUnwrap } from "@/lib/swap";
import { SWAP_ROUTER_02_ABI, WETH, TICK_SPACING, FEE_TIERS } from "@/lib/chain";

describe("amount math", () => {
  it("converts human → atoms with real decimals", () => {
    expect(humanToAtoms("100", 6)).toBe(100_000_000n);
    expect(humanToAtoms("0.5", 18)).toBe(500_000_000_000_000_000n);
    expect(humanToAtoms("0.000001", 6)).toBe(1n);
  });
  it("refuses excess precision, zero, and junk (never rounds money)", () => {
    expect(() => humanToAtoms("0.1234567", 6)).toThrow(/decimal places/);
    expect(() => humanToAtoms("0", 6)).toThrow(/greater than zero/);
    expect(() => humanToAtoms("1e5", 6)).toThrow(/plain decimal/);
    expect(() => humanToAtoms("-1", 6)).toThrow(/plain decimal/);
  });
  it("formats atoms back to trimmed human units", () => {
    expect(formatAtoms(100_000_000n, 6)).toBe("100");
    expect(formatAtoms(61_778_639_604_642_950n, 18)).toBe("0.06177863");
    expect(formatAtoms(1n, 18)).toBe("<0.00000001");
  });
});

describe("pool identity", () => {
  it("sorts tokens the way pools do", () => {
    const [a, b] = sortTokens(WETH, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(a.toLowerCase() < b.toLowerCase()).toBe(true);
  });
  it("derives a stable v4 poolId for a hookless key", () => {
    const id = v4PoolId(zeroAddress, WETH, 3000, TICK_SPACING[3000]);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    // Deterministic: same key → same id; different fee → different id.
    expect(v4PoolId(zeroAddress, WETH, 3000, 60)).toBe(id);
    expect(v4PoolId(zeroAddress, WETH, 500, 10)).not.toBe(id);
  });
  it("covers every fee tier with a tick spacing", () => {
    for (const fee of FEE_TIERS) expect(TICK_SPACING[fee]).toBeGreaterThan(0);
  });
});

describe("wrap/unwrap builders", () => {
  const from = "0x1111111111111111111111111111111111111111";
  it("wrap carries value and targets WETH deposit", () => {
    const w = buildWrap("0.25", from);
    expect(w.action).toBe("send_transaction");
    expect(w.tx.to).toBe(WETH);
    expect(w.tx.value).toBe(250_000_000_000_000_000n.toString());
    expect(w.tx.chainId).toBe(8453);
    expect(w.summary).toContain("0.25 ETH");
  });
  it("unwrap encodes withdraw(amount) with zero value", () => {
    const u = buildUnwrap("1", from);
    expect(u.tx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: [{ name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] }] as const,
      data: u.tx.data,
    });
    expect(decoded.functionName).toBe("withdraw");
    expect(decoded.args?.[0]).toBe(1_000_000_000_000_000_000n);
  });
  it("refuses a junk from address", () => {
    expect(() => buildWrap("1", "0xnope")).toThrow(/wallet address/);
  });
});

describe("router calldata shape", () => {
  it("multicall(deadline, [exactInputSingle]) decodes back to the same params", async () => {
    const { encodeFunctionData } = await import("viem");
    const inner = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          tokenOut: WETH,
          fee: 500,
          recipient: "0x1111111111111111111111111111111111111111",
          amountIn: 100_000_000n,
          amountOutMinimum: 61_000_000_000_000_000n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const outer = encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: "multicall", args: [1893456000n, [inner]] });
    const decodedOuter = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: outer });
    expect(decodedOuter.functionName).toBe("multicall");
    const [deadline, calls] = decodedOuter.args as [bigint, `0x${string}`[]];
    expect(deadline).toBe(1893456000n);
    const decodedInner = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: calls[0] });
    expect(decodedInner.functionName).toBe("exactInputSingle");
    const p = (decodedInner.args as unknown as [{ recipient: string; amountOutMinimum: bigint; fee: number }])[0];
    expect(p.recipient.toLowerCase()).toBe("0x1111111111111111111111111111111111111111");
    expect(p.amountOutMinimum).toBe(61_000_000_000_000_000n);
    expect(p.fee).toBe(500);
  });
});
