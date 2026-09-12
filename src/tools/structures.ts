// Player-structure resolution: ESI industry jobs and assets carry facility
// / location ids for Upwell structures (citadels, engineering complexes) that
// the SDE knows nothing about — born from the 2026-09 report that jobs
// showed bare structure ids (1051816770275 etc.) with no way to answer
// "what IS this facility and where is it".
//
// Resolution chain per location id:
//   - SDE staStations (NPC stations: 60003760 etc.) — name + system, no ESI
//   - ESI /universe/structures/{id}/ (Upwell structures, requires
//     esi-universe.read_structures.v1 + docking access) — name, type,
//     solar system; cached a day per structure
//
// Failures (403 without the scope or docking rights, network) resolve to
// null entries — never guessed.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, getActiveCharacter } from "../auth/esi-client.js";
import { jsonResult } from "../utils.js";

export interface ResolvedLocation {
  locationId: string;
  /** "sde-station" (NPC) or "esi-structure" (Upwell) or "unknown". */
  source: "sde-station" | "esi-structure" | "unknown";
  name: string | null;
  typeId: number | null;
  solarSystemId: number | null;
  systemName: string | null;
}

interface StationRow {
  stationName: string;
  solarSystemID: number;
}

interface StructureRow {
  stationID: number;
  stationName: string;
  solarSystemID: number;
}

export function systemNameOf(db: ReturnType<typeof getDatabase>, solarSystemId: number): string | null {
  const row = db
    .prepare(`SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?`)
    .get(solarSystemId) as { solarSystemName: string } | undefined;
  return row?.solarSystemName ?? null;
}

/**
 * Resolve a batch of location ids (stations and/or structure ids) to names
 * and systems. NPC stations come from the SDE; player structures from ESI
 * (esi-universe.read_structures.v1 — granted on the next login if the token
 * predates the scope; missing scope or docking rights yields nulls, not
 * guesses).
 */
export async function resolveLocations(
  characterId: number | undefined,
  locationIds: Array<string | number>
): Promise<Map<string, ResolvedLocation>> {
  const db = getDatabase();
  const out = new Map<string, ResolvedLocation>();

  const stationStmt = db.prepare(
    `SELECT stationName, solarSystemID FROM staStations WHERE stationID = ?`
  );

  const structureIds: string[] = [];
  for (const id of locationIds) {
    const key = String(id);
    if (out.has(key)) continue;
    const numeric = Number(id);
    const station = stationStmt.get(numeric) as StationRow | undefined;
    if (station) {
      out.set(key, {
        locationId: key,
        source: "sde-station",
        name: station.stationName,
        typeId: null,
        solarSystemId: station.solarSystemID,
        systemName: systemNameOf(db, station.solarSystemID),
      });
    } else {
      // Not an NPC station: a player structure (or an unresolvable id)
      out.set(key, {
        locationId: key,
        source: "unknown",
        name: null,
        typeId: null,
        solarSystemId: null,
        systemName: null,
      });
      structureIds.push(key);
    }
  }

  if (structureIds.length > 0) {
    const char = await getActiveCharacter(characterId);
    await Promise.all(
      structureIds.map(async (id) => {
        try {
          const info = await esiGet<{ name: string; solar_system_id: number; type_id: number; position?: { x: number; y: number; z: number } }>(
            `/universe/structures/${id}/`,
            { characterId: char.characterId, cacheTtlMs: 24 * 60 * 60 * 1000 }
          );
          out.set(id, {
            locationId: id,
            source: "esi-structure",
            name: info.name,
            typeId: info.type_id ?? null,
            solarSystemId: info.solar_system_id ?? null,
            systemName: info.solar_system_id ? systemNameOf(db, info.solar_system_id) : null,
          });
        } catch (err) {
          // Missing scope, no docking rights, or fetch failure — leave the
          // unknown placeholder; the caller surfaces the reason.
          process.stderr.write(`[structures] ${id} unresolved: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      })
    );
  }

  return out;
}

export function registerStructureTools(server: McpServer): void {
  server.tool(
    "get_structure",
    "Resolve a station or player-structure id to its name, solar system, and structure type — the missing link for ESI facility/location ids (industry jobs, assets) that reference Upwell citadels and engineering complexes the SDE doesn't know. NPC stations resolve from the SDE; player structures via authenticated ESI (requires esi-universe.read_structures.v1, granted on the next esi_login after the scope was added; also needs docking access to the structure). Also reports the facility's system industry cost indices when resolvable.",
    {
      structure_id: z.string().regex(/^\d+$/).describe("Station or structure ID (numeric string — 64-bit structure IDs exceed JS number precision). Example: 1051816770275 from an industry job's facility_id"),
      character_id: z.number().optional().describe("Character ID for the authenticated structure lookup (uses active character if omitted)"),
    },
    async ({ structure_id, character_id }) => {
      const resolved = await resolveLocations(character_id, [structure_id]);
      const info = resolved.get(structure_id);

      if (!info || info.source === "unknown") {
        return {
          content: [
            {
              type: "text",
              text: `Could not resolve ${structure_id}: not an SDE NPC station, and the ESI structure lookup failed (missing esi-universe.read_structures.v1 scope — run esi_login — no docking rights, or the structure id is invalid).`,
            },
          ],
        };
      }

      const db = getDatabase();
      let typeName: string | null = null;
      if (info.typeId !== null) {
        const row = db.prepare(`SELECT typeName FROM invTypes WHERE typeID = ?`).get(info.typeId) as
          | { typeName: string }
          | undefined;
        typeName = row?.typeName ?? null;
      }

      // Industry cost indices for the facility's system — the natural next
      // question ("what does it cost to build/research there")
      let costIndices: Array<{ activity: string; cost_index: number }> | null = null;
      if (info.solarSystemId !== null) {
        try {
          const systems = await esiGet<Array<{
            solar_system_id: number;
            cost_indices: Array<{ activity: string; cost_index: number }>;
          }>>(`/industry/systems/`, { public: true, cacheTtlMs: 10 * 60 * 1000 });
          const entry = systems.find((s) => s.solar_system_id === info.solarSystemId);
          if (entry) costIndices = entry.cost_indices;
        } catch {
          // optional enrichment — ignore failures
        }
      }

      return jsonResult({
        locationId: info.locationId,
        source: info.source,
        name: info.name,
        typeId: info.typeId,
        typeName,
        solarSystemId: info.solarSystemId,
        systemName: info.systemName,
        costIndices,
      });
    }
  );
}
