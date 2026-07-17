import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { ERC1155_ABI, ERC721_ABI, SEAPORT_ABI, setRpcForTests } from "@/lib/chain";
import { setFetchForTests } from "@/lib/opensea-api";
import { SEAPORT_1_6 } from "@/lib/registry";
import { buildBuyNft, buildCancelListing, buildListing, buildTransferNft, submitListing, type SendTransactionAction, type SignTypedDataAction } from "@/lib/tx";
import { fetchRouter, rpcFake } from "./fakes";
import {
  BUYER,
  OWNER,
  PENGUIN_CONTRACT,
  STRANGER,
  bestListingsFixture,
  collectionFixture,
  fulfillmentFixture,
  nftDetailFixture,
} from "./fixtures";

const HASH = "0x38defbdcd30333fdffdc0a62f690a951c9b239be02bbfdc22b7b4346f06bc1df";

const nft1155Fixture = {
  nft: { ...nftDetailFixture.nft, token_standard: "erc1155", name: "Edition 77", identifier: "77" },
};

afterEach(() => {
  setFetchForTests(null);
  setRpcForTests("ethereum", null);
});

describe("build_transfer_nft", () => {
  it("builds an ERC-721 safeTransferFrom for the verified owner", async () => {
    setFetchForTests(fetchRouter([["/nfts/2489", nftDetailFixture]]));
    setRpcForTests("ethereum", rpcFake({ owners: { "2489": OWNER } }));
    const r = await buildTransferNft("ethereum", PENGUIN_CONTRACT, "2489", OWNER, BUYER, "1");
    expect(r.ok).toBe(true);
    const d = r.data as { steps: SendTransactionAction[] };
    expect(d.steps).toHaveLength(1);
    const { functionName, args } = decodeFunctionData({ abi: ERC721_ABI, data: d.steps[0].tx.data as `0x${string}` });
    expect(functionName).toBe("safeTransferFrom");
    expect(args).toEqual([OWNER, BUYER, 2489n]);
    expect(d.steps[0].tx.chainId).toBe(1);
    expect(d.steps[0].tx.value).toBe("0");
  });

  it("refuses when the sender does not own the NFT", async () => {
    setFetchForTests(fetchRouter([["/nfts/2489", nftDetailFixture]]));
    setRpcForTests("ethereum", rpcFake({ owners: { "2489": STRANGER } }));
    const r = await buildTransferNft("ethereum", PENGUIN_CONTRACT, "2489", OWNER, BUYER, "1");
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("owned by");
    expect(String(r.data)).toContain("Nothing was built");
  });

  it("refuses zero-address and self transfers and >1 amounts on ERC-721", async () => {
    setFetchForTests(fetchRouter([["/nfts/2489", nftDetailFixture]]));
    setRpcForTests("ethereum", rpcFake({ owners: { "2489": OWNER } }));
    expect((await buildTransferNft("ethereum", PENGUIN_CONTRACT, "2489", OWNER, "0x0000000000000000000000000000000000000000", "1")).ok).toBe(false);
    expect((await buildTransferNft("ethereum", PENGUIN_CONTRACT, "2489", OWNER, OWNER, "1")).ok).toBe(false);
    expect((await buildTransferNft("ethereum", PENGUIN_CONTRACT, "2489", OWNER, BUYER, "2")).ok).toBe(false);
  });

  it("builds ERC-1155 transfers against the live balance (and refuses shortfalls)", async () => {
    setFetchForTests(fetchRouter([["/nfts/77", nft1155Fixture]]));
    setRpcForTests("ethereum", rpcFake({ balances1155: { [`${OWNER.toLowerCase()}:77`]: 5n } }));
    const r = await buildTransferNft("ethereum", PENGUIN_CONTRACT, "77", OWNER, BUYER, "3");
    expect(r.ok).toBe(true);
    const d = r.data as { steps: SendTransactionAction[] };
    const { functionName, args } = decodeFunctionData({ abi: ERC1155_ABI, data: d.steps[0].tx.data as `0x${string}` });
    expect(functionName).toBe("safeTransferFrom");
    expect(args).toEqual([OWNER, BUYER, 77n, 3n, "0x"]);

    setRpcForTests("ethereum", rpcFake({ balances1155: { [`${OWNER.toLowerCase()}:77`]: 2n } }));
    const short = await buildTransferNft("ethereum", PENGUIN_CONTRACT, "77", OWNER, BUYER, "3");
    expect(short.ok).toBe(false);
    expect(String(short.data)).toContain("fewer than");
  });
});

