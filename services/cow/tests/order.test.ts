// EIP-712 construction — the heart of the service. The fixtures pin the
// EXACT domain/types/message a wallet will be asked to sign; any drift here
// is a signature-verification failure at the order book.
import { describe, it, expect } from "vitest";
import { CHAINS, VAULT_RELAYER, SETTLEMENT_CONTRACT, type QuoteSide } from "@/lib/cow";
import {
  DEFAULT_APP_DATA,
  ORDER_TYPE,
  appDataHash,
  cancellationTypedData,
  limitOrder,
  minusBps,
  normalizeAppData,
  orderFromQuote,
  plusBps,
} from "@/lib/order";

const USER = "0xd8dA6BF26964aF9D7eEd9e03E45359a2c7bA4c30";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

// A fixed fake quote, shaped exactly like the live POST /quote response
// (probed 2026-07-06): 100 USDC → WETH, fee 209822 atoms of USDC.
const FAKE_QUOTE: QuoteSide = {
  sellToken: USDC,
  buyToken: WETH,
  receiver: null,
  sellAmount: "99790178",
  buyAmount: "57272097068364180",
  validTo: 1783344520,
  appData: DEFAULT_APP_DATA,
  feeAmount: "209822",
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
  signingScheme: "eip712",
};

describe("appData hashing", () => {
  it('hashes "{}" to the openapi-documented constant', () => {
    expect(appDataHash("{}")).toBe("0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d");
  });

  it("hashes the default appData to the hash the live /quote echoed (2026-07-06)", () => {
    expect(appDataHash(DEFAULT_APP_DATA)).toBe("0xa872cd1c41362821123e195e2dc6a3f19502a451e1fb2a1f861131526e98fdc7");
  });

  it("normalizeAppData rejects non-JSON, non-objects, and oversized payloads", () => {
    expect(normalizeAppData("not json")).toHaveProperty("error");
    expect(normalizeAppData("[1,2]")).toHaveProperty("error");
    expect(normalizeAppData(`{"pad":"${"x".repeat(1000)}"}`)).toHaveProperty("error");
    const okay = normalizeAppData(undefined);
    expect(okay).toMatchObject({ fullAppData: DEFAULT_APP_DATA });
  });
});

