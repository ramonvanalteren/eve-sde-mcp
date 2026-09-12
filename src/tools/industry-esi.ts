import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter, ESI_CACHE_TTL } from "../auth/esi-client.js";
import { enrichTypeName, likeContains, jsonResult } from "../utils.js";
import { mapConcurrent, EsiOrder, JITA_TRADE_HUB, MAX_CONCURRENT_ESI } from "./market.js";
import { computeBuildMargin, type BuildMarginInput, type PriceQuote } from "../industry/build-margin.js";
import { screenBuilds, averageDailyVolume, type ScanBlueprint } from "../industry/build-scan.js";

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

/** Live buy/sell quotes for a set of types at one station (shared by price_build and scan_builds). */
async function fetchQuotesForTypes(
  typeIds: number[],
  regionId: number,
  locationId: number
): Promise<Map<number, PriceQuote>> {
  const quotes = new Map<number, PriceQuote>();
  await mapConcurrent(
    typeIds,
    MAX_CONCURRENT_ESI,
    async (typeId) => {
      const url = `/markets/${regionId}/orders/?type_id=${typeId}&order_type=all`;
      try {
        const allOrders = await esiGetAll<EsiOrder>(url, { public: true, cacheTtlMs: ESI_CACHE_TTL });
        const orders = allOrders.filter((o) => o.location_id === locationId);
        const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
        const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
        quotes.set(typeId, {
          bestSell: sellOrders[0]?.price ?? null,
          bestBuy: buyOrders[0]?.price ?? null,
          sellOrderCount: sellOrders.length,
          buyOrderCount: buyOrders.length,
        });
      } catch (err) {
        // One failed fetch must not sink the whole report — leave the quote absent
        quotes.set(typeId, { bestSell: null, bestBuy: null, sellOrderCount: 0, buyOrderCount: 0 });
        process.stderr.write(`[industry] order fetch failed for type ${typeId}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  );
  return quotes;
}

export function registerIndustryEsiTools(server: McpServer): void {
  server.tool(
    "get_character_blueprints",
    "List the character's blueprints with Material Efficiency, Time Efficiency, and runs (BPO vs BPC), from ESI /characters/{id}/blueprints/. Requires esi-characters.read_blueprints.v1 — granted on the next esi_login after the scope was added to the server's default set; until then this reports the missing scope. The BOM ledger pass resolves each delivered manufacturing job's exact BPO ME from this data (config blueprintME is the fallback, ME 0 the floor).",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const db = getDatabase();
      try {
        const bps = await esiGetAll<{ item_id: number; type_id: number; location_id?: number; location_flag?: string; quantity?: number; material_efficiency?: number; time_efficiency?: number; runs?: number }>(
          `/characters/${char.characterId}/blueprints/`,
          { characterId: char.characterId }
        );
        const enriched = bps
          .map((b) => ({
            itemId: b.item_id,
            blueprintName: enrichTypeName(db, b.type_id),
            blueprintTypeId: b.type_id,
            kind: b.runs === -1 ? "original" : `copy (${b.runs} runs)`,
            me: b.material_efficiency ?? 0,
            te: b.time_efficiency ?? 0,
            locationId: b.location_id ?? null,
            locationFlag: b.location_flag ?? null,
            quantity: b.quantity ?? null,
          }))
          .sort((a, b) => a.blueprintName.localeCompare(b.blueprintName));
        return jsonResult({
          characterName: char.characterName,
          blueprintCount: enriched.length,
          blueprints: enriched,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Blueprints unavailable: ${msg}. The endpoint needs esi-characters.read_blueprints.v1 — run esi_login to re-authenticate with the new scope, then this and the BOM auto-ME resolution work.`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "scan_builds",
    "Discover industry candidates: screen every T1 manufacturing blueprint in a category (or a specific product list — e.g. items you already trade) with ESI bulk adjusted prices, rank by rough margin, then LIVE-verify the top candidates at a station (materials + product order books, net of tax/broker, 30-day average traded volume). Screen hits are candidates, never verdicts — every reported margin past the screen is live-verified, and finalists still need price_build with the installation cost plus skill checks before runs are committed. The closed SDE blueprint universe makes industry discovery self-sufficient — no external tier feeds needed.",
    {
      category: z.enum(["module", "ship", "drone", "charge", "all"]).default("module").describe("Product category to scan (default module — the vertical-integration default)"),
      product_type_ids: z.array(z.number()).optional().describe("Scan only these products' blueprints (synergy mode — e.g. your current trade items) instead of a category scan"),
      me_level: z.number().default(0).describe("ME level to screen and verify at (0-10)"),
      min_margin_pct: z.number().default(10).describe("Screen-stage minimum margin percent on adjusted prices (default 10)"),
      top_n: z.number().default(15).describe("Candidates to screen-rank and then live-verify (default 15, max 50)"),
      region_id: z.number().default(10000002).describe("Region for prices (default 10000002 = The Forge)"),
      location_id: z.number().default(JITA_TRADE_HUB).describe("Station to verify materials/product at (default 60003760 = Jita 4-4)"),
      sales_tax_pct: z.number().default(3.6).describe("Sales tax percentage (default 3.6)"),
      broker_fee_pct: z.number().default(1.0).describe("Broker fee percentage (default 1)"),
    },
    async ({ category, product_type_ids, me_level, min_margin_pct, top_n, region_id, location_id, sales_tax_pct, broker_fee_pct }) => {
      const db = getDatabase();
      const topN = Math.min(Math.max(Math.round(top_n), 1), 50);

      // Stage 1: enumerate T1 manufacturing blueprints (products must be market-traded)
      const CATEGORY_IDS: Record<string, number> = { module: 7, ship: 6, drone: 18, charge: 8 };
      const productFilter = product_type_ids && product_type_ids.length > 0;
      const categoryFilter = productFilter
        ? `iap.productTypeID IN (${product_type_ids.map(() => "?").join(",")})`
        : category !== "all"
          ? `g.categoryID = ${CATEGORY_IDS[category]}`
          : `1=1`;
      const params: unknown[] = productFilter ? product_type_ids : [];

      const bpRows = db
        .prepare(
          `SELECT iap.typeID as blueprintTypeId, bp.typeName as blueprintName,
                  iap.productTypeID as productTypeId, p.typeName as productName,
                  iap.quantity as productQtyPerRun
           FROM industryActivityProducts iap
           JOIN invTypes bp ON bp.typeID = iap.typeID
           JOIN invTypes p ON p.typeID = iap.productTypeID
           JOIN invGroups g ON g.groupID = p.groupID
           LEFT JOIN dgmTypeAttributes tl ON tl.typeID = p.typeID AND tl.attributeID = 422
           WHERE iap.activityID = 1 AND p.published = 1 AND p.marketGroupID IS NOT NULL
             AND (tl.valueInt = 1 OR tl.valueInt IS NULL)
             AND (${categoryFilter})`
        )
        .all(...params) as Array<{
        blueprintTypeId: number;
        blueprintName: string;
        productTypeId: number;
        productName: string;
        productQtyPerRun: number;
      }>;

      if (bpRows.length === 0) {
        return { content: [{ type: "text", text: "No T1 manufacturing blueprints matched the filter." }] };
      }

      // Materials for exactly those blueprints (same filter shape — no giant IN-list)
      const materialRows = db
        .prepare(
          `SELECT iam.typeID as blueprintTypeId, iam.materialTypeID, t.typeName as materialName, iam.quantity as qtyPerRun
           FROM industryActivityMaterials iam
           JOIN invTypes t ON t.typeID = iam.materialTypeID
           JOIN invTypes bp2 ON bp2.typeID = iam.typeID
           JOIN industryActivityProducts iap ON iap.typeID = iam.typeID AND iap.activityID = 1
           JOIN invTypes p ON p.typeID = iap.productTypeID
           JOIN invGroups g ON g.groupID = p.groupID
           LEFT JOIN dgmTypeAttributes tl ON tl.typeID = p.typeID AND tl.attributeID = 422
           WHERE iam.activityID = 1 AND p.published = 1 AND p.marketGroupID IS NOT NULL
             AND bp2.marketGroupID IS NOT NULL
             AND (tl.valueInt = 1 OR tl.valueInt IS NULL)
             AND (${categoryFilter})`
        )
        .all(...params) as Array<{
        blueprintTypeId: number;
        materialTypeID: number;
        materialName: string;
        qtyPerRun: number;
      }>;

      const byBp = new Map<number, ScanBlueprint>();
      for (const r of bpRows) {
        byBp.set(r.blueprintTypeId, {
          blueprintTypeId: r.blueprintTypeId,
          blueprintName: r.blueprintName,
          productTypeId: r.productTypeId,
          productName: r.productName,
          productQtyPerRun: r.productQtyPerRun,
          materials: [],
        });
      }
      for (const m of materialRows) {
        byBp.get(m.blueprintTypeId)?.materials.push({
          typeId: m.materialTypeID,
          name: m.materialName,
          qtyPerRun: m.qtyPerRun,
        });
      }

      // Stage 2: bulk screen on ESI adjusted prices (one call, cached an hour)
      const priceRows = await esiGet<Array<{ type_id: number; adjusted_price?: number }>>(
        "/markets/prices/",
        { public: true, cacheTtlMs: 60 * 60 * 1000 }
      );
      const adjusted = new Map<number, number>();
      for (const r of priceRows) {
        if (typeof r.adjusted_price === "number") adjusted.set(r.type_id, r.adjusted_price);
      }

      const screened = screenBuilds({
        blueprints: [...byBp.values()].filter((bp) => bp.materials.length > 0),
        adjustedPrices: adjusted,
        meLevel: me_level,
        salesTaxPct: sales_tax_pct,
        brokerFeePct: broker_fee_pct,
        minMarginPct: min_margin_pct,
        topN,
      });

      // Stage 3: live-verify the screened top-N at the station
      const verifyTypeIds = [
        ...new Set(
          screened.flatMap((c) => [
            c.productTypeId,
            ...(byBp.get(c.blueprintTypeId)?.materials.map((m) => m.typeId) ?? []),
          ])
        ),
      ];
      const quotes = await fetchQuotesForTypes(verifyTypeIds, region_id, location_id);

      const results = await mapConcurrent(
        screened,
        MAX_CONCURRENT_ESI,
        async (c) => {
          const bp = byBp.get(c.blueprintTypeId)!;
          const margin = computeBuildMargin({
            product: { name: bp.productName, typeId: bp.productTypeId, quantityPerRun: bp.productQtyPerRun },
            materials: bp.materials,
            runs: 1,
            meLevel: me_level,
            prices: quotes,
            salesTaxPct: sales_tax_pct,
            brokerFeePct: broker_fee_pct,
            installationCostTotal: null,
          });

          let avgDailyVolume: number | null = null;
          try {
            const history = await esiGet<Array<{ date: string; volume: number }>>(
              `/markets/${region_id}/history/?type_id=${c.productTypeId}`,
              { public: true, cacheTtlMs: ESI_CACHE_TTL }
            );
            avgDailyVolume = Math.round(averageDailyVolume(history, 30));
          } catch (err) {
            process.stderr.write(`[scan_builds] history fetch failed for type ${c.productTypeId}: ${err instanceof Error ? err.message : String(err)}\n`);
          }

          return {
            productName: c.productName,
            productTypeId: c.productTypeId,
            blueprintName: c.blueprintName,
            blueprintTypeId: c.blueprintTypeId,
            screenMarginPct: c.screenMarginPct !== null ? Number(c.screenMarginPct.toFixed(1)) : null,
            screenIncomplete: c.incomplete,
            costShare: c.costShare.map((s) => ({ name: s.name, pct: Number(s.pct.toFixed(1)) })),
            verified: {
              unitCostAtSell: margin.costs.unitCostAtSell,
              netPerUnit: margin.revenue.netPerUnit,
              marginAtSellPct:
                margin.margins.atSellBasis.marginPct !== null
                  ? Number(margin.margins.atSellBasis.marginPct.toFixed(1))
                  : null,
              marginAtBuyPct:
                margin.margins.atBuyBasis.marginPct !== null
                  ? Number(margin.margins.atBuyBasis.marginPct.toFixed(1))
                  : null,
              productSellOrderCount: margin.productQuote.sellOrderCount,
              productBuyOrderCount: margin.productQuote.buyOrderCount,
              avgDailyVolume,
              warnings: margin.warnings,
            },
          };
        }
      );

      // Rank by verified sell-basis margin where available; unverifiable entries sink to the end
      const ranked = [...results].sort((a, b) => {
        const am = a.verified.marginAtSellPct ?? -Infinity;
        const bm = b.verified.marginAtSellPct ?? -Infinity;
        return bm - am;
      });

      return jsonResult({
        scannedBlueprints: byBp.size,
        screen: { minMarginPct: min_margin_pct, basis: "ESI adjusted prices (blended, system-wide — coarse filter only)" },
        verifiedAt: { regionId: region_id, locationId: location_id },
        fees: { salesTaxPct: sales_tax_pct, brokerFeePct: broker_fee_pct, meLevel: me_level },
        candidateCount: ranked.length,
        candidates: ranked,
        note: "Only market-obtainable BPOs are scanned (faction/named artifacts and invention-only T2 excluded). Screen margins are adjusted-price approximations; verified margins are live at the station, materials-only (installation excluded). Finalists still need price_build with the in-client installation cost and a skill check before committing runs.",
      });
    }
  );

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
      const quotes = await fetchQuotesForTypes(uniqueTypeIds, region_id, location_id);

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
