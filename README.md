# eve-sde-mcp

MCP server providing access to Eve Online's Static Data Export (SDE) and live character data via the ESI API — ship stats, module attributes, universe data, industry blueprints, character skills, and more.

Static data is powered by the [Fuzzwork](https://www.fuzzwork.co.uk/dump/) SQLite conversion of CCP's SDE. Live data uses EVE SSO OAuth with PKCE (no client secret needed).

## Tools

### Static Data (SDE)

| Tool | Description |
|------|-------------|
| `search_types` | Search items by name with category/group filters |
| `get_type` | Full type detail with dogma attributes, effects, and traits |
| `get_type_attributes` | Dogma attributes (CPU, PG, damage, resists, etc.) |
| `get_type_effects` | Effects and slot type (hi/med/low/rig) |
| `compare_types` | Side-by-side attribute comparison for multiple types |
| `get_group` | Inventory group with all types |
| `get_category` | Inventory category with child groups |
| `get_market_group` | Market group tree navigation |
| `search_systems` | Search solar systems by name |
| `get_system` | System details, connected systems, stations |
| `get_region` | Region with constellations |
| `get_station` | Station details |
| `get_blueprint` | Blueprint materials, products, skills, time |
| `search_blueprints` | Find blueprints by product name |
| `query_sde` | Raw read-only SQL against the SDE |
| `get_sde_status` | SDE version, download date, table list |
| `refresh_sde` | Download/update the SDE from Fuzzwork |

### Live Character Data (ESI)

| Tool | Description |
|------|-------------|
| `esi_login` | Start EVE SSO OAuth login flow |
| `esi_status` | Show authenticated characters and token status |
| `esi_logout` | Remove stored tokens for a character |
| `esi_switch_character` | Switch active character for queries |
| `get_character_skills` | All trained skills with SDE-enriched names and groups |
| `get_skill_queue` | Current skill training queue |
| `get_character_attributes` | Character attributes (int/mem/per/will/cha) |
| `check_skill_requirements` | Check if character meets skill reqs for a ship/module |

### Market & Trading (ESI)

| Tool | Description |
|------|-------------|
| `get_wallet_balance` | Character ISK balance |
| `get_character_orders` | Open market orders with item names |
| `get_order_history` | Completed/cancelled/expired orders |
| `get_wallet_journal` | ISK income/expense log |
| `get_wallet_transactions` | Recent market buys/sells with item names |
| `get_market_prices` | Global average/adjusted prices (public) |
| `get_region_orders` | Market orders for an item in a region (public) |
| `get_market_history` | Daily price/volume history for an item (public) |
| `get_structure_orders` | Orders in a player-owned structure (authenticated) |
| `get_market_types` | List type IDs with active orders in a region (public) |

### Accounting Ledger (local)

ESI's wallet journal/transactions only cover a rolling ~30 days and order history ~90 days — these tools persist synced data permanently in a local SQLite ledger (`~/.eve-sde/ledger.db`) so realized P&L, FIFO cost basis, daily closes, and relisting-fee correlation all survive past those windows.

| Tool | Description |
|------|-------------|
| `sync_wallet_ledger` | Pull all currently-available wallet journal + transactions + orders into the local ledger |
| `run_daily_close` | Sync, apply FIFO cost-basis matching, and compute a day's realized/unrealized P&L — defaults to the last completed UTC day (00:00–24:00); past dates get historical marks + reconstructed escrow, and every close reconciles NAV change vs. prior close; broker fees split into new-listing vs. relisting |
| `get_daily_close_by_position` | Same day-close, broken out per item type_id instead of one portfolio total, incl. relisting-fee attribution and all-in net P&L per position |
| `get_daily_close` | Read a previously computed close for one date |
| `get_close_range` | Read a range of computed closes, with summed totals |
| `get_open_lots` | List current open FIFO lots (unsold inventory with acquisition cost and the relisting fees already sunk into each position's sell campaign) |
| `get_effective_broker_fee_pct` | Estimate the character's real broker fee % from their own paid-fee history, no game-formula/standings lookup needed |
| `get_autoclose_status` | Inspect the autonomous daily-close heartbeat: config, per-character coverage of recent days, and the run log |

**Autonomous daily close.** While the server is running it closes days by itself: it syncs the wallet ledger once its last sync is older than 20 hours, and closes every completed UTC day (including backfilling gaps up to 25 days) once EVE downtime (~11:05 UTC) has published that day's market history — the default cutoff is 11:30 UTC. Everything is condition-based and idempotent, so a sleeping machine or a closed MCP client just means the next heartbeat catches up; nothing is lost as long as gaps stay under ESI's ~30-day windows. Every attempt (success or failure) is logged to the `autoclose_runs` table — `get_autoclose_status` shows coverage and history. Configure or disable via `~/.eve-sde/config.json`:

```json
{
  "autoClose": {
    "enabled": true,
    "minUtcHour": 11.5,
    "tickMinutes": 30,
    "syncMaxAgeHours": 20,
    "lookbackDays": 25,
    "maxAttemptsPerDate": 3,
    "maxBackfillsPerTick": 5
  }
}
```

### Killmails (ESI)

| Tool | Description |
|------|-------------|
| `get_recent_killmails` | Character's recent kills and losses (IDs + hashes) |
| `get_killmail` | Full killmail detail with victim fitting, attackers, SDE names (public) |

### Fittings (ESI)

| Tool | Description |
|------|-------------|
| `get_fittings` | All saved fittings with ship/module names from SDE |
| `save_fitting` | Save a fitting from EFT format or structured input (write) |
| `delete_fitting` | Delete a saved fitting by ID (write) |
| `parse_eft` | Preview EFT parsing without saving — resolves names to IDs and slot flags |

### Industry & Assets (ESI)

| Tool | Description |
|------|-------------|
| `get_industry_jobs` | Active/recent manufacturing, research, invention jobs |
| `get_industry_cost_indices` | System cost indices for industry (public) |
| `get_character_assets` | Items in hangars/containers with names |
| `get_character_contracts` | Courier, item exchange, auction contracts |

## Setup

Requires Node.js 22+ (managed with [fnm](https://github.com/Schniz/fnm) — the version is pinned in `.node-version`). Development and the deployed server both run this pinned version.

```bash
git clone https://github.com/ramonvanalteren/eve-sde-mcp.git
cd eve-sde-mcp
fnm use            # switch to the pinned Node before installing
npm install
npm run build
```

The SDE database (~460MB) is auto-downloaded to `~/.eve-sde/eve.db` on first run.

## Server install (production)

The MCP server is **installed separately from the development checkout** — it never runs from the repo directly:

```bash
fnm use            # deploy refuses to run under the wrong Node
npm run deploy
```

`npm run deploy` builds `dist/`, wipes and repopulates `~/.eve-sde/server/` (dist, a production-only `node_modules` built for the pinned runtime, a `start.sh` launcher with the resolved Node path baked in), verifies the native binding there, and updates the Claude Desktop config (with a timestamped backup; `--no-config` skips). Restart Claude Desktop afterwards. The resulting config entry is:

```json
{
  "mcpServers": {
    "eve-sde": {
      "command": "/Users/you/.eve-sde/server/start.sh"
    }
  }
}
```

Updates are the same command — it's a clean redeploy. Data (`eve.db`, `ledger.db`, `auth.db`, `config.json`) lives in `~/.eve-sde/` and is shared between the installed server and dev runs, unchanged by deploys.

**Why the separation exists:** the server used to run from this checkout via `bootstrap.mjs`, launched by the MCP client under `/opt/homebrew/bin/node` while development ran under fnm — two runtimes, one shared `node_modules`. The launcher's on-mismatch "npm rebuild" silently flipped the `better-sqlite3` binary between ABIs on every relaunch, racing the dev shell's own rebuilds; a torn binary left macOS killing every process that tried to load it (Code Signature Invalid). Two rules now prevent that class of failure:

1. **The server owns its install.** `~/.eve-sde/server/` is independent of the dev tree — branch switches, `npm install`, and rebuilds in the repo can't affect a running or deployed server, and vice versa.
2. **Launchers never rebuild.** `start.sh` (repo and install) and `bootstrap.mjs` verify the binding and fail loudly with the fix on mismatch. They never mutate `node_modules` — silent self-repair by a launcher running under an unexpected runtime is what corrupted the shared install.

## Claude Desktop / Claude Chat

Use the deployed install (see [Server install](#server-install-production)) — don't point an MCP client at the dev checkout. If you know what you're doing and want a dev-tree launch anyway:

```json
{
  "mcpServers": {
    "eve-sde": {
      "command": "/path/to/eve-sde-mcp/start.sh"
    }
  }
}
```

Restart Claude Desktop to connect.

## ESI Authentication

To use the live character data tools, you need an EVE SSO application:

1. Register at https://developers.eveonline.com — create an app with "Authentication & API Access", callback URL `http://localhost:8085/callback`
2. Create `~/.eve-sde/config.json`:
   ```json
   { "clientId": "your_client_id_here" }
   ```
3. Use the `esi_login` tool — it opens a browser for EVE SSO login and stores encrypted tokens locally

Tokens are encrypted at rest (AES-256-GCM) and stored in `~/.eve-sde/auth.db`. Scopes include skill reading, wallet, market, industry, assets, contracts, and fittings (read+write). Multi-character support is built in.

## Development

```bash
fnm use
npm run dev          # Run with tsx (no build needed)
npm test             # Run test suite
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
npm run rebuild      # Rebuild better-sqlite3 for the current fnm Node
npm run deploy       # (Re)install the server to ~/.eve-sde/server
```

`start.sh` and `bootstrap.mjs` (dev-tree launchers) check that the native binding loads under the resolved runtime and exit with instructions on mismatch — they never rebuild automatically. If the binding breaks after a Node switch, run `fnm use` (to the `.node-version` pin) and `npm run rebuild`.

## Data

- **SDE**: `~/.eve-sde/eve.db` — use `refresh_sde` to update
- **Auth tokens**: `~/.eve-sde/auth.db` — encrypted, use `esi_logout` to remove
- **Config**: `~/.eve-sde/config.json` — EVE SSO Client ID
- The `query_sde` tool allows arbitrary SELECT queries for anything the specific tools don't cover

## License

MIT
