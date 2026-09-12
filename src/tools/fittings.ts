import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGetAll, esiPost, esiDelete, getActiveCharacter } from "../auth/esi-client.js";
import { enrichTypeName, jsonResult } from "../utils.js";
import { parseEftFormat, type FittingItem } from "../fitting/eft.js";
import { resolveBudgetInputs, fetchBudgetSkillLevels, BUDGET_SKILLS } from "../fitting/resolve.js";
import { computeFittingBudget } from "../fitting/budget.js";

interface EsiFitting {
  fitting_id: number;
  name: string;
  description: string;
  ship_type_id: number;
  items: Array<{
    type_id: number;
    flag: string;
    quantity: number;
  }>;
}

export function registerFittingTools(server: McpServer): void {
  server.tool(
    "get_fittings",
    "Get all saved fittings for the authenticated character, enriched with ship and module names from the SDE.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      ship_name: z.string().optional().describe("Filter fittings by ship name"),
    },
    async ({ character_id, ship_name }) => {
      const char = await getActiveCharacter(character_id);
      const fittings = await esiGetAll<EsiFitting>(
        `/characters/${char.characterId}/fittings/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      let enriched = fittings.map((f) => ({
        fittingId: f.fitting_id,
        name: f.name,
        description: f.description,
        shipName: enrichTypeName(db, f.ship_type_id),
        shipTypeId: f.ship_type_id,
        items: f.items.map((item) => ({
          typeName: enrichTypeName(db, item.type_id),
          typeId: item.type_id,
          flag: item.flag,
          quantity: item.quantity,
        })),
      }));

      if (ship_name) {
        enriched = enriched.filter((f) =>
          f.shipName.toLowerCase().includes(ship_name.toLowerCase())
        );
      }

      return jsonResult({ characterName: char.characterName, fittingCount: enriched.length, fittings: enriched });
    }
  );

  server.tool(
    "save_fitting",
    "Save a fitting to the authenticated character's in-game fitting list. Accepts either EFT format (the standard Eve copy/paste format) or structured input. The fitting appears in-game immediately. This is a WRITE operation.",
    {
      eft: z
        .string()
        .optional()
        .describe(
          'EFT format fitting string, e.g.:\n[Rifter, My Fit]\n200mm AutoCannon II\n200mm AutoCannon II\n1MN Afterburner II\nDamage Control II\nSmall Projectile Burst Aerator I'
        ),
      name: z.string().optional().describe("Fitting name (required if not using EFT format)"),
      description: z.string().default("").describe("Fitting description"),
      ship_type_id: z.number().optional().describe("Ship type ID (required if not using EFT format)"),
      items: z
        .array(
          z.object({
            type_id: z.number(),
            flag: z.string(),
            quantity: z.number().default(1),
          })
        )
        .optional()
        .describe("Fitting items array (required if not using EFT format)"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ eft, name, description, ship_type_id, items, character_id }) => {
      const db = getDatabase();
      let fitName: string;
      let fitDescription: string = description;
      let fitShipTypeId: number;
      let fitItems: FittingItem[];

      if (eft) {
        const parsed = parseEftFormat(db, eft);
        if (parsed.errors.length > 0 && parsed.items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to parse EFT format:\n${parsed.errors.join("\n")}`,
              },
            ],
          };
        }

        fitName = name ?? parsed.fitName;
        fitShipTypeId = parsed.shipTypeId;
        fitItems = parsed.items;

        if (parsed.warnings.length > 0) {
          process.stderr.write(`Warnings (some items skipped):\n${parsed.warnings.join("\n")}\n\n`);
        }
      } else {
        if (!name || !ship_type_id || !items || items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Provide either an EFT format string, or name + ship_type_id + items.",
              },
            ],
          };
        }
        fitName = name;
        fitShipTypeId = ship_type_id;
        // Structured input lacks name/offline metadata — fill neutral values
        fitItems = items.map((it) => ({
          type_id: it.type_id,
          name: enrichTypeName(db, it.type_id),
          flag: it.flag,
          quantity: it.quantity,
          offline: false,
        }));
      }

      const char = await getActiveCharacter(character_id);

      const body = {
        name: fitName,
        description: fitDescription,
        ship_type_id: fitShipTypeId,
        items: fitItems,
      };

      const result = await esiPost<{ fitting_id: number }>(
        `/characters/${char.characterId}/fittings/`,
        body,
        { characterId: char.characterId }
      );

      const itemSummary = fitItems.map((item) => ({
        name: enrichTypeName(db, item.type_id),
        flag: item.flag,
        quantity: item.quantity,
      }));

      return jsonResult({
        success: true,
        fittingId: result.fitting_id,
        name: fitName,
        ship: enrichTypeName(db, fitShipTypeId),
        characterName: char.characterName,
        itemCount: fitItems.length,
        items: itemSummary,
      });
    }
  );

  server.tool(
    "delete_fitting",
    "Delete a saved fitting from the authenticated character. This is a WRITE operation.",
    {
      fitting_id: z.number().describe("The fitting_id to delete (from get_fittings)"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ fitting_id, character_id }) => {
      const char = await getActiveCharacter(character_id);

      await esiDelete(
        `/characters/${char.characterId}/fittings/${fitting_id}/`,
        { characterId: char.characterId }
      );

      return {
        content: [
          {
            type: "text",
            text: `Fitting ${fitting_id} deleted from ${char.characterName}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "parse_eft",
    "Parse an EFT format fitting string and show what would be saved — resolves all item names to type IDs and slot flags. Does NOT save anything. Use this to preview before calling save_fitting.",
    {
      eft: z.string().describe("EFT format fitting string"),
    },
    async ({ eft }) => {
      const db = getDatabase();
      const parsed = parseEftFormat(db, eft);

      const itemDetails = parsed.items.map((item) => ({
        name: enrichTypeName(db, item.type_id),
        typeId: item.type_id,
        flag: item.flag,
        quantity: item.quantity,
      }));

      return jsonResult({
        shipName: parsed.shipName,
        shipTypeId: parsed.shipTypeId,
        fitName: parsed.fitName,
        itemCount: parsed.items.length,
        items: itemDetails,
        errors: parsed.errors.length > 0 ? parsed.errors : undefined,
        valid: parsed.errors.length === 0 && parsed.items.length > 0,
      });
    }
  );

  server.tool(
    "check_fitting",
    "Check whether an EFT-format fit actually fits: exact CPU/powergrid/calibration budgets, slot counts, turret/launcher hardpoints, and drone bay/bandwidth, with the well-defined skill effects applied (CPU Management +5% output/lvl, Power Grid Management +5% output/lvl, Weapon Upgrades -5% turret+launcher CPU/lvl, Advanced Weapon Upgrades -2% turret+launcher PG/lvl, weapon-rig PG drawbacks). Skills default to the character's trained ESI levels; pass `skills` overrides for what-if (e.g. {'Weapon Upgrades': 4}). Deliberately NOT a full dogma engine — implants/boosters/overheat/command bursts, Electronics Upgrades reductions, T3 subsystem output, stacking penalties, capacitor, and DPS/EHP are unmodeled (pyfa's eos is the reference for those) — everything unmodeled is listed in the report. Use this instead of hand-math before recommending or saving a fit; the in-game fitting window remains ground truth.",
    {
      eft: z.string().describe("EFT format fitting string"),
      character_id: z.number().optional().describe("Character ID for skill levels (uses active character if omitted)"),
      skills: z
        .record(z.string(), z.number())
        .optional()
        .describe("Skill level overrides by name for what-if checks, e.g. {'Weapon Upgrades': 4, 'CPU Management': 5}"),
    },
    async ({ eft, character_id, skills }) => {
      const db = getDatabase();
      const parsed = parseEftFormat(db, eft);
      if (parsed.errors.length > 0) {
        return jsonResult({ valid: false, errors: parsed.errors });
      }

      let levels;
      let skillSource;
      try {
        const fetched = await fetchBudgetSkillLevels(db, character_id);
        levels = fetched.levels;
        skillSource = fetched.source;
      } catch (err) {
        levels = { cpuManagement: 0, powerGridManagement: 0, weaponUpgrades: 0, advancedWeaponUpgrades: 0 };
        skillSource = `character skills unavailable (${err instanceof Error ? err.message : String(err)}) — all levels 0; pass the skills param for a what-if`;
      }
      if (skills) {
        const nameToKey = new Map<string, string>(Object.entries(BUDGET_SKILLS).map(([k, v]) => [v, k]));
        for (const [name, lvl] of Object.entries(skills)) {
          const key = nameToKey.get(name);
          if (key) {
            levels = { ...levels, [key]: lvl } as typeof levels;
          } else {
            parsed.warnings.push(`Unknown skill override "${name}" ignored (known: ${Object.values(BUDGET_SKILLS).join(", ")})`);
          }
        }
        skillSource += ` + overrides: ${Object.entries(skills).map(([n, l]) => `${n} ${l}`).join(", ")}`;
      }

      const resolved = resolveBudgetInputs(db, parsed);
      const report = computeFittingBudget(resolved.hull, resolved.items, resolved.drones, levels);

      return jsonResult({
        ship: resolved.hull.name,
        fitName: parsed.fitName,
        skillSource,
        appliedSkills: report.appliedSkills,
        fits: report.fits,
        violations: report.violations.length > 0 ? report.violations : undefined,
        cpu: report.cpu,
        power: report.power,
        calibration: report.calibration,
        slots: report.slots,
        hardpoints: report.hardpoints,
        drones: report.drones,
        offline: report.offline.length > 0 ? report.offline : undefined,
        unmodeled: report.unmodeled,
        warnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
        notes: resolved.notes.length > 0 ? resolved.notes : undefined,
      });
    }
  );
}
