// Unit tests never hit the network: the per-chain RPC clients are replaced
// via setRpcForTests and the OpenSea API via setFetchForTests. The key just
// has to EXIST so the api layer doesn't refuse before reaching the fake.
process.env.OPENSEA_API_KEY = "test-key";
