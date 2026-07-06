# free-mcps — Yeetful's free MCP services

Free, **non-gated** MCP servers by [yeetful.com](https://yeetful.com). One
monorepo, many thin services, each deployed to its own subdomain over MCP
Streamable HTTP (`/mcp`) + SSE (`/sse`). No API keys, no payment gate — just
rate limiting.

These are the free siblings of
[x402-services](https://github.com/Yeetful/x402-services) (the x402-paid
fleet). Same architecture, same trust model, minus the 402:

- **Build, don't execute.** Services return quotes, data, and *buildable*
  transactions/typed-data the USER signs with their own wallet. No service
  ever holds a private key or submits value transfers on its own.
- **Clean paths.** `<service>.yeetful.com/mcp` — no `/api/mcp/mcp` doubling.
- **Discovery.** Every service serves free metadata at `/api/info`
  (`gated: false`).

## Services

| Service | What it does | Tools |
|---|---|---|
| `services/uniswap` | Uniswap v3 + v4 on Base, read directly over RPC: live quotes (QuoterV2, every fee tier), spot prices, pool state, deterministic swap-tx building (SwapRouter02 calldata + approve step + dry-run) | `quote`, `price`, `pool_info`, `build_swap`, `build_wrap`, `build_unwrap`, `convert_amount`, `read_contract` |
| `services/snapshot` | Snapshot DAO governance: browse spaces/proposals/votes, build the EIP-712 vote the user signs, relay the signed envelope to the sequencer | `list_proposals`, `get_proposal`, `list_votes`, `get_space`, `list_spaces`, `graphql_query`, `prepare_vote`, `submit_vote` |
| `services/hyperliquid` | Hyperliquid over the public API (read-only): perp + spot markets, orderbooks, candles, funding, per-address portfolio views (positions/balances/orders/fills/PnL), and real-time settlement watching over WebSocket | `markets`, `spot_markets`, `price`, `orderbook`, `candles`, `funding`, `portfolio`, `open_orders`, `fills`, `order_status`, `ledger`, `await_settlement`, `info_query` |

## Develop

```bash
pnpm install
pnpm typecheck && pnpm test        # all services
cd services/uniswap && pnpm dev    # one service on :3000
```

Env (all optional): `BASE_RPC_URL` (uniswap; defaults to viem's public Base
RPC), `SNAPSHOT_HUB_URL` / `SNAPSHOT_SEQUENCER_URL` (snapshot; default to the
public hub/sequencer), `HYPERLIQUID_API_URL` / `HYPERLIQUID_WS_URL`
(hyperliquid; default to mainnet, point at *.hyperliquid-testnet.xyz for
testnet), `RATE_LIMIT_PER_MINUTE` (default 60/IP).

## Shared kit

`packages/mcp-kit` (`@yeetful/mcp-kit`): `createCleanMcpHandler` (MCP route on
a clean path) + `createRateLimitProxy` (per-IP sliding-window limit — free
services have no 402 to throttle abuse, so this is the front door).
