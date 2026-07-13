// Default env for tests. The free service needs no payment config and no API
// key — Lido's public APIs and public-RPC reads are unauthenticated. Unit
// tests never hit the network: HTTP clients inject fetchImpl and the chain
// module exposes setRpcForTests().
