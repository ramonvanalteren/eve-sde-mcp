# eve-sde-mcp

MCP server providing access to Eve Online's Static Data Export (SDE) — ship stats, module attributes, universe data, industry blueprints, and more.

Powered by the [Fuzzwork](https://www.fuzzwork.co.uk/dump/) SQLite conversion of CCP's SDE. All data is local, read-only, and requires no authentication.

## Tools

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

## Development

```bash
npm run dev          # Run with tsx (no build needed)
npm test             # Run test suite
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
```

## Data

The SDE is stored at `~/.eve-sde/eve.db` (outside the repo). Use the `refresh_sde` tool to update it when CCP releases a new version. The `query_sde` tool allows arbitrary SELECT queries for anything the specific tools don't cover.

## License

MIT
