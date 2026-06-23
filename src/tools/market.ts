import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter } from "../auth/esi-client.js";
import { enrichTypeName } from "../utils.js";

interface EsiOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  volume_total: number;
  volume_remain: number;
  price: number;
  is_buy_order: boolean;
  issued: string;
  duration: number;
  min_volume?: number;
  range?: string;
  region_id?: number;
  escrow?: number;
  state?: string;
}

interface EsiWalletJournalEntry {
  id: number;
  date: string;
  ref_type: string;
  amount?: number;
  balance?: number;
  description: string;
  first_party_id?: number;
  second_party_id?: number;
  reason?: string;
  context_id?: number;
  context_id_type?: string;
}

interface EsiTransaction {
  transaction_id: number;
  date: string;
  type_id: number;
  quantity: number;
  unit_price: number;
  client_id: number;
  location_id: number;
  is_buy: boolean;
  is_personal: boolean;
  journal_ref_id: number;
}

const MARKET_PRICE_CACHE_TTL = 10 * 60 * 1000;

export function registerMarketTools(server: McpServer): void {
  server.tool(
    "get_wallet_balance",
    "Get the ISK wallet balance for the authenticated character.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const balance = await esiGet<number>(
        `/characters/${char.characterId}/wallet/`,
        { characterId: char.characterId }
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                characterName: char.characterName,
                balance,
                formatted: balance.toLocaleString("en-US", { minimumFractionDigits: 2 }) + " ISK",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_character_orders",
    "Get open market orders for the authenticated character, enriched with item names from the SDE.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const orders = await esiGet<EsiOrder[]>(
        `/characters/${char.characterId}/orders/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      const enriched = orders.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        locationId: o.location_id,
        issued: o.issued,
        duration: o.duration,
        minVolume: o.min_volume,
        range: o.range,
        escrow: o.escrow,
      }));

      const buyOrders = enriched.filter((o) => o.isBuyOrder);
      const sellOrders = enriched.filter((o) => !o.isBuyOrder);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                characterName: char.characterName,
                totalOrders: enriched.length,
                buyOrders: buyOrders.length,
                sellOrders: sellOrders.length,
                orders: enriched,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_order_history",
    "Get historical (completed/cancelled/expired) market orders for the authenticated character.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const orders = await esiGetAll<EsiOrder & { state: string }>(
        `/characters/${char.characterId}/orders/history/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      const enriched = orders.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        state: o.state,
        issued: o.issued,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { characterName: char.characterName, count: enriched.length, orders: enriched },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_wallet_journal",
    "Get the wallet journal (ISK income/expenses log) for the authenticated character.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const journal = await esiGetAll<EsiWalletJournalEntry>(
        `/characters/${char.characterId}/wallet/journal/`,
        { characterId: char.characterId }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { characterName: char.characterName, entries: journal.length, journal },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_wallet_transactions",
    "Get recent wallet transactions (market buys/sells) for the authenticated character, enriched with item names.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const transactions = await esiGet<EsiTransaction[]>(
        `/characters/${char.characterId}/wallet/transactions/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      const enriched = transactions.map((t) => ({
        transactionId: t.transaction_id,
        date: t.date,
        typeName: enrichTypeName(db, t.type_id),
        typeId: t.type_id,
        quantity: t.quantity,
        unitPrice: t.unit_price,
        total: t.quantity * t.unit_price,
        isBuy: t.is_buy,
        locationId: t.location_id,
        clientId: t.client_id,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { characterName: char.characterName, count: enriched.length, transactions: enriched },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_market_prices",
    "Get the global average and adjusted prices for all items in Eve Online (public, no auth needed).",
    {
      type_id: z.number().optional().describe("Filter to a specific type ID"),
    },
    async ({ type_id }) => {
      const prices = await esiGet<Array<{ type_id: number; average_price?: number; adjusted_price?: number }>>(
        "/markets/prices/",
        { public: true, cacheTtlMs: MARKET_PRICE_CACHE_TTL }
      );

      const db = getDatabase();

      if (type_id) {
        const match = prices.find((p) => p.type_id === type_id);
        if (!match) {
          return { content: [{ type: "text", text: `No price data for type ${type_id}.` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ...match, typeName: enrichTypeName(db, match.type_id) },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: prices.length, note: "Use type_id parameter to filter. Full list is ~13k items." }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_region_orders",
    "Get market orders for a specific item in a region (public, no auth needed). Use for price checking.",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita, 10000043 = Domain/Amarr)"),
      type_id: z.number().describe("Type ID of the item"),
      order_type: z.enum(["buy", "sell", "all"]).default("all").describe("Filter by order type"),
    },
    async ({ region_id, type_id, order_type }) => {
      let url = `/markets/${region_id}/orders/?type_id=${type_id}`;
      if (order_type === "buy") url += "&order_type=buy";
      else if (order_type === "sell") url += "&order_type=sell";
      else url += "&order_type=all";

      const orders = await esiGetAll<EsiOrder>(url, { public: true });

      const db = getDatabase();
      const typeName = enrichTypeName(db, type_id);

      const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
      const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                typeName,
                typeId: type_id,
                regionId: region_id,
                bestBuy: buyOrders[0]?.price ?? null,
                bestSell: sellOrders[0]?.price ?? null,
                spread: buyOrders[0] && sellOrders[0]
                  ? ((sellOrders[0].price - buyOrders[0].price) / sellOrders[0].price * 100).toFixed(2) + "%"
                  : null,
                buyOrderCount: buyOrders.length,
                sellOrderCount: sellOrders.length,
                topBuyOrders: buyOrders.slice(0, 5),
                topSellOrders: sellOrders.slice(0, 5),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_market_history",
    "Get daily price/volume history for an item in a region (public, no auth needed).",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita)"),
      type_id: z.number().describe("Type ID of the item"),
      days: z.number().default(30).describe("Number of recent days to return"),
    },
    async ({ region_id, type_id, days }) => {
      const history = await esiGet<Array<{
        date: string;
        average: number;
        highest: number;
        lowest: number;
        order_count: number;
        volume: number;
      }>>(`/markets/${region_id}/history/?type_id=${type_id}`, { public: true });

      const db = getDatabase();
      const typeName = enrichTypeName(db, type_id);
      const recent = history.slice(-days);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { typeName, typeId: type_id, regionId: region_id, days: recent.length, history: recent },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_structure_orders",
    "Get market orders in a player-owned structure (citadel, engineering complex, etc.). Requires esi-markets.structure_markets.v1 scope and docking access.",
    {
      structure_id: z.string().regex(/^\d+$/).describe("Structure ID (numeric string — 64-bit IDs exceed JS number precision). Find from assets or in-game."),
      type_id: z.number().optional().describe("Filter to a specific type ID"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ structure_id, type_id, character_id }) => {
      const char = await getActiveCharacter(character_id);
      const orders = await esiGetAll<EsiOrder>(
        `/markets/structures/${structure_id}/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      let filtered = orders;
      if (type_id) {
        filtered = orders.filter((o) => o.type_id === type_id);
      }

      const enriched = filtered.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        issued: o.issued,
        duration: o.duration,
        minVolume: o.min_volume,
        range: o.range,
      }));

      const buyOrders = enriched.filter((o) => o.isBuyOrder).sort((a, b) => b.price - a.price);
      const sellOrders = enriched.filter((o) => !o.isBuyOrder).sort((a, b) => a.price - b.price);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                characterName: char.characterName,
                structureId: structure_id,
                totalOrders: enriched.length,
                buyOrders: buyOrders.length,
                sellOrders: sellOrders.length,
                bestBuy: buyOrders[0]?.price ?? null,
                bestSell: sellOrders[0]?.price ?? null,
                orders: enriched,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_market_types",
    "List all type IDs with active market orders in a region (public). Useful for finding what's traded in a region.",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita)"),
    },
    async ({ region_id }) => {
      const typeIds = await esiGetAll<number>(
        `/markets/${region_id}/types/`,
        { public: true }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { regionId: region_id, typeCount: typeIds.length, typeIds },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