describe("build_listing", () => {
  const routes: [string, unknown][] = [
    ["/nfts/2489", nftDetailFixture],
    ["/collections/pudgypenguins", collectionFixture],
  ];

  it("verifies ownership, includes a conduit approval when missing, and prices the order from the fee schedule", async () => {
    setFetchForTests(fetchRouter(routes));
    setRpcForTests("ethereum", rpcFake({ owners: { "2489": OWNER }, counter: 7n }));
    const r = await buildListing("ethereum", PENGUIN_CONTRACT, "2489", OWNER, "1", 168, "1", false);
    expect(r.ok).toBe(true);
    const d = r.data as { steps: SendTransactionAction[]; sign: SignTypedDataAction; seller_proceeds_eth: string };
    expect(d.steps).toHaveLength(1); // approval needed
    expect(d.steps[0].label).toContain("Approve");
    expect(d.seller_proceeds_eth).toBe("0.99"); // 1% required fee only
    const msg = d.sign.typedData.message;
    expect(d.sign.typedData.domain.verifyingContract).toBe(SEAPORT_1_6);
    expect(msg.counter).toBe("7");
    const total = msg.consideration.reduce((s, c) => s + BigInt(c.startAmount), 0n);
    expect(total).toBe(10n ** 18n);
  });

  it("skips the approval step when the conduit is already approved", async () => {
    setFetchForTests(fetchRouter(routes));
    setRpcForTests(
      "ethereum",
      rpcFake({ owners: { "2489": OWNER }, approvals: { [`${OWNER.toLowerCase()}:0x1e0049783f008a0085193e00003d00cd54003c71`]: true } }),
    );
    const r = await buildListing("ethereum", PENGUIN_CONTRACT, "2489", OWNER, "1", 168, "1", false);
    expect(r.ok).toBe(true);
    expect((r.data as { steps: unknown[] }).steps).toHaveLength(0);
  });

  it("refuses to list an NFT the offerer does not own", async () => {
    setFetchForTests(fetchRouter(routes));
    setRpcForTests("ethereum", rpcFake({ owners: { "2489": STRANGER } }));
    const r = await buildListing("ethereum", PENGUIN_CONTRACT, "2489", OWNER, "1", 168, "1", false);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("Nothing was built");
  });
});

describe("submit_listing", () => {
  const goodParams = () => {
    const base = bestListingsFixture.listings[0].protocol_data.parameters;
    return JSON.parse(JSON.stringify(base)) as typeof base & Record<string, unknown>;
  };
  const SIG = `0x${"ab".repeat(65)}`;
  const routes: [string, unknown][] = [
    ["/nfts/2489", nftDetailFixture],
    ["/collections/pudgypenguins", collectionFixture],
    ["/orders/ethereum/seaport/listings", { order: { order_hash: HASH } }],
  ];

  it("relays a clean order and returns the OpenSea link", async () => {
    setFetchForTests(fetchRouter(routes));
    const r = await submitListing("ethereum", goodParams() as never, SIG);
    expect(r.ok).toBe(true);
    expect((r.data as { order_hash: string }).order_hash).toBe(HASH);
  });

  it("refuses a consideration recipient outside offerer + published fee wallets", async () => {
    setFetchForTests(fetchRouter(routes));
    const tampered = goodParams();
    (tampered.consideration as { recipient: string }[])[1].recipient = STRANGER;
    const r = await submitListing("ethereum", tampered as never, SIG);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("refusing to relay");
  });

  it("refuses a foreign conduit key", async () => {
    setFetchForTests(fetchRouter(routes));
    const tampered = goodParams();
    tampered.conduitKey = `0x${"00".repeat(32)}`;
    const r = await submitListing("ethereum", tampered as never, SIG);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("conduit");
  });
});

