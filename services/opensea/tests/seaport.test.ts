import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbiItem, type AbiFunction } from "viem";
import { buildListingComponents, fulfillmentToCalldata, splitPrice, ITEM_TYPE, ORDER_TYPE } from "@/lib/seaport";
import { OPENSEA_CONDUIT_KEY } from "@/lib/registry";
import { fulfillmentFixture, CREATOR_WALLET, OS_FEE_WALLET, OWNER, PENGUIN_CONTRACT } from "./fixtures";

const ONE_ETH = 10n ** 18n;
const FEES = [
  { fee: 1.0, recipient: OS_FEE_WALLET, required: true },
  { fee: 5.0, recipient: CREATOR_WALLET, required: false },
];

describe("splitPrice", () => {
  it("applies required fees only by default; splits always sum to the price", () => {
    const { sellerWei, splits } = splitPrice(ONE_ETH, FEES, false);
    expect(splits).toHaveLength(1);
    expect(splits[0].amountWei).toBe(ONE_ETH / 100n); // 1%
    expect(sellerWei + splits[0].amountWei).toBe(ONE_ETH);
  });

  it("adds optional creator fees when asked", () => {
    const { sellerWei, splits } = splitPrice(ONE_ETH, FEES, true);
    expect(splits).toHaveLength(2);
    expect(sellerWei).toBe((ONE_ETH * 94n) / 100n);
  });
});

describe("buildListingComponents", () => {
  const base = {
    offerer: OWNER as `0x${string}`,
    token: PENGUIN_CONTRACT as `0x${string}`,
    identifier: "2489",
    standard: "erc721" as const,
    amount: "1",
    priceWei: ONE_ETH,
    fees: FEES,
    includeOptionalFees: false,
    requiredZone: null,
    counter: "7",
    startTime: 1_784_000_000,
    endTime: 1_784_600_000,
  };

  it("assembles an open native-ETH order whose consideration sums to the price", () => {
    const c = buildListingComponents(base);
    expect(c.offer[0].itemType).toBe(ITEM_TYPE.ERC721);
    expect(c.orderType).toBe(ORDER_TYPE.FULL_OPEN);
    expect(c.conduitKey).toBe(OPENSEA_CONDUIT_KEY);
    expect(c.counter).toBe("7");
    const total = c.consideration.reduce((s, x) => s + BigInt(x.startAmount), 0n);
    expect(total).toBe(ONE_ETH);
    expect(c.consideration[0].recipient).toBe(OWNER); // seller first
  });

  it("restricts the order when the collection requires a zone", () => {
    const c = buildListingComponents({ ...base, requiredZone: "0x000056f7000000ece9003ca63978907a00ffd100" });
    expect(c.orderType).toBe(ORDER_TYPE.FULL_RESTRICTED);
    expect(c.zone).toBe("0x000056f7000000ece9003ca63978907a00ffd100");
  });

  it("emits ERC-1155 offers with the requested unit count", () => {
    const c = buildListingComponents({ ...base, standard: "erc1155", amount: "3" });
    expect(c.offer[0].itemType).toBe(ITEM_TYPE.ERC1155);
    expect(c.offer[0].startAmount).toBe("3");
  });

  it("refuses when fees consume the whole price", () => {
    const confiscatory = [{ fee: 100.0, recipient: OS_FEE_WALLET, required: true }];
    expect(() => buildListingComponents({ ...base, fees: confiscatory })).toThrow(/entire price/);
  });
});

describe("fulfillmentToCalldata", () => {
  it("re-encodes OpenSea's named input_data into calldata that decodes back exactly", () => {
    const tx = fulfillmentFixture.fulfillment_data.transaction;
    const data = fulfillmentToCalldata(tx.function, tx.input_data);
    const abiFn = parseAbiItem(`function ${tx.function}`) as AbiFunction;
    const { functionName, args } = decodeFunctionData({ abi: [abiFn], data });
    expect(functionName).toBe("fulfillBasicOrder_efficient_6GL6yc");
    const p = (args as unknown[])[0] as unknown[];
    // Positional spot-checks against the fixture (unnamed tuples decode as arrays):
    expect((p[2] as bigint).toString()).toBe("4356000000000000000"); // considerationAmount
    expect(String(p[5]).toLowerCase()).toBe(PENGUIN_CONTRACT); // offerToken
    expect((p[6] as bigint).toString()).toBe("2489"); // offerIdentifier
    const recipients = p[16] as [bigint, string][];
    expect(recipients).toHaveLength(1);
    expect(recipients[0][0].toString()).toBe("44000000000000000");
  });

  it("throws on arity mismatch instead of encoding garbage", () => {
    const tx = fulfillmentFixture.fulfillment_data.transaction;
    expect(() => fulfillmentToCalldata(tx.function, { a: 1, b: 2 })).toThrow(/arity/);
  });
});
