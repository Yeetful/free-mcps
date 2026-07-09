// Default env for tests. The free service needs no payment config and no API
// key — the AaveKit GraphQL API is unauthenticated. AAVE_API_URL overrides
// the production endpoint (unit tests never hit the network; they inject
// fetchImpl).
