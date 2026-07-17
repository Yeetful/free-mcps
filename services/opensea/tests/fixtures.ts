// Trimmed LIVE OpenSea v2 responses (probed 2026-07-17) — the shape truth
// the read/build tests pin against.

export const OWNER = "0x1111111111111111111111111111111111111111";
export const BUYER = "0x2222222222222222222222222222222222222222";
export const STRANGER = "0x3333333333333333333333333333333333333333";
export const PENGUIN_CONTRACT = "0xbd3531da5cf5857e7cfaa92426877b022e612cf8";
export const OS_FEE_WALLET = "0x0000a26b00c1f0df003000390027140000faa719";
export const CREATOR_WALLET = "0x1afa64e9b8e3090f2001f66d9c9a74cde646738a";

export const accountNftsFixture = {
  nfts: [
    {
      identifier: "2489",
      collection: "pudgypenguins",
      contract: PENGUIN_CONTRACT,
      token_standard: "erc721",
      name: "Pudgy Penguin #2489",
      description: "A pudgy penguin.",
      image_url: "https://raw2.seadn.io/ethereum/img/2489.png",
      display_image_url: "https://i2c.seadn.io/ethereum/img/2489-display.png",
      opensea_url: `https://opensea.io/assets/ethereum/${PENGUIN_CONTRACT}/2489`,
      updated_at: "2026-07-17T11:15:20.167370",
      is_disabled: false,
      is_nsfw: false,
    },
    {
      identifier: "77",
      collection: "some-editions",
      contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      token_standard: "erc1155",
      name: "Edition 77",
      image_url: "https://raw2.seadn.io/ethereum/img/77.png",
      display_image_url: null,
      opensea_url: "https://opensea.io/assets/ethereum/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/77",
      updated_at: "2026-07-16T01:00:00",
    },
  ],
  next: "cursor123",
};

export const nftDetailFixture = {
  nft: {
    identifier: "2489",
    collection: "pudgypenguins",
    contract: PENGUIN_CONTRACT,
    token_standard: "erc721",
    name: "Pudgy Penguin #2489",
    description: "A pudgy penguin.",
    image_url: "https://raw2.seadn.io/ethereum/img/2489.png",
    opensea_url: `https://opensea.io/assets/ethereum/${PENGUIN_CONTRACT}/2489`,
    owners: [{ address: OWNER, quantity: 1 }],
    rarity: { strategy_id: "openrarity", rank: 4596 },
    traits: [{ trait_type: "Body", value: "Turtleneck" }],
  },
};

export const collectionFixture = {
  collection: "pudgypenguins",
  name: "Pudgy Penguins",
  description: "Pudgy Penguins is a collection of 8,888 NFTs.",
  image_url: "https://i2c.seadn.io/collection/pudgypenguins/image.png",
  owner: "0xf54c9a0e44a5f5afd27c7ac8a176a843b9114f1d",
  safelist_status: "verified",
  category: "pfps",
  opensea_url: "https://opensea.io/collection/pudgypenguins",
  fees: [
    { fee: 1.0, recipient: OS_FEE_WALLET, required: true },
    { fee: 5.0, recipient: CREATOR_WALLET, required: false },
  ],
  required_zone: null,
  contracts: [{ address: PENGUIN_CONTRACT, chain: "ethereum" }],
  total_supply: 8888,
};

export const statsFixture = {
  total: { volume: 500000, sales: 90000, average_price: 5.5, num_owners: 4500, market_cap: 100000, floor_price: 4.35, floor_price_symbol: "ETH" },
  intervals: [
    { interval: "one_day", volume: 120, sales: 25, average_price: 4.8 },
    { interval: "seven_day", volume: 900, sales: 180, average_price: 5.0 },
  ],
};

export const bestListingsFixture = {
  listings: [
    {
      order_hash: "0x38defbdcd30333fdffdc0a62f690a951c9b239be02bbfdc22b7b4346f06bc1df",
      chain: "ethereum",
      protocol_data: {
        parameters: {
          offerer: "0xf76246b0842c92ad5bd745973ca9eb85b937b126",
          offer: [{ itemType: 2, token: PENGUIN_CONTRACT, identifierOrCriteria: "2489", startAmount: "1", endAmount: "1" }],
          consideration: [
            { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "4356000000000000000", endAmount: "4356000000000000000", recipient: "0xf76246b0842c92ad5bd745973ca9eb85b937b126" },
            { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: "44000000000000000", endAmount: "44000000000000000", recipient: OS_FEE_WALLET },
          ],
          startTime: "1784285565",
          endTime: "1784371965",
          orderType: 0,
          zone: "0x0000000000000000000000000000000000000000",
          zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          salt: "0x3d958fe2000000000000000000000000000000000000000061beaf709e4081f7",
          conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
          counter: "0",
        },
        signature: null,
      },
      protocol_address: "0x0000000000000068f116a894984e2db1123eb395",
      price: { current: { currency: "ETH", decimals: 18, value: "4400000000000000000" } },
    },
  ],
};

/** LIVE-probed fulfillment_data shape for a basic ETH listing. */
export const fulfillmentFixture = {
  protocol: "seaport1.6",
  fulfillment_data: {
    transaction: {
      function:
        "fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))",
      chain: 1,
      to: "0x0000000000000068f116a894984e2db1123eb395",
      value: 4400000000000000000,
      input_data: {
        parameters: {
          considerationToken: "0x0000000000000000000000000000000000000000",
          considerationIdentifier: "0",
          considerationAmount: "4356000000000000000",
          offerer: "0xf76246b0842c92ad5bd745973ca9eb85b937b126",
          zone: "0x0000000000000000000000000000000000000000",
          offerToken: PENGUIN_CONTRACT,
          offerIdentifier: "2489",
          offerAmount: "1",
          basicOrderType: 0,
          startTime: "1784285565",
          endTime: "1784371965",
          zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          salt: "27855337018906766782546881864045825683096516384821792734240933993523550650871",
          offererConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
          fulfillerConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
          totalOriginalAdditionalRecipients: "1",
          additionalRecipients: [{ amount: "44000000000000000", recipient: OS_FEE_WALLET }],
          signature: "0x30af7a94c024d5aac7d58bc01ba8dc66f28609cd8d8909",
        },
      },
    },
  },
};
