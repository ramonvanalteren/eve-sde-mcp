import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, getActiveCharacter } from "../auth/esi-client.js";
import { getSlotType } from "../fitting/eft.js";
import { enrichTypeName, enrichSystemName, jsonResult } from "../utils.js";

interface EsiKillmailRef {
  killmail_id: number;
  killmail_hash: string;
}

interface EsiKillmailDetail {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  moon_id?: number;
  war_id?: number;
  victim: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    faction_id?: number;
    ship_type_id: number;
    damage_taken: number;
    position?: { x: number; y: number; z: number };
    items?: Array<{
      item_type_id: number;
      flag: number;
      quantity_destroyed?: number;
      quantity_dropped?: number;
      singleton: number;
    }>;
  };
  attackers: Array<{
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    faction_id?: number;
    ship_type_id?: number;
    weapon_type_id?: number;
    damage_done: number;
    final_blow: boolean;
    security_status: number;
  }>;
}

const FLAG_NAMES: Record<number, string> = {
  5: "Cargo",
  11: "LoSlot0", 12: "LoSlot1", 13: "LoSlot2", 14: "LoSlot3",
  15: "LoSlot4", 16: "LoSlot5", 17: "LoSlot6", 18: "LoSlot7",
  19: "MedSlot0", 20: "MedSlot1", 21: "MedSlot2", 22: "MedSlot3",
  23: "MedSlot4", 24: "MedSlot5", 25: "MedSlot6", 26: "MedSlot7",
  27: "HiSlot0", 28: "HiSlot1", 29: "HiSlot2", 30: "HiSlot3",
  31: "HiSlot4", 32: "HiSlot5", 33: "HiSlot6", 34: "HiSlot7",
  87: "DroneBay",
  92: "RigSlot0", 93: "RigSlot1", 94: "RigSlot2",
  125: "SubSystemSlot0", 126: "SubSystemSlot1", 127: "SubSystemSlot2", 128: "SubSystemSlot3",
  158: "FighterBay",
  164: "Implant",
};

function enrichTypeNameOptional(db: ReturnType<typeof getDatabase>, typeId: number | undefined): string | undefined {
  if (!typeId) return undefined;
  return enrichTypeName(db, typeId);
}

