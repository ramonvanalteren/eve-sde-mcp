// Corporation-scoped ESI tools — Tier 1 of the corp-management plan: wallet,
// assets, blueprints, industry jobs, and contracts, each mirroring its
// existing character-scoped counterpart (get_wallet_balance, get_character_
// assets, get_character_blueprints, get_industry_jobs, get_character_
// contracts) at corp scope instead.
//
// None of this is wired into the ledger/daily-close yet — that's a
// deliberate, separate design decision (does corp data merge into the
// existing character-scoped ledger, or stay a parallel one?), not something
// to resolve by accident while adding read tools.
//
// All of it needs corp-level ESI scopes that aren't in the default login
// scope set yet (see src/auth/oauth.ts's DEFAULT_SCOPES) — every tool here
// degrades gracefully (a clear "re-run esi_login" message, not a crash)
// until that scope grant happens, the same convention already used by
// get_character_blueprints for exactly this situation.
//
// Corp role requirements below are per ESI's documented behavior, NOT
// verified against a live corp-authenticated call (no token has these
// scopes yet) — flagging that plainly rather than asserting false
// confidence. Functionally moot for the character this was built against:
// they're CEO of their corp, which carries every role already.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter, ESI_CACHE_TTL } from "../auth/esi-client.js";
import { enrichTypeName, jsonResult } from "../utils.js";
import { resolveLocations, type ResolvedLocation } from "./structures.js";
import { ACTIVITY_NAMES, type EsiIndustryJob } from "./industry-esi.js";

const CORP_ID_CACHE_TTL = 60 * 60 * 1000; // membership rarely changes; not worth re-checking every call

/** Resolves a character's current corporation — public data, no auth needed. */
async function getCorporationId(characterId: number): Promise<{ corporationId: number; corporationName: string }> {
  const info = await esiGet<{ corporation_id: number }>(`/characters/${characterId}/`, {
    public: true,
    cacheTtlMs: CORP_ID_CACHE_TTL,
  });
  const corp = await esiGet<{ name: string }>(`/corporations/${info.corporation_id}/`, {
    public: true,
    cacheTtlMs: CORP_ID_CACHE_TTL,
  });
  return { corporationId: info.corporation_id, corporationName: corp.name };
}

interface EsiDivision {
  division: number;
  name?: string;
}

/**
 * Division names (wallet or hangar) — optional enrichment, requires
 * esi-corporations.read_divisions.v1 + Director role. Never lets a missing
 * scope break the caller: falls back to an empty map (numeric division IDs
 * shown as-is) rather than guessing a name.
 */
async function getDivisionNames(
  characterId: number,
  corporationId: number,
  kind: "wallet" | "hangar"
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    const divisions = await esiGet<{ wallet?: EsiDivision[]; hangar?: EsiDivision[] }>(
      `/corporations/${corporationId}/divisions/`,
      { characterId, cacheTtlMs: CORP_ID_CACHE_TTL }
    );
    for (const d of divisions[kind] ?? []) {
      if (d.name) names.set(d.division, d.name);
    }
  } catch {
    // Optional enrichment — missing scope/role just means numeric division
    // IDs are shown as-is instead of custom names.
  }
  return names;
}

/**
 * Corp hangar divisions surface on an asset as location_flag "CorpSAG1"
 * through "CorpSAG7" — maps that back to the division's custom name (or
 * null for a non-hangar flag, an out-of-range one, or a division nobody
 * bothered to rename).
 */
export function hangarNameForFlag(flag: string, hangarNames: Map<number, string>): string | null {
  const m = /^CorpSAG(\d)$/.exec(flag);
  return m ? hangarNames.get(Number(m[1])) ?? null : null;
}

const MISSING_SCOPE_HINT =
  "run esi_login to re-authenticate with the new corp scope, then this works. " +
  "Requires the authenticated character to hold the appropriate corp role for this data " +
  "(the exact role is per ESI's documented behavior for this endpoint, not independently verified here).";

function missingScopeResult(what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [
      { type: "text" as const, text: `${what} unavailable: ${msg}. ${MISSING_SCOPE_HINT}` },
    ],
  };
}

