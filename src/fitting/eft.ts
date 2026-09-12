// EFT format parsing, shared by parse_eft / save_fitting / check_fitting /
// price_fitting. Tolerates real-world exports: empty-slot markers, offline
// markers, x-quantities, module+charge pairs, drones, fighters, cargo.

import type { getDatabase } from "../database.js";

const SLOT_EFFECT_IDS: Record<number, string> = {
  12: "hi",
  13: "med",
  11: "lo",
  2663: "rig",
  3772: "sub",
  6306: "service",
};

const FLAG_PREFIX: Record<string, string> = {
  hi: "HiSlot",
  med: "MedSlot",
  lo: "LoSlot",
  rig: "RigSlot",
  sub: "SubSystemSlot",
  service: "ServiceSlot",
};

export interface FittingItem {
  type_id: number;
  name: string;
  flag: string;
  quantity: number;
  offline: boolean;
}

export interface ParsedEft {
  shipName: string;
  shipTypeId: number;
  fitName: string;
  items: FittingItem[];
  /** Structural failures — the fit cannot be interpreted. */
  errors: string[];
  /** Soft skips — items that couldn't be resolved (e.g. mutated/abyssal names). */
  warnings: string[];
}

export function resolveTypeId(db: ReturnType<typeof getDatabase>, name: string): number | null {
  const trimmed = name.trim();
  let row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? COLLATE NOCASE AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  return null;
}

export function getSlotType(db: ReturnType<typeof getDatabase>, typeId: number): string | null {
  const effects = db
    .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
    .all(typeId) as { effectID: number }[];

  for (const e of effects) {
    if (SLOT_EFFECT_IDS[e.effectID]) return SLOT_EFFECT_IDS[e.effectID];
  }

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

/** True for empty-slot placeholder lines in EFT exports ("[]", "[Empty High Slot]"). */
function isEmptySlotMarker(line: string): boolean {
  if (line.startsWith("[Empty")) return true;
  return /^\[\s*\]$/.test(line);
}

export function parseEftFormat(db: ReturnType<typeof getDatabase>, eft: string): ParsedEft {
  const lines = eft.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const errors: string[] = [];
  const warnings: string[] = [];
  const items: FittingItem[] = [];

  const headerMatch = lines[0]?.match(/^\[(.+?),\s*(.+)\]$/);
  if (!headerMatch) {
    return {
      shipName: "",
      shipTypeId: 0,
      fitName: "",
      items: [],
      errors: ["Invalid EFT header. Expected: [Ship Name, Fit Name]"],
      warnings,
    };
  }

  const shipName = headerMatch[1].trim();
  const fitName = headerMatch[2].trim();
  const shipTypeId = resolveTypeId(db, shipName);
  if (!shipTypeId) {
    return {
      shipName,
      shipTypeId: 0,
      fitName,
      items: [],
      errors: [`Ship "${shipName}" not found in SDE`],
      warnings,
    };
  }

  const slotCounters: Record<string, number> = { hi: 0, med: 0, lo: 0, rig: 0, sub: 0, service: 0 };

  for (let i = 1; i < lines.length; i++) {
    let line = lines[i];

    if (line === "" || line === "---") continue;
    if (isEmptySlotMarker(line)) continue;

    // Offline marker: pyfa exports offline modules with a trailing "/off"
    let offline = false;
    const offMatch = line.match(/\s*\/\s*off\s*$/i);
    if (offMatch) {
      offline = true;
      line = line.substring(0, offMatch.index).trim();
    }

    // EFT format: "Module Name, Loaded Charge" or "Item Name x2" or just "Item Name"
    const commaIdx = line.indexOf(",");
    let modulePart = line;
    let chargePart: string | null = null;

    if (commaIdx !== -1) {
      const beforeComma = line.substring(0, commaIdx).trim();
      const afterComma = line.substring(commaIdx + 1).trim();
      // Only treat as module+charge if the first part resolves (avoids
      // splitting item names that contain commas)
      const beforeId = resolveTypeId(db, beforeComma);
      if (beforeId && afterComma.length > 0) {
        modulePart = beforeComma;
        chargePart = afterComma;
      }
    }

    // Parse "Item Name x2" quantity suffix
    const quantityMatch = modulePart.match(/^(.+?)\s+x(\d+)$/);
    const itemName = quantityMatch ? quantityMatch[1].trim() : modulePart;
    const quantity = quantityMatch ? parseInt(quantityMatch[2], 10) : 1;

    const typeId = resolveTypeId(db, itemName);
    if (!typeId) {
      warnings.push(
        `Item "${itemName}" not found in SDE${offline ? " (was marked offline)" : ""} — skipped. Mutated/abyssal modules aren't in the SDE under their display name; budget checks will under-count them.`
      );
      continue;
    }

    const slotType = getSlotType(db, typeId);
    if (!slotType) {
      warnings.push(`Could not determine slot type for "${itemName}" — skipped.`);
      continue;
    }

    if (slotType === "drone") {
      items.push({ type_id: typeId, name: itemName, flag: "DroneBay", quantity, offline });
    } else if (slotType === "fighter") {
      items.push({ type_id: typeId, name: itemName, flag: "FighterBay", quantity, offline });
    } else if (slotType === "cargo") {
      items.push({ type_id: typeId, name: itemName, flag: "Cargo", quantity, offline });
    } else {
      const prefix = FLAG_PREFIX[slotType];
      const idx = slotCounters[slotType];
      if (idx === undefined) continue;
      items.push({ type_id: typeId, name: itemName, flag: `${prefix}${idx}`, quantity, offline });
      slotCounters[slotType]++;
    }

    // Handle loaded charge as a cargo item
    if (chargePart) {
      const chargeQuantityMatch = chargePart.match(/^(.+?)\s+x(\d+)$/);
      const chargeName = chargeQuantityMatch ? chargeQuantityMatch[1].trim() : chargePart;
      const chargeQty = chargeQuantityMatch ? parseInt(chargeQuantityMatch[2], 10) : 1;

      const chargeTypeId = resolveTypeId(db, chargeName);
      if (chargeTypeId) {
        items.push({ type_id: chargeTypeId, name: chargeName, flag: "Cargo", quantity: chargeQty, offline: false });
      } else {
        warnings.push(`Charge "${chargeName}" not found in SDE — skipped.`);
      }
    }
  }

  return { shipName, shipTypeId, fitName, items, errors, warnings };
}
