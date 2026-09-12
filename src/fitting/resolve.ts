// SDE resolution for the fitting-budget engine: turns a parsed EFT fit into
// the typed inputs computeFittingBudget consumes, plus character skill
// levels via ESI. All dogma attribute/effect lookups are by NAME, not
// hard-coded ID, so SDE updates don't silently break the math.

import type { getDatabase } from "../database.js";
import { esiGet, getActiveCharacter } from "../auth/esi-client.js";
import { parseEftFormat, type ParsedEft } from "./eft.js";
import type {
  BudgetDroneInput,
  BudgetItemInput,
  HullBudgetInput,
  SkillLevels,
} from "./budget.js";

const HULL_ATTR_NAMES = [
  "cpuOutput",
  "powerOutput",
  "upgradeCapacity",
  "hiSlots",
  "medSlots",
  "lowSlots",
  "rigSlots",
  "turretSlotsLeft",
  "launcherSlotsLeft",
  "droneCapacity",
  "droneBandwidth",
] as const;

export const BUDGET_SKILLS = {
  cpuManagement: "CPU Management",
  powerGridManagement: "Power Grid Management",
  weaponUpgrades: "Weapon Upgrades",
  advancedWeaponUpgrades: "Advanced Weapon Upgrades",
} as const;

/** Weapon family from the module's inventory group name (e.g. "Hybrid Weapon"). */
function weaponFamilyFromGroup(groupName: string): string | null {
  if (groupName.includes("Hybrid Weapon")) return "hybrid";
  if (groupName.includes("Projectile Weapon")) return "projectile";
  if (groupName.includes("Energy Weapon")) return "energy";
  if (groupName.startsWith("Missile Launcher")) return "missile";
  return null;
}

/** Rig PG-drawback family from its drawback effect name (e.g. "drawbackPowerNeedHybrids"). */
function drawbackFamilyFromEffect(effectName: string): string | null {
  if (effectName === "drawbackPowerNeedHybrids") return "hybrid";
  if (effectName === "drawbackPowerNeedProjectiles") return "projectile";
  if (effectName === "drawbackPowerNeedLasers") return "energy";
  if (effectName === "drawbackPowerNeedMissiles") return "missile";
  return null;
}

interface TypeAttrRow {
  attributeName: string;
  valueFloat: number | null;
  valueInt: number | null;
}

function typeAttrsByName(db: ReturnType<typeof getDatabase>, typeId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT a.attributeName, v.valueFloat, v.valueInt
       FROM dgmTypeAttributes v JOIN dgmAttributeTypes a ON v.attributeID = a.attributeID
       WHERE v.typeID = ?`
    )
    .all(typeId) as TypeAttrRow[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.attributeName, (r.valueFloat ?? r.valueInt ?? 0) as number);
  return map;
}

function typeEffectNames(db: ReturnType<typeof getDatabase>, typeId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT et.effectName FROM dgmTypeEffects e JOIN dgmEffects et ON e.effectID = et.effectID WHERE e.typeID = ?`
    )
    .all(typeId) as Array<{ effectName: string }>;
  return new Set(rows.map((r) => r.effectName));
}

function groupNameOf(db: ReturnType<typeof getDatabase>, typeId: number): string {
  const row = db
    .prepare(
      `SELECT g.groupName FROM invTypes t JOIN invGroups g ON t.groupID = g.groupID WHERE t.typeID = ?`
    )
    .get(typeId) as { groupName: string } | undefined;
  return row?.groupName ?? "";
}

export interface ResolvedFit {
  hull: HullBudgetInput;
  items: BudgetItemInput[];
  drones: BudgetDroneInput[];
  notes: string[];
}

