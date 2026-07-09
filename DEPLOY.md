# Deploying the free MCPs (Vercel)

Each service deploys as its own Vercel project, same pattern as x402-services.
The website directory rows are already seeded on Neon pointing at these hosts:

| Service | Vercel root directory | Domain (seeded in DB) |
|---|---|---|
| uniswap | `services/uniswap` | `uniswap-mcp.yeetful.com` |
| snapshot | `services/snapshot` | `snapshot-mcp.yeetful.com` |
| hyperliquid | `services/hyperliquid` | `hyperliquid-mcp.yeetful.com` (not yet deployed/seeded) |
| cow | `services/cow` | `cow-mcp.yeetful.com` (not yet deployed/seeded) |
| aave | `services/aave` | `aave-mcp.yeetful.com` (not yet deployed/seeded) |

## Steps (per service, ~3 min)

1. Vercel → Add New Project → import `Yeetful/free-mcps`.
2. **Root Directory**: `services/uniswap` (or `services/snapshot`). Framework:
   Next.js (auto). Build command / install: defaults (Vercel detects pnpm
   workspaces from the repo root).
3. Env vars — all optional:
   - `BASE_RPC_URL` (uniswap only, **recommended for prod** — the public Base
     RPC rate-limits; use an Alchemy/QuickNode URL)
   - `RATE_LIMIT_PER_MINUTE` (default 60/IP)
4. Deploy, then add the custom domain above (Settings → Domains; DNS CNAME →
   `cname.vercel-dns.com`).
5. Smoke: `curl https://uniswap-mcp.yeetful.com/api/info` → `"gated": false`,
   then a live tools/list:
   ```bash
   curl -s -X POST https://uniswap-mcp.yeetful.com/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
   ```

## Local dev against localhost

Both services are DEPLOYED and live (2026-07-03) — prod chat calls them
directly. To develop against local copies instead, in `website/.env.local`:

```
FREE_MCP_URL_OVERRIDES={"uniswap-mcp.yeetful.com":"http://localhost:3261","snapshot-mcp.yeetful.com":"http://localhost:3262","cow-mcp.yeetful.com":"http://localhost:3263","aave-mcp.yeetful.com":"http://localhost:3266"}
```

and run the services locally (`next start -p 3261` in services/uniswap,
`-p 3262` in services/snapshot, `-p 3263` in services/cow, `-p 3266` in
services/aave), or run the
standing proof: `npx tsx scripts/test-free-mcps-live.ts` (in website/, env as
above).

Note (cow): the searchable docs corpus (`services/cow/lib/docs-data.json`) is
COMMITTED — regenerate with `pnpm build-docs` in services/cow (downloads
github.com/cowprotocol/docs) and commit the result; the deploy needs no
network/build step for it.
