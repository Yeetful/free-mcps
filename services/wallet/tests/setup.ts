// Default env for tests. Unit tests never hit the network — they inject
// fetchImpl — so point both Alchemy seams somewhere unroutable to make any
// accidental live call fail loudly.
process.env.ALCHEMY_API_KEY = "test-key";
process.env.ALCHEMY_DATA_URL = "https://alchemy-data.invalid";
process.env.ALCHEMY_RPC_URL_TEMPLATE = "https://{net}.alchemy-rpc.invalid";