export function resolveBudgetInputs(db: ReturnType<typeof getDatabase>, parsed: ParsedEft): ResolvedFit {
  const notes: string[] = [];
  const hullAttrs = typeAttrsByName(db, parsed.shipTypeId);
  const hullGroup = groupNameOf(db, parsed.shipTypeId);

  const subSlots = hullAttrs.get("subSystemSlot") ?? (hullGroup.includes("Strategic") ? 5 : null);
  const hull: HullBudgetInput = {
    name: parsed.shipName,
    typeId: parsed.shipTypeId,
    cpuOutput: hullAttrs.get("cpuOutput") ?? 0,
    powerOutput: hullAttrs.get("powerOutput") ?? 0,
    upgradeCapacity: hullAttrs.get("upgradeCapacity") ?? 0,
    hiSlots: hullAttrs.get("hiSlots") ?? 0,
    medSlots: hullAttrs.get("medSlots") ?? 0,
    lowSlots: hullAttrs.get("lowSlots") ?? 0,
    rigSlots: hullAttrs.get("rigSlots") ?? 0,
    turretHardpoints: hullAttrs.get("turretSlotsLeft") ?? 0,
    launcherHardpoints: hullAttrs.get("launcherSlotsLeft") ?? 0,
    droneCapacity: hullAttrs.get("droneCapacity") ?? 0,
    droneBandwidth: hullAttrs.get("droneBandwidth") ?? 0,
    subsystemSlots: subSlots !== null ? Number(subSlots) : null,
  };
  if (hull.cpuOutput === 0 && hull.powerOutput === 0) {
    notes.push(`"${parsed.shipName}" has no CPU/PG output in the SDE — is it a ship hull?`);
  }

  const items: BudgetItemInput[] = [];
  const drones: BudgetDroneInput[] = [];

  for (const item of parsed.items) {
    if (item.flag === "Cargo") continue; // charges/consumables: no fitting budget
    if (item.flag === "FighterBay") {
      notes.push(`Fighter "${item.name}" not budgeted (fighter mechanics out of scope).`);
      continue;
    }

    const attrs = typeAttrsByName(db, item.type_id);
    const effects = typeEffectNames(db, item.type_id);
    const group = groupNameOf(db, item.type_id);

    if (item.flag === "DroneBay") {
      drones.push({
        name: item.name,
        typeId: item.type_id,
        quantity: item.quantity,
        volume: attrs.get("volume") ?? 0,
        bandwidth: attrs.get("droneBandwidth") ?? 0,
      });
      continue;
    }

    const isTurret = effects.has("turretFitted");
    const isLauncher = effects.has("launcherFitted");

    // Rig: calibration cost + PG drawback
    let upgradeCost = 0;
    let pgDrawbackPct: number | null = null;
    let drawbackFamily: string | null = null;
    if (item.flag.startsWith("RigSlot")) {
      upgradeCost = attrs.get("upgradeCost") ?? 0;
      const drawback = attrs.get("drawback");
      if (drawback !== undefined) {
        // Only PG-drawback rigs affect the budget; other drawbacks (velocity,
        // armor, shield HP) don't touch CPU/PG and are ignored.
        for (const e of effects) {
          const fam = drawbackFamilyFromEffect(e);
          if (fam) {
            pgDrawbackPct = drawback;
            drawbackFamily = fam;
          }
        }
      }
    }

    items.push({
      name: item.name,
      typeId: item.type_id,
      flag: item.flag,
      quantity: item.quantity,
      offline: item.offline,
      cpu: attrs.get("cpu") ?? 0,
      power: attrs.get("power") ?? 0,
      isTurret,
      isLauncher,
      weaponFamily: weaponFamilyFromGroup(group),
      upgradeCost,
      pgDrawbackPct,
      drawbackFamily,
    });
  }

  return { hull, items, drones, notes };
}

/** Fetch the character's trained levels for the budget-relevant skills. */
export async function fetchBudgetSkillLevels(
  db: ReturnType<typeof getDatabase>,
  characterId?: number
): Promise<{ levels: SkillLevels; source: string }> {
  const char = await getActiveCharacter(characterId);
  const skillTypeIds = new Map<string, number>();
  for (const [key, skillName] of Object.entries(BUDGET_SKILLS)) {
    const row = db
      .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
      .get(skillName) as { typeID: number } | undefined;
    if (row) skillTypeIds.set(key, row.typeID);
  }

  const data = await esiGet<{ skills: Array<{ skill_id: number; trained_skill_level: number; active_skill_level?: number; current_skill_level?: number }> }>(
    `/characters/${char.characterId}/skills/`,
    { characterId: char.characterId }
  );

  const byId = new Map<number, number>();
  for (const s of data.skills) {
    byId.set(s.skill_id, s.current_skill_level ?? s.active_skill_level ?? s.trained_skill_level);
  }

  const levels: Record<string, number> = {};
  for (const [key, typeId] of skillTypeIds) {
    levels[key] = byId.get(typeId) ?? 0;
  }
  return {
    levels: {
      cpuManagement: levels.cpuManagement ?? 0,
      powerGridManagement: levels.powerGridManagement ?? 0,
      weaponUpgrades: levels.weaponUpgrades ?? 0,
      advancedWeaponUpgrades: levels.advancedWeaponUpgrades ?? 0,
    },
    source: `character ${char.characterName} (ESI)`,
  };
}

/** Re-parse + resolve in one step (used by check_fitting). */
export function parseAndResolve(db: ReturnType<typeof getDatabase>, eft: string): { parsed: ParsedEft; resolved: ResolvedFit } {
  const parsed = parseEftFormat(db, eft);
  if (!parsed.shipTypeId) return { parsed, resolved: { hull: emptyHull(), items: [], drones: [], notes: [] } };
  return { parsed, resolved: resolveBudgetInputs(db, parsed) };
}

function emptyHull(): HullBudgetInput {
  return {
    name: "",
    typeId: 0,
    cpuOutput: 0,
    powerOutput: 0,
    upgradeCapacity: 0,
    hiSlots: 0,
    medSlots: 0,
    lowSlots: 0,
    rigSlots: 0,
    turretHardpoints: 0,
    launcherHardpoints: 0,
    droneCapacity: 0,
    droneBandwidth: 0,
    subsystemSlots: null,
  };
}