export function registerCorporationTools(server: McpServer): void {
  server.tool(
    "get_corporation_wallets",
    "Get all wallet division balances for the authenticated character's corporation (requires esi-wallet.read_corporation_wallets.v1, Accountant or Junior_Accountant role). Corp-scoped counterpart of get_wallet_balance.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted) — the corp is resolved from this character's current membership"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        const wallets = await esiGet<Array<{ division: number; balance: number }>>(
          `/corporations/${corporationId}/wallets/`,
          { characterId: char.characterId }
        );
        const names = await getDivisionNames(char.characterId, corporationId, "wallet");
        return jsonResult({
          corporationId,
          corporationName,
          wallets: wallets
            .sort((a, b) => a.division - b.division)
            .map((w) => ({ division: w.division, name: names.get(w.division) ?? null, balance: w.balance })),
        });
      } catch (err) {
        return missingScopeResult("Corporation wallets", err);
      }
    }
  );

  server.tool(
    "get_corporation_wallet_journal",
    "Get one wallet division's journal (ISK income/expenses log) for the authenticated character's corporation. Requires esi-wallet.read_corporation_wallets.v1, Accountant or Junior_Accountant role. Corp-scoped counterpart of get_wallet_journal — call get_corporation_wallets first if you don't know the division number.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      division: z.number().min(1).max(7).default(1).describe("Wallet division 1-7 (default 1, the master wallet)"),
      ref_type: z.string().optional().describe("Filter by ref_type (e.g. 'brokers_fee', 'transaction_tax', 'market_transaction')"),
      since: z.string().optional().describe("Only return entries after this ISO date (e.g. '2026-07-01')"),
    },
    async ({ character_id, division, ref_type, since }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        let journal = await esiGetAll<{
          id: number;
          date: string;
          ref_type: string;
          amount?: number;
          balance?: number;
          description: string;
          first_party_id?: number;
          second_party_id?: number;
          reason?: string;
        }>(`/corporations/${corporationId}/wallets/${division}/journal/`, {
          characterId: char.characterId,
          cacheTtlMs: ESI_CACHE_TTL,
        });

        if (ref_type) journal = journal.filter((e) => e.ref_type === ref_type);
        if (since) {
          const cutoff = new Date(since).getTime();
          journal = journal.filter((e) => new Date(e.date).getTime() >= cutoff);
        }

        return jsonResult({ corporationId, corporationName, division, entries: journal.length, journal });
      } catch (err) {
        return missingScopeResult("Corporation wallet journal", err);
      }
    }
  );

  server.tool(
    "get_corporation_wallet_transactions",
    "Get one wallet division's recent transactions (market buys/sells) for the authenticated character's corporation, enriched with item names. Requires esi-wallet.read_corporation_wallets.v1, Accountant or Junior_Accountant role. Corp-scoped counterpart of get_wallet_transactions.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      division: z.number().min(1).max(7).default(1).describe("Wallet division 1-7 (default 1, the master wallet)"),
      type_id: z.number().optional().describe("Filter to a specific item type ID"),
      side: z.enum(["buy", "sell"]).optional().describe("Filter to buy or sell transactions only"),
      since: z.string().optional().describe("Only return transactions after this ISO date (e.g. '2026-07-01')"),
    },
    async ({ character_id, division, type_id, side, since }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        let transactions = await esiGet<
          Array<{
            transaction_id: number;
            date: string;
            type_id: number;
            quantity: number;
            unit_price: number;
            client_id: number;
            location_id: number;
            is_buy: boolean;
          }>
        >(`/corporations/${corporationId}/wallets/${division}/transactions/`, {
          characterId: char.characterId,
          cacheTtlMs: ESI_CACHE_TTL,
        });

        if (type_id) transactions = transactions.filter((t) => t.type_id === type_id);
        if (side) transactions = transactions.filter((t) => (side === "buy" ? t.is_buy : !t.is_buy));
        if (since) {
          const cutoff = new Date(since).getTime();
          transactions = transactions.filter((t) => new Date(t.date).getTime() >= cutoff);
        }

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

        return jsonResult({ corporationId, corporationName, division, count: enriched.length, transactions: enriched });
      } catch (err) {
        return missingScopeResult("Corporation wallet transactions", err);
      }
    }
  );

  server.tool(
    "get_corporation_assets",
    "Get assets (items in hangars/containers/structures) for the authenticated character's corporation, enriched with item names. Requires esi-assets.read_corporation_assets.v1, Director role. Corp-scoped counterpart of get_character_assets.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_name: z.string().optional().describe("Filter assets by item name"),
      location_id: z.number().optional().describe("Filter by location ID"),
    },
    async ({ character_id, type_name, location_id }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        const assets = await esiGetAll<{
          item_id: number;
          type_id: number;
          location_id: number;
          location_type: string;
          quantity: number;
          location_flag: string;
          is_singleton: boolean;
        }>(`/corporations/${corporationId}/assets/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

        const db = getDatabase();
        const hangarNames = await getDivisionNames(char.characterId, corporationId, "hangar");

        let enriched = assets.map((a) => ({
          itemId: a.item_id,
          typeName: enrichTypeName(db, a.type_id),
          typeId: a.type_id,
          quantity: a.quantity,
          locationId: a.location_id,
          locationType: a.location_type,
          locationFlag: a.location_flag,
          hangarName: hangarNameForFlag(a.location_flag, hangarNames),
          isSingleton: a.is_singleton,
        }));

        if (type_name) {
          enriched = enriched.filter((a) => a.typeName.toLowerCase().includes(type_name.toLowerCase()));
        }
        if (location_id) {
          enriched = enriched.filter((a) => a.locationId === location_id);
        }

        const uniqueLocationIds = [...new Set(assets.map((a) => a.location_id))];
        const locations = await resolveLocations(char.characterId, uniqueLocationIds);
        const locationMap: Record<string, ResolvedLocation> = {};
        for (const [id, info] of locations) locationMap[id] = info;
        enriched = enriched.map((a) => ({ ...a, locationName: locationMap[String(a.locationId)]?.name ?? null }));

        return jsonResult({
          corporationId,
          corporationName,
          assetCount: enriched.length,
          locations: Object.values(locationMap),
          assets: enriched,
        });
      } catch (err) {
        return missingScopeResult("Corporation assets", err);
      }
    }
  );

  server.tool(
    "get_corporation_blueprints",
    "List the corporation's blueprints with Material Efficiency, Time Efficiency, and runs (BPO vs BPC). Requires esi-corporations.read_blueprints.v1, Director role. Corp-scoped counterpart of get_character_blueprints — a corp-owned BPO used for a job is invisible to the BOM ledger's ME auto-resolution today, which only checks the character's own synced blueprints.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      const db = getDatabase();
      try {
        const bps = await esiGetAll<{
          item_id: number;
          type_id: number;
          location_id?: number;
          location_flag?: string;
          quantity?: number;
          material_efficiency?: number;
          time_efficiency?: number;
          runs?: number;
        }>(`/corporations/${corporationId}/blueprints/`, { characterId: char.characterId });

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

        return jsonResult({ corporationId, corporationName, blueprintCount: enriched.length, blueprints: enriched });
      } catch (err) {
        return missingScopeResult("Corporation blueprints", err);
      }
    }
  );

  server.tool(
    "get_corporation_industry_jobs",
    "Get active and recent industry jobs run by any member under the corporation — manufacturing, research, invention, reactions. Requires esi-industry.read_corporation_jobs.v1, Factory_Manager role. Corp-scoped counterpart of get_industry_jobs; a job installed under the corp is invisible to the character-scoped daily close today.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      include_completed: z.boolean().default(false).describe("Include completed jobs"),
      activity: z.string().optional().describe("Filter by activity name (e.g. 'Manufacturing', 'Invention', 'Reaction')"),
      status: z.enum(["active", "cancelled", "delivered", "paused", "ready"]).optional().describe("Filter by job status"),
    },
    async ({ character_id, include_completed, activity, status }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        let url = `/corporations/${corporationId}/industry/jobs/`;
        if (include_completed) url += "?include_completed=true";

        const jobs = await esiGetAll<EsiIndustryJob>(url, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

        const db = getDatabase();
        let enriched = jobs.map((j) => ({
          jobId: j.job_id,
          installerId: j.installer_id, // which corp member installed it — meaningful at corp scope, unlike the character version
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

        const facilityIds = [...new Set(jobs.map((j) => j.facility_id))];
        const locations = await resolveLocations(char.characterId, facilityIds);
        enriched = enriched.map((j) => ({
          ...j,
          facilityName: locations.get(String(j.facilityId))?.name ?? null,
        }));

        return jsonResult({ corporationId, corporationName, jobCount: enriched.length, jobs: enriched });
      } catch (err) {
        return missingScopeResult("Corporation industry jobs", err);
      }
    }
  );

  server.tool(
    "get_corporation_contracts",
    "Get contracts issued by or assigned to the authenticated character's corporation — courier, item exchange, and auction. Requires esi-contracts.read_corporation_contracts.v1. Corp-scoped counterpart of get_character_contracts; pairs with search_public_contracts (which searches everyone's public contracts region-wide, not just this corp's own).",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type: z.enum(["unknown", "item_exchange", "auction", "courier"]).optional().describe("Filter by contract type"),
      status: z.enum(["outstanding", "in_progress", "finished_issuer", "finished_contractor", "finished", "cancelled", "rejected", "failed", "deleted", "reversed"]).optional().describe("Filter by contract status"),
    },
    async ({ character_id, type, status }) => {
      const char = await getActiveCharacter(character_id);
      const { corporationId, corporationName } = await getCorporationId(char.characterId);
      try {
        let contracts = await esiGetAll<{
          contract_id: number;
          issuer_id: number;
          issuer_corporation_id: number;
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
        }>(`/corporations/${corporationId}/contracts/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

        if (type) contracts = contracts.filter((c) => c.type === type);
        if (status) contracts = contracts.filter((c) => c.status === status);

        return jsonResult({ corporationId, corporationName, contractCount: contracts.length, contracts });
      } catch (err) {
        return missingScopeResult("Corporation contracts", err);
      }
    }
  );
}
