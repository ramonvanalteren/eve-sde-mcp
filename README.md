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

Requires Node.js 20+.

```bash
git clone https://github.com/ramonvanalteren/eve-sde-mcp.git
cd eve-sde-mcp
npm install
npm run build
```

The SDE database (~460MB) is auto-downloaded to `~/.eve-sde/eve.db` on first run.

## Claude Desktop / Claude Chat

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eve-sde": {
      "command": "node",
      "args": ["/path/to/eve-sde-mcp/dist/index.js"]
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
npm run dev          # Run with tsx (no build needed)
npm test             # Run test suite
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
```

## Data

- **SDE**: `~/.eve-sde/eve.db` — use `refresh_sde` to update
- **Auth tokens**: `~/.eve-sde/auth.db` — encrypted, use `esi_logout` to remove
- **Config**: `~/.eve-sde/config.json` — EVE SSO Client ID
- The `query_sde` tool allows arbitrary SELECT queries for anything the specific tools don't cover

## License

MIT