export function registerKillmailTools(server: McpServer): void {
  server.tool(
    "get_recent_killmails",
    "Get the authenticated character's recent kills and losses. Returns killmail IDs and hashes — use get_killmail for full details.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const refs = await esiGet<EsiKillmailRef[]>(
        `/characters/${char.characterId}/killmails/recent/`,
        { characterId: char.characterId }
      );

      return jsonResult({
        characterName: char.characterName,
        count: refs.length,
        killmails: refs,
      });
    }
  );

  server.tool(
    "get_killmail",
    "Get full killmail details including victim fitting, attackers, and location. Enriches all type IDs with names from the SDE. Public endpoint — needs killmail_id and killmail_hash (from get_recent_killmails or a killmail link).",
    {
      killmail_id: z.number().describe("Killmail ID"),
      killmail_hash: z.string().describe("Killmail hash"),
    },
    async ({ killmail_id, killmail_hash }) => {
      const km = await esiGet<EsiKillmailDetail>(
        `/killmails/${killmail_id}/${killmail_hash}/`,
        { public: true }
      );

      const db = getDatabase();

      const victimItems = (km.victim.items ?? []).map((item) => ({
        typeName: enrichTypeName(db, item.item_type_id),
        typeId: item.item_type_id,
        slot: FLAG_NAMES[item.flag] ?? `Flag${item.flag}`,
        quantityDestroyed: item.quantity_destroyed ?? 0,
        quantityDropped: item.quantity_dropped ?? 0,
      }));

      const fitted: Record<string, typeof victimItems> = {};
      for (const item of victimItems) {
        const category = item.slot.replace(/\d+$/, "");
        if (!fitted[category]) fitted[category] = [];
        fitted[category].push(item);
      }

      const enrichedAttackers = km.attackers.map((a) => ({
        shipName: enrichTypeNameOptional(db, a.ship_type_id),
        shipTypeId: a.ship_type_id,
        weaponName: enrichTypeNameOptional(db, a.weapon_type_id),
        weaponTypeId: a.weapon_type_id,
        damageDone: a.damage_done,
        finalBlow: a.final_blow,
        securityStatus: a.security_status,
        characterId: a.character_id,
        corporationId: a.corporation_id,
        allianceId: a.alliance_id,
        factionId: a.faction_id,
      }));

      return jsonResult({
        killmailId: km.killmail_id,
        time: km.killmail_time,
        system: enrichSystemName(db, km.solar_system_id),
        systemId: km.solar_system_id,
        victim: {
          shipName: enrichTypeName(db, km.victim.ship_type_id),
          shipTypeId: km.victim.ship_type_id,
          damageTaken: km.victim.damage_taken,
          characterId: km.victim.character_id,
          corporationId: km.victim.corporation_id,
          allianceId: km.victim.alliance_id,
          fittedItems: fitted,
        },
        attackers: enrichedAttackers,
        attackerCount: km.attackers.length,
      });
    }
  );

  server.tool(
    "killmail_to_eft",
    "Reconstruct the victim's fit from a killmail as EFT text — including both destroyed and dropped items — ready to feed into check_fitting (exact budget analysis), price_fitting, or save_fitting. Use this when reviewing a loss (what was flown, what actually fit, what to improve) or studying a kill for doctrine ideas. Loaded charges are re-attached to their module ('Module, Charge') via the slot flag they share in the killmail.",
    {
      killmail_id: z.number().describe("Killmail ID (from get_recent_killmails or zkillboard)"),
      killmail_hash: z.string().describe("Killmail hash (from get_recent_killmails or zkillboard)"),
      fit_name: z.string().optional().describe("Name for the reconstructed fit (default: '<Ship> — killmail fit')"),
    },
    async ({ killmail_id, killmail_hash, fit_name }) => {
      const km = await esiGet<EsiKillmailDetail>(
        `/killmails/${killmail_id}/${killmail_hash}/`,
        { public: true }
      );

      const db = getDatabase();
      const shipName = enrichTypeName(db, km.victim.ship_type_id);
      const name = fit_name ?? `${shipName} — killmail fit`;

      interface KItem { typeName: string; typeId: number; flagName: string; qty: number; }
      const all: KItem[] = [];
      const dropped = km.victim.items ?? [];
      const notes: string[] = [];
      for (const item of dropped) {
        const qty = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
        if (qty <= 0) continue;
        const flagName = FLAG_NAMES[item.flag] ?? `Flag${item.flag}`;
        if (flagName === "Implant") continue;
        all.push({
          typeName: enrichTypeName(db, item.item_type_id),
          typeId: item.item_type_id,
          flagName,
          qty,
        });
      }
      if (dropped.length > 0) notes.push("Reconstructed from destroyed + dropped items — a dropped-only list would be the surviving half.");

      const lines: string[] = [`[${shipName}, ${name}]`];
      const slotOrder = ["SubSystemSlot", "HiSlot", "MedSlot", "LoSlot", "RigSlot"];
      const slotItems = new Map<string, KItem[]>();
      for (const it of all) {
        const m = it.flagName.match(/^(SubSystemSlot|HiSlot|MedSlot|LoSlot|RigSlot)(\d+)$/);
        if (m) {
          const key = m[1] + String(m[2]).padStart(2, "0");
          if (!slotItems.has(key)) slotItems.set(key, []);
          slotItems.get(key)!.push(it);
        }
      }
      const slotRe = /^(SubSystemSlot|HiSlot|MedSlot|LoSlot|RigSlot)(\d+)$/;
      const flagLabel = (key: string): string => {
        const m = key.match(slotRe);
        if (!m) return key;
        return m[1] + m[2];
      };
      const keys = [...slotItems.keys()].sort((a, b) => {
        const ai = slotOrder.indexOf(a.replace(/\d\d$/, ""));
        const bi = slotOrder.indexOf(b.replace(/\d\d$/, ""));
        return ai - bi || a.localeCompare(b);
      });
      for (const key of keys) {
        const items = slotItems.get(key)!;
        const modules = items.filter((it) => getSlotType(db, it.typeId) !== "cargo");
        const charges = items.filter((it) => getSlotType(db, it.typeId) === "cargo");
        for (const mod of modules) {
          const charge = charges[0];
          lines.push(charge ? `${mod.typeName}, ${charge.typeName}` : mod.typeName);
          if (charge) charges.shift();
        }
        for (const charge of charges) lines.push(`${charge.typeName} x${charge.qty}`);
      }
      for (const it of all.filter((x) => x.flagName === "DroneBay")) lines.push(`${it.typeName} x${it.qty}`);
      for (const it of all.filter((x) => x.flagName === "Cargo")) lines.push(`${it.typeName} x${it.qty}`);
      const other = all.filter((x) => !slotRe.test(x.flagName) && !["DroneBay", "Cargo"].includes(x.flagName));
      for (const it of other) lines.push(`// ${it.typeName} x${it.qty} (${flagLabel(it.flagName)})`);

      return jsonResult({
        killmailId: killmail_id,
        ship: shipName,
        fitName: name,
        eft: lines.join("\n"),
        itemCount: all.length,
        notes,
      });
    }
  );
}