describe("orderFromQuote → EIP-712 typed data (exact)", () => {
  const app = normalizeAppData(undefined) as { fullAppData: string; hash: string };
  const built = orderFromQuote(CHAINS.mainnet!, FAKE_QUOTE, 1234054687, {
    from: USER,
    slippageBps: 50,
    fullAppData: app.fullAppData,
    appDataHash: app.hash,
  });

  it("folds the fee into sellAmount and signs feeAmount 0", () => {
    // 99790178 + 209822 = 100000000 (the full 100 USDC)
    expect(built.order.sellAmount).toBe("100000000");
    expect(built.order.feeAmount).toBe("0");
  });

  it("applies slippage to the buy side of a sell order (floor, bigint)", () => {
    // 57272097068364180 * 9950 / 10000
    expect(built.order.buyAmount).toBe(((57272097068364180n * 9950n) / 10000n).toString());
  });

  it("produces the EXACT domain — Gnosis Protocol v2 @ the shared settlement contract", () => {
    expect(built.typedData.domain).toEqual({
      name: "Gnosis Protocol",
      version: "v2",
      chainId: 1,
      verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    });
  });

  it("produces the EXACT Order type fields in canonical order", () => {
    expect(built.typedData.types.Order).toEqual([
      { name: "sellToken", type: "address" },
      { name: "buyToken", type: "address" },
      { name: "receiver", type: "address" },
      { name: "sellAmount", type: "uint256" },
      { name: "buyAmount", type: "uint256" },
      { name: "validTo", type: "uint32" },
      { name: "appData", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "kind", type: "string" },
      { name: "partiallyFillable", type: "bool" },
      { name: "sellTokenBalance", type: "string" },
      { name: "buyTokenBalance", type: "string" },
    ]);
    expect(built.typedData.primaryType).toBe("Order");
    // eth_signTypedData_v4 clients need the domain type spelled out too.
    expect(built.typedData.types.EIP712Domain).toBeDefined();
  });

  it("keeps kind/balance flags as PLAIN STRINGS (the wallet hashes string members)", () => {
    expect(built.typedData.message).toEqual({
      sellToken: USDC,
      buyToken: WETH,
      receiver: USER, // null receiver in quote → defaults to from
      sellAmount: "100000000",
      buyAmount: ((57272097068364180n * 9950n) / 10000n).toString(),
      validTo: 1783344520,
      appData: "0xa872cd1c41362821123e195e2dc6a3f19502a451e1fb2a1f861131526e98fdc7",
      feeAmount: "0",
      kind: "sell",
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
    });
  });

  it("emits the vault-relayer approval hint sized to the signed sellAmount", () => {
    expect(built.approval).toEqual({
      token: USDC,
      spender: VAULT_RELAYER,
      neededAllowance: "100000000",
    });
    expect(VAULT_RELAYER).toBe("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110");
    expect(SETTLEMENT_CONTRACT).toBe("0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
  });

  it("carries the quoteId through", () => {
    expect(built.quoteId).toBe(1234054687);
  });

  it("buy orders: fee folds into sell side, slippage ADDS to sellAmount", () => {
    const buyQuote: QuoteSide = { ...FAKE_QUOTE, kind: "buy" };
    const b = orderFromQuote(CHAINS.base!, buyQuote, null, {
      from: USER,
      slippageBps: 100,
      fullAppData: app.fullAppData,
      appDataHash: app.hash,
    });
    // (99790178 + 209822) * 10100 / 10000 = 101000000
    expect(b.order.sellAmount).toBe("101000000");
    expect(b.order.buyAmount).toBe("57272097068364180"); // buy side fixed
    expect(b.typedData.domain.chainId).toBe(8453);
  });
});

describe("limitOrder", () => {
  it("signs the user's exact price with feeAmount 0", () => {
    const app = normalizeAppData(undefined) as { fullAppData: string; hash: string };
    const b = limitOrder(CHAINS.gnosis!, {
      sellToken: WETH,
      buyToken: USDC,
      sellAmountAtoms: "1000000000000000000",
      buyAmountAtoms: "4000000000",
      from: USER,
      validTo: 1800000000,
      partiallyFillable: true,
      fullAppData: app.fullAppData,
      appDataHash: app.hash,
    });
    expect(b.order).toMatchObject({
      sellAmount: "1000000000000000000",
      buyAmount: "4000000000",
      feeAmount: "0",
      kind: "sell",
      partiallyFillable: true,
      validTo: 1800000000,
    });
    expect(b.typedData.domain.chainId).toBe(100);
    expect(b.approval.neededAllowance).toBe("1000000000000000000");
  });
});

describe("cancellationTypedData", () => {
  it("builds the OrderCancellations struct over bytes[] orderUids", () => {
    const uid = "0x" + "ab".repeat(56);
    const td = cancellationTypedData(CHAINS.mainnet!, [uid]);
    expect(td.primaryType).toBe("OrderCancellations");
    expect(td.types.OrderCancellations).toEqual([{ name: "orderUids", type: "bytes[]" }]);
    expect(td.message).toEqual({ orderUids: [uid] });
    expect(td.domain.name).toBe("Gnosis Protocol");
  });
});

describe("bps math", () => {
  it("is exact bigint arithmetic", () => {
    expect(minusBps(10000n, 50)).toBe(9950n);
    expect(plusBps(10000n, 50)).toBe(10050n);
    expect(minusBps(3n, 50)).toBe(2n); // floors
    expect(ORDER_TYPE.length).toBe(12);
  });
});