describe("build_cancel_listing", () => {
  const orderRoute: [string, unknown] = [`/orders/chain/ethereum/protocol/`, { order: bestListingsFixture.listings[0] }];

  it("encodes a Seaport cancel for the offerer's own order", async () => {
    setFetchForTests(fetchRouter([orderRoute]));
    const offerer = bestListingsFixture.listings[0].protocol_data.parameters.offerer;
    const r = await buildCancelListing("ethereum", HASH, offerer);
    expect(r.ok).toBe(true);
    const d = r.data as { steps: SendTransactionAction[] };
    expect(d.steps[0].tx.to).toBe(SEAPORT_1_6);
    const { functionName, args } = decodeFunctionData({ abi: SEAPORT_ABI, data: d.steps[0].tx.data as `0x${string}` });
    expect(functionName).toBe("cancel");
    const orders = args[0] as unknown as { offerer: string; counter: bigint }[];
    expect(orders[0].offerer.toLowerCase()).toBe(offerer.toLowerCase());
    expect(orders[0].counter).toBe(0n);
  });

  it("refuses a cancel by anyone but the offerer", async () => {
    setFetchForTests(fetchRouter([orderRoute]));
    const r = await buildCancelListing("ethereum", HASH, STRANGER);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("only its offerer");
  });
});

describe("build_buy_nft", () => {
  it("pins the target to Seaport, checks the buyer balance, and re-encodes calldata locally", async () => {
    setFetchForTests(fetchRouter([["/listings/fulfillment_data", fulfillmentFixture]]));
    setRpcForTests("ethereum", rpcFake({ ethBalance: 10n * 10n ** 18n }));
    const r = await buildBuyNft("ethereum", HASH, BUYER);
    expect(r.ok).toBe(true);
    const d = r.data as { steps: SendTransactionAction[]; price_eth: string };
    expect(d.price_eth).toBe("4.4");
    expect(d.steps[0].tx.to).toBe(SEAPORT_1_6);
    expect(d.steps[0].tx.value).toBe("4400000000000000000");
    expect(d.steps[0].tx.data.startsWith("0x")).toBe(true);
    expect(d.steps[0].tx.data.length).toBeGreaterThan(600); // real encoded basic order
  });

  it("refuses when the buyer cannot cover the price", async () => {
    setFetchForTests(fetchRouter([["/listings/fulfillment_data", fulfillmentFixture]]));
    setRpcForTests("ethereum", rpcFake({ ethBalance: 10n ** 18n }));
    const r = await buildBuyNft("ethereum", HASH, BUYER);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("holds");
  });

  it("enforces the max-price cap and the Seaport target pin", async () => {
    setFetchForTests(fetchRouter([["/listings/fulfillment_data", fulfillmentFixture]]));
    setRpcForTests("ethereum", rpcFake({ ethBalance: 10n * 10n ** 18n }));
    const capped = await buildBuyNft("ethereum", HASH, BUYER, "4.0");
    expect(capped.ok).toBe(false);
    expect(String(capped.data)).toContain("cap");

    const evil = JSON.parse(JSON.stringify(fulfillmentFixture));
    evil.fulfillment_data.transaction.to = STRANGER;
    setFetchForTests(fetchRouter([["/listings/fulfillment_data", evil]]));
    const r = await buildBuyNft("ethereum", HASH, BUYER);
    expect(r.ok).toBe(false);
    expect(String(r.data)).toContain("pinned Seaport");
  });
});
