import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, getActiveCharacter } from "../auth/esi-client.js";

// ESI slot effect IDs from dgmEffects
const SLOT_EFFECT_IDS: Record<number, string> = {
  12: "hi",
  13: "med",
  11: "lo",
  2663: "rig",
  3772: "sub",
  6306: "service",
};

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

interface FittingItem {
  type_id: number;
  flag: string;
  quantity: number;
}

function enrichTypeName(db: ReturnType<typeof getDatabase>, typeId: number): string {
  const row = db.prepare("SELECT typeName FROM invTypes WHERE typeID = ?").get(typeId) as
    | { typeName: string }
    | undefined;
  return row?.typeName ?? `Unknown(${typeId})`;
}

function resolveTypeId(db: ReturnType<typeof getDatabase>, name: string): number | null {
  const trimmed = name.trim();
  // Exact match first
  let row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  // Case-insensitive
  row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? COLLATE NOCASE AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  return null;
}

function getSlotType(db: ReturnType<typeof getDatabase>, typeId: number): string | null {
  const effects = db
    .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
    .all(typeId) as { effectID: number }[];

  for (const e of effects) {
    if (SLOT_EFFECT_IDS[e.effectID]) return SLOT_EFFECT_IDS[e.effectID];
  }

  // Check if it's a drone, charge, or fighter by category
  const cat = db
    .prepare(
      `SELECT c.categoryName FROM invTypes t
       JOIN invGroups g ON t.groupID = g.groupID
       JOIN invCategories c ON g.categoryID = c.categoryID
       WHERE t.typeID = ?`
    )
    .get(typeId) as { categoryName: string } | undefined;

  if (cat) {
    if (cat.categoryName === "Drone") return "drone";
    if (cat.categoryName === "Fighter") return "fighter";
    if (cat.categoryName === "Charge") return "cargo";
  }

  return null;
}

interface ParsedEft {
  shipName: string;
  shipTypeId: number;
  fitName: string;
  items: FittingItem[];
  errors: string[];
}

