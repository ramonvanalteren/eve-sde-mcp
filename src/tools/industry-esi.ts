import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter, ESI_CACHE_TTL } from "../auth/esi-client.js";
import { enrichTypeName, likeContains, jsonResult } from "../utils.js";
import { mapConcurrent, EsiOrder, JITA_TRADE_HUB, MAX_CONCURRENT_ESI } from "./market.js";
import { computeBuildMargin, type BuildMarginInput, type PriceQuote } from "../industry/build-margin.js";

interface EsiIndustryJob {
  job_id: number;
  installer_id: number;
  facility_id: number;
  station_id: number;
  activity_id: number;
  blueprint_id: number;
  blueprint_type_id: number;
  blueprint_location_id: number;
  output_location_id: number;
  runs: number;
  cost?: number;
  licensed_runs?: number;
  probability?: number;
  product_type_id?: number;
  status: string;
  duration: number;
  start_date: string;
  end_date: string;
  pause_date?: string;
  completed_date?: string;
  completed_character_id?: number;
  successful_runs?: number;
}

interface EsiCostIndex {
  solar_system_id: number;
  cost_indices: Array<{
    activity: string;
    cost_index: number;
  }>;
}

const ACTIVITY_NAMES: Record<number, string> = {
  1: "Manufacturing",
  3: "TE Research",
  4: "ME Research",
  5: "Copying",
  7: "Reverse Engineering",
  8: "Invention",
  9: "Reaction",
  11: "Reaction",
};

const COST_INDEX_CACHE_TTL = 10 * 60 * 1000;