function parseEftFormat(db: ReturnType<typeof getDatabase>, eft: string): ParsedEft {
  const lines = eft.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const errors: string[] = [];
  const items: FittingItem[] = [];

  // First line: [Ship Name, Fit Name]
  const headerMatch = lines[0]?.match(/^\[(.+?),\s*(.+)\]$/);
  if (!headerMatch) {
    return { shipName: "", shipTypeId: 0, fitName: "", items: [], errors: ["Invalid EFT header. Expected: [Ship Name, Fit Name]"] };
  }

  const shipName = headerMatch[1].trim();
  const fitName = headerMatch[2].trim();
  const shipTypeId = resolveTypeId(db, shipName);
  if (!shipTypeId) {
    return { shipName, shipTypeId: 0, fitName, items: [], errors: [`Ship "${shipName}" not found in SDE`] };
  }

  // Track slot counters
  const slotCounters: Record<string, number> = { hi: 0, med: 0, lo: 0, rig: 0, sub: 0, service: 0 };
  const FLAG_PREFIX: Record<string, string> = {
    hi: "HiSlot",
    med: "MedSlot",
    lo: "LoSlot",
    rig: "RigSlot",
    sub: "SubSystemSlot",
    service: "ServiceSlot",
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Empty lines (after filtering) or section dividers
    if (line === "" || line === "---") {
      continue;
    }

    // Detect section changes from blank lines in original
    // EFT format: hi slots, then blank, med slots, blank, lo slots, blank, rig slots, blank, drones, blank, cargo
    // We detect drones/cargo by category rather than position

    // Parse "Item Name x2" or "Item Name" format
    const quantityMatch = line.match(/^(.+?)\s+x(\d+)$/);
    const itemName = quantityMatch ? quantityMatch[1].trim() : line;
    const quantity = quantityMatch ? parseInt(quantityMatch[2], 10) : 1;

    // Skip "[Empty ...]" slots
    if (itemName.startsWith("[Empty")) continue;

    const typeId = resolveTypeId(db, itemName);
    if (!typeId) {
      errors.push(`Item "${itemName}" not found in SDE`);
      continue;
    }

    const slotType = getSlotType(db, typeId);

    if (!slotType) {
      errors.push(`Could not determine slot type for "${itemName}"`);
      continue;
    }

    if (slotType === "drone") {
      items.push({ type_id: typeId, flag: "DroneBay", quantity });
    } else if (slotType === "fighter") {
      items.push({ type_id: typeId, flag: "FighterBay", quantity });
    } else if (slotType === "cargo") {
      items.push({ type_id: typeId, flag: "Cargo", quantity });
    } else {
      const prefix = FLAG_PREFIX[slotType];
      const idx = slotCounters[slotType]!;
      items.push({ type_id: typeId, flag: `${prefix}${idx}`, quantity });
      slotCounters[slotType]!++;
    }
  }

  return { shipName, shipTypeId, fitName, items, errors };
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
      const fittings = await esiGet<EsiFitting[]>(
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { characterName: char.characterName, fittingCount: enriched.length, fittings: enriched },
              null,
              2
            ),
          },
        ],
      };
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

        if (parsed.errors.length > 0) {
          // Partial parse — warn but continue
          const warningText = `Warnings (some items skipped):\n${parsed.errors.join("\n")}\n\n`;
          // Continue with successfully parsed items
          process.stderr.write(warningText);
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
        fitItems = items;
      }

      const char = await getActiveCharacter(character_id);

      const body = {
        name: fitName,
        description: fitDescription,
        ship_type_id: fitShipTypeId,
        items: fitItems,
      };

      // POST to ESI
      const url = `https://esi.evetech.net/latest/characters/${char.characterId}/fittings/`;
      const { token } = await getValidTokenForPost(char.characterId);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        return {
          content: [
            { type: "text", text: `Failed to save fitting (${response.status}): ${errBody}` },
          ],
        };
      }

      const result = (await response.json()) as { fitting_id: number };

      // Build a summary of what was saved
      const itemSummary = fitItems.map((item) => ({
        name: enrichTypeName(db, item.type_id),
        flag: item.flag,
        quantity: item.quantity,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                fittingId: result.fitting_id,
                name: fitName,
                ship: enrichTypeName(db, fitShipTypeId),
                characterName: char.characterName,
                itemCount: fitItems.length,
                items: itemSummary,
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
    "delete_fitting",
    "Delete a saved fitting from the authenticated character. This is a WRITE operation.",
    {
      fitting_id: z.number().describe("The fitting_id to delete (from get_fittings)"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ fitting_id, character_id }) => {
      const char = await getActiveCharacter(character_id);
      const { token } = await getValidTokenForPost(char.characterId);

      const url = `https://esi.evetech.net/latest/characters/${char.characterId}/fittings/${fitting_id}/`;
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        return {
          content: [
            { type: "text", text: `Failed to delete fitting (${response.status}): ${errBody}` },
          ],
        };
      }

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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                shipName: parsed.shipName,
                shipTypeId: parsed.shipTypeId,
                fitName: parsed.fitName,
                itemCount: parsed.items.length,
                items: itemDetails,
                errors: parsed.errors.length > 0 ? parsed.errors : undefined,
                valid: parsed.errors.length === 0 && parsed.items.length > 0,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// Helper to get a valid token for POST/DELETE operations
import { refreshAccessToken } from "../auth/oauth.js";
import { getCurrentCharacter, updateTokens, getTokens } from "../auth/tokens.js";
import { readClientId } from "../auth/esi-client.js";

async function getValidTokenForPost(
  characterId: number
): Promise<{ token: string }> {
  let character = getTokens(characterId);
  if (!character) {
    character = getCurrentCharacter();
  }
  if (!character) {
    throw new Error("No authenticated character. Use esi_login first.");
  }

  const fiveMinutes = 5 * 60 * 1000;
  if (character.expiresAt.getTime() - Date.now() < fiveMinutes) {
    const clientId = readClientId();
    const newTokens = await refreshAccessToken(character.refreshToken, clientId);
    updateTokens(character.characterId, newTokens);
    character = getTokens(character.characterId)!;
  }

  return { token: character.accessToken };
}