export function registerIndustryEsiTools(server: McpServer): void {
  server.tool(
    "price_build",
    "Price a manufacturing job BEFORE committing runs: blueprint materials (ME-adjusted) at live market prices vs the product's sell price, net of sales tax and broker fee — the industry counterpart of margin verification. Reports unit build cost and margin on both acquisition bases (materials at sell orders = instant, at buy orders = patient), the full material table, book depths, and warnings for thin books or missing orders. Born from the 2026-09 audit where a 400-run Damage Control I job was committed at +0.9% margin. Point-in-time: re-verify before executing. Installation cost is optional (pass the in-client install number for exact figures).",
    {
      blueprint_type_id: z.number().optional().describe("Blueprint typeID (from search_blueprints or get_fittings-style lookups)"),
      product_name: z.string().optional().describe("Product name — resolves the manufacturing blueprint that makes it (alternative to blueprint_type_id)"),
      runs: z.number().default(1).describe("Number of runs to price"),
      me_level: z.number().default(0).describe("Blueprint ME level 0-10 (0 = base material quantities)"),
      region_id: z.number().default(10000002).describe("Region for market prices (default 10000002 = The Forge)"),
      location_id: z.number().default(JITA_TRADE_HUB).describe("Station/structure to price materials and product at (default 60003760 = Jita 4-4)"),
      sales_tax_pct: z.number().default(3.6).describe("Sales tax percentage on the product sale (default 3.6%)"),
      broker_fee_pct: z.number().default(1.0).describe("Broker fee percentage on the product listing (default 1%)"),
      installation_cost: z.number().optional().describe("Total installation cost for all runs, as shown by the in-client install dialog — folded into unit cost"),
    },
    async ({ blueprint_type_id, product_name, runs, me_level, region_id, location_id, sales_tax_pct, broker_fee_pct, installation_cost }) => {
      const db = getDatabase();

      // Resolve the blueprint: explicit typeID, or the manufacturing blueprint for a product name
      let bpTypeId = blueprint_type_id;
      if (!bpTypeId && product_name) {
        const row = db
          .prepare(
            `SELECT iap.typeID as bpTypeId
             FROM industryActivityProducts iap
             JOIN invTypes p ON iap.productTypeID = p.typeID
             WHERE p.typeName LIKE ? ESCAPE '\\' AND iap.activityID = 1
             ORDER BY p.typeName
             LIMIT 1`
          )
          .get(likeContains(product_name)) as { bpTypeId: number } | undefined;
        if (!row) {
          return { content: [{ type: "text", text: `No manufacturing blueprint found for a product matching "${product_name}".` }] };
        }
        bpTypeId = row.bpTypeId;
      }
      if (!bpTypeId) {
        return { content: [{ type: "text", text: "Provide blueprint_type_id or product_name." }] };
      }

      const bpName = enrichTypeName(db, bpTypeId);

      // Manufacturing materials + product from the SDE
      const materialRows = db
        .prepare(
          `SELECT iam.materialTypeID, t.typeName as materialName, iam.quantity
           FROM industryActivityMaterials iam
           JOIN invTypes t ON iam.materialTypeID = t.typeID
           WHERE iam.typeID = ? AND iam.activityID = 1`
        )
        .all(bpTypeId) as Array<{ materialTypeID: number; materialName: string; quantity: number }>;

      const productRow = db
        .prepare(
          `SELECT iap.productTypeID, t.typeName as productName, iap.quantity
           FROM industryActivityProducts iap
           JOIN invTypes t ON iap.productTypeID = t.typeID
           WHERE iap.typeID = ? AND iap.activityID = 1`
        )
        .get(bpTypeId) as { productTypeID: number; productName: string; quantity: number } | undefined;

      if (materialRows.length === 0 || !productRow) {
        return { content: [{ type: "text", text: `"${bpName}" has no manufacturing activity in the SDE — is it a blueprint?` }] };
      }

      // Live quotes for product + all materials, concurrently
      const typeIds = [productRow.productTypeID, ...materialRows.map((m) => m.materialTypeID)];
      const uniqueTypeIds = [...new Set(typeIds)];
      const quotes = new Map<number, PriceQuote>();
      await mapConcurrent(
        uniqueTypeIds,
        MAX_CONCURRENT_ESI,
        async (typeId) => {
          const url = `/markets/${region_id}/orders/?type_id=${typeId}&order_type=all`;
          try {
            const allOrders = await esiGetAll<EsiOrder>(url, { public: true, cacheTtlMs: ESI_CACHE_TTL });
            const orders = allOrders.filter((o) => o.location_id === location_id);
            const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
            const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - a.price);
            quotes.set(typeId, {
              bestSell: sellOrders[0]?.price ?? null,
              bestBuy: buyOrders[0]?.price ?? null,
              sellOrderCount: sellOrders.length,
              buyOrderCount: buyOrders.length,
            });
          } catch (err) {
            // One failed fetch must not sink the whole report — leave the quote absent
            quotes.set(typeId, { bestSell: null, bestBuy: null, sellOrderCount: 0, buyOrderCount: 0 });
            process.stderr.write(`[price_build] order fetch failed for type ${typeId}: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      );

      const input: BuildMarginInput = {
        product: { name: productRow.productName, typeId: productRow.productTypeID, quantityPerRun: productRow.quantity },
        materials: materialRows.map((m) => ({ name: m.materialName, typeId: m.materialTypeID, qtyPerRun: m.quantity })),
        runs,
        meLevel: me_level,
        prices: quotes,
        salesTaxPct: sales_tax_pct,
        brokerFeePct: broker_fee_pct,
        installationCostTotal: installation_cost ?? null,
      };

      const report = computeBuildMargin(input);

      return jsonResult({
        blueprint: { name: bpName, typeId: bpTypeId },
        product: { name: productRow.productName, typeId: productRow.productTypeID, quantityPerRun: productRow.quantity },
        pricingLocation: { regionId: region_id, locationId: location_id },
        fees: { salesTaxPct: sales_tax_pct, brokerFeePct: broker_fee_pct },
        ...report,
        note: "Margins are point-in-time snapshots. The sell basis (materials at sell orders) is the conservative one; re-verify before committing runs.",
      });
    }
  );

  server.tool(
    "get_industry_jobs",
    "Get active and recent industry jobs for the authenticated character — manufacturing, research, invention, reactions. Supports filtering by activity and status.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      include_completed: z.boolean().default(false).describe("Include completed jobs"),
      activity: z.string().optional().describe("Filter by activity name (e.g. 'Manufacturing', 'Invention', 'Reaction')"),
      status: z.enum(["active", "cancelled", "delivered", "paused", "ready"]).optional().describe("Filter by job status"),
    },
    async ({ character_id, include_completed, activity, status }) => {
      const char = await getActiveCharacter(character_id);
      let url = `/characters/${char.characterId}/industry/jobs/`;
      if (include_completed) url += "?include_completed=true";

      const jobs = await esiGet<EsiIndustryJob[]>(url, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      const db = getDatabase();
      let enriched = jobs.map((j) => ({
        jobId: j.job_id,
        activity: ACTIVITY_NAMES[j.activity_id] ?? `Activity ${j.activity_id}`,
        blueprintName: enrichTypeName(db, j.blueprint_type_id),
        blueprintTypeId: j.blueprint_type_id,
        productName: j.product_type_id ? enrichTypeName(db, j.product_type_id) : null,
        productTypeId: j.product_type_id ?? null,
        runs: j.runs,
        status: j.status,
        cost: j.cost,
        startDate: j.start_date,
        endDate: j.end_date,
        completedDate: j.completed_date ?? null,
        successfulRuns: j.successful_runs ?? null,
        facilityId: j.facility_id,
      }));

      if (activity) enriched = enriched.filter((j) => j.activity.toLowerCase() === activity.toLowerCase());
      if (status) enriched = enriched.filter((j) => j.status === status);

      return jsonResult({
        characterName: char.characterName,
        activeJobs: enriched.filter((j) => j.status === "active").length,
        totalJobs: enriched.length,
        jobs: enriched,
      });
    }
  );

  server.tool(
    "get_industry_cost_indices",
    "Get system cost indices for industry activities (public, no auth). Shows manufacturing/research/invention costs per solar system.",
    {
      system_name: z.string().optional().describe("Filter by solar system name"),
      system_id: z.number().optional().describe("Filter by solar system ID"),
    },
    async ({ system_name, system_id }) => {
      const indices = await esiGet<EsiCostIndex[]>("/industry/systems/", {
        public: true,
        cacheTtlMs: COST_INDEX_CACHE_TTL,
      });

      let systemId = system_id;
      if (system_name && !systemId) {
        const db = getDatabase();
        const row = db
          .prepare("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName LIKE ? ESCAPE '\\'")
          .get(likeContains(system_name)) as { solarSystemID: number } | undefined;
        if (!row) {
          return { content: [{ type: "text", text: `System "${system_name}" not found in SDE.` }] };
        }
        systemId = row.solarSystemID;
      }

      if (systemId) {
        const match = indices.find((i) => i.solar_system_id === systemId);
        if (!match) {
          return { content: [{ type: "text", text: `No cost index data for system ${systemId}.` }] };
        }

        const db = getDatabase();
        const sysInfo = db
          .prepare("SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?")
          .get(systemId) as { solarSystemName: string } | undefined;

        return jsonResult({
          systemName: sysInfo?.solarSystemName ?? systemId,
          systemId,
          costIndices: match.cost_indices,
        });
      }

      return jsonResult({ count: indices.length, note: "Use system_name or system_id to filter. Returns all ~5k systems otherwise." });
    }
  );

  server.tool(
    "get_character_assets",
    "Get assets (items in hangars/containers) for the authenticated character, enriched with item names.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_name: z.string().optional().describe("Filter assets by item name"),
      location_id: z.number().optional().describe("Filter by location ID"),
    },
    async ({ character_id, type_name, location_id }) => {
      const char = await getActiveCharacter(character_id);
      const assets = await esiGetAll<{
        item_id: number;
        type_id: number;
        location_id: number;
        location_type: string;
        quantity: number;
        location_flag: string;
        is_singleton: boolean;
      }>(`/characters/${char.characterId}/assets/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      const db = getDatabase();
      let enriched = assets.map((a) => ({
        itemId: a.item_id,
        typeName: enrichTypeName(db, a.type_id),
        typeId: a.type_id,
        quantity: a.quantity,
        locationId: a.location_id,
        locationType: a.location_type,
        locationFlag: a.location_flag,
        isSingleton: a.is_singleton,
      }));

      if (type_name) {
        enriched = enriched.filter((a) =>
          a.typeName.toLowerCase().includes(type_name.toLowerCase())
        );
      }
      if (location_id) {
        enriched = enriched.filter((a) => a.locationId === location_id);
      }

      return jsonResult({ characterName: char.characterName, assetCount: enriched.length, assets: enriched });
    }
  );

  server.tool(
    "get_character_contracts",
    "Get contracts for the authenticated character — courier, item exchange, and auction contracts. Supports filtering by type and status.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type: z.enum(["unknown", "item_exchange", "auction", "courier"]).optional().describe("Filter by contract type"),
      status: z.enum(["outstanding", "in_progress", "finished_issuer", "finished_contractor", "finished", "cancelled", "rejected", "failed", "deleted", "reversed"]).optional().describe("Filter by contract status"),
    },
    async ({ character_id, type, status }) => {
      const char = await getActiveCharacter(character_id);
      let contracts = await esiGetAll<{
        contract_id: number;
        issuer_id: number;
        assignee_id: number;
        type: string;
        status: string;
        title: string;
        price: number;
        reward: number;
        collateral: number;
        volume: number;
        date_issued: string;
        date_expired: string;
        date_completed?: string;
        start_location_id?: number;
        end_location_id?: number;
      }>(`/characters/${char.characterId}/contracts/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      if (type) contracts = contracts.filter((c) => c.type === type);
      if (status) contracts = contracts.filter((c) => c.status === status);

      return jsonResult({ characterName: char.characterName, contractCount: contracts.length, contracts });
    }
  );
}
