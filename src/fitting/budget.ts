// Fitting-budget engine ("dogma-lite") for check_fitting's exact fit math.
//
// Computes CPU / powergrid / calibration / slot / hardpoint / drone-bay
// budgets with the well-defined skill effects applied:
//   - CPU Management:        +5% ship CPU output per level
//   - Power Grid Management: +5% ship PG output per level
//   - Weapon Upgrades:       -5% CPU need of turrets/launchers per level
//   - Advanced Weapon Upgrades: -2% PG need of turrets/launchers per level
//   - weapon-rig PG drawbacks: +drawback% PG need of the matching weapon family
//
//   - Evasive Maneuvering:  -5% inertia per level (consumed by propulsion.ts)
//
// Deliberately NOT a full dogma engine (pyfa's eos is the reference for
// those): no implants, boosters, overheat, command bursts, DPS/EHP graphs,
// capacitor simulation, velocity, or cargo math. Stacking penalties are
// applied to inertia/align only (propulsion.ts), not other attributes.
// Everything unmodeled is reported in `unmodeled` so callers stay honest
// about the margin.

export interface SkillLevels {
  cpuManagement: number;
  powerGridManagement: number;
  weaponUpgrades: number;
  advancedWeaponUpgrades: number;
  evasiveManeuvering: number;
}

export interface BudgetItemInput {
  name: string;
  typeId: number;
  /** HiSlot0 / MedSlot1 / LoSlot2 / RigSlot0 / SubSystemSlot0 / ... */
  flag: string;
  quantity: number;
  offline: boolean;
  /** Dogma attr 50 (CPU usage). */
  cpu: number;
  /** Dogma attr 30 (Powergrid usage). */
  power: number;
  isTurret: boolean;
  isLauncher: boolean;
  /** "hybrid" | "projectile" | "energy" | "missile" | null (non-weapon). */
  weaponFamily: string | null;
  /** Rigs only: dogma attr 1153 (calibration cost). */
  upgradeCost: number;
  /** Rigs only: PG-need drawback % (dogma attr "drawback") for matching weapons. */
  pgDrawbackPct: number | null;
  /** Rigs only: which weapon family the drawback targets. */
  drawbackFamily: string | null;
}

export interface BudgetDroneInput {
  name: string;
  typeId: number;
  quantity: number;
  /** m³ per drone. */
  volume: number;
  /** Mbit/s per active drone. */
  bandwidth: number;
}

export interface HullBudgetInput {
  name: string;
  typeId: number;
  cpuOutput: number;
  powerOutput: number;
  upgradeCapacity: number;
  hiSlots: number;
  medSlots: number;
  lowSlots: number;
  rigSlots: number;
  turretHardpoints: number;
  launcherHardpoints: number;
  droneCapacity: number;
  droneBandwidth: number;
  /** T3 only; null when the hull has no subsystem slots. */
  subsystemSlots: number | null;
}

export interface ResourceBudget {
  capacity: number;
  used: number;
  headroom: number;
  overBy: number | null;
  items: Array<{
    name: string;
    base: number;
    effective: number;
    reductions: string[];
    offline: boolean;
  }>;
}

export interface FittingBudgetReport {
  fits: boolean;
  cpu: ResourceBudget;
  power: ResourceBudget;
  calibration: ResourceBudget;
  slots: Record<"high" | "medium" | "low" | "rig" | "subsystem", { used: number; max: number }>;
  hardpoints: { turrets: { used: number; max: number }; launchers: { used: number; max: number } };
  drones: {
    bayCapacityM3: number;
    bayUsedM3: number;
    perType: Array<{ name: string; quantity: number; volumeEach: number; bandwidthEach: number }>;
    shipBandwidth: number;
    maxActivePerType: Array<{ name: string; active: number }>;
  };
  /** Offline modules: occupy the slot, excluded from budget — with what
   *  they'd need to come online. */
  offline: Array<{ name: string; needsCpu: number; needsPower: number }>;
  appliedSkills: SkillLevels;
  unmodeled: string[];
  violations: string[];
}

function slotKey(flag: string): "high" | "medium" | "low" | "rig" | "subsystem" | null {
  if (flag.startsWith("HiSlot")) return "high";
  if (flag.startsWith("MedSlot")) return "medium";
  if (flag.startsWith("LoSlot")) return "low";
  if (flag.startsWith("RigSlot")) return "rig";
  if (flag.startsWith("SubSystemSlot")) return "subsystem";
  return null;
}

export function computeFittingBudget(
  hull: HullBudgetInput,
  items: BudgetItemInput[],
  drones: BudgetDroneInput[],
  skills: SkillLevels
): FittingBudgetReport {
  const lvl = (v: number) => Math.max(0, Math.min(5, v));
  const cpuMgmt = lvl(skills.cpuManagement);
  const pgMgmt = lvl(skills.powerGridManagement);
  const wu = lvl(skills.weaponUpgrades);
  const awu = lvl(skills.advancedWeaponUpgrades);

  const shipCpu = hull.cpuOutput * (1 + 0.05 * cpuMgmt);
  const shipPower = hull.powerOutput * (1 + 0.05 * pgMgmt);

  // Weapon-rig PG drawbacks, indexed by weapon family
  const pgDrawbackByFamily = new Map<string, number>();
  for (const it of items) {
    if (it.pgDrawbackPct !== null && it.drawbackFamily) {
      pgDrawbackByFamily.set(
        it.drawbackFamily,
        Math.max(pgDrawbackByFamily.get(it.drawbackFamily) ?? 0, it.pgDrawbackPct)
      );
    }
  }

  const cpuItems: ResourceBudget["items"] = [];
  const powerItems: ResourceBudget["items"] = [];
  const offline: FittingBudgetReport["offline"] = [];
  let cpuUsed = 0;
  let powerUsed = 0;
  let calibrationUsed = 0;
  let turrets = 0;
  let launchers = 0;
  const slotUsed: Record<string, number> = { high: 0, medium: 0, low: 0, rig: 0, subsystem: 0 };

  for (const it of items) {
    const sk = slotKey(it.flag);
    if (sk) slotUsed[sk]++;

    if (it.isTurret) turrets++;
    if (it.isLauncher) launchers++;

    // Rigs: calibration only (rigs cost no CPU/PG)
    if (sk === "rig") {
      calibrationUsed += it.upgradeCost;
      continue;
    }
    // Subsystems: occupy slots; their CPU/PG output contribution unmodeled (T3)
    if (sk === "subsystem") {
      continue;
    }

    // CPU/PG with skill reductions
    const reductions: string[] = [];
    let cpuFactor = 1;
    let powerFactor = 1;
    if (it.isTurret || it.isLauncher) {
      if (wu > 0) {
        cpuFactor *= 1 - 0.05 * wu;
        reductions.push(`Weapon Upgrades -${5 * wu}% CPU`);
      }
      if (awu > 0) {
        powerFactor *= 1 - 0.02 * awu;
        reductions.push(`Advanced Weapon Upgrades -${2 * awu}% PG`);
      }
      if (it.weaponFamily) {
        const drawback = pgDrawbackByFamily.get(it.weaponFamily);
        if (drawback) {
          powerFactor *= 1 + drawback / 100;
          reductions.push(`weapon rig +${drawback}% PG need`);
        }
      }
    }
    const effCpu = it.cpu * cpuFactor;
    const effPower = it.power * powerFactor;

    cpuItems.push({ name: it.name, base: it.cpu, effective: effCpu, reductions, offline: it.offline });
    powerItems.push({ name: it.name, base: it.power, effective: effPower, reductions, offline: it.offline });

    if (it.offline) {
      offline.push({ name: it.name, needsCpu: effCpu, needsPower: effPower });
    } else {
      cpuUsed += effCpu;
      powerUsed += effPower;
    }
  }

  const budget = (capacity: number, used: number): ResourceBudget => ({
    capacity,
    used,
    headroom: capacity - used,
    overBy: used > capacity ? used - capacity : null,
    items: [],
  });

  const cpu = budget(shipCpu, cpuUsed);
  cpu.items = cpuItems;
  const power = budget(shipPower, powerUsed);
  power.items = powerItems;
  const calibration = budget(hull.upgradeCapacity, calibrationUsed);

  const violations: string[] = [];
  if (cpu.overBy !== null)
    violations.push(`CPU over by ${cpu.overBy.toFixed(1)} tf (${cpu.used.toFixed(1)} used / ${cpu.capacity.toFixed(1)} available)`);
  if (power.overBy !== null)
    violations.push(`Powergrid over by ${power.overBy.toFixed(1)} MW (${power.used.toFixed(1)} used / ${power.capacity.toFixed(1)} available)`);
  if (calibration.overBy !== null)
    violations.push(`Calibration over by ${calibration.overBy.toFixed(0)} points (${calibration.used} used / ${calibration.capacity} available)`);
  const slots = {
    high: { used: slotUsed.high, max: hull.hiSlots },
    medium: { used: slotUsed.medium, max: hull.medSlots },
    low: { used: slotUsed.low, max: hull.lowSlots },
    rig: { used: slotUsed.rig, max: hull.rigSlots },
    subsystem: { used: slotUsed.subsystem, max: hull.subsystemSlots ?? 0 },
  };
  if (slots.high.used > slots.high.max) violations.push(`${slots.high.used} high-slot modules but hull has ${slots.high.max}`);
  if (slots.medium.used > slots.medium.max) violations.push(`${slots.medium.used} mid-slot modules but hull has ${slots.medium.max}`);
  if (slots.low.used > slots.low.max) violations.push(`${slots.low.used} low-slot modules but hull has ${slots.low.max}`);
  if (slots.rig.used > slots.rig.max) violations.push(`${slots.rig.used} rigs but hull has ${slots.rig.max}`);
  if (hull.subsystemSlots !== null && slots.subsystem.used > slots.subsystem.max)
    violations.push(`${slots.subsystem.used} subsystems but hull has ${slots.subsystem.max}`);
  const hardpoints = {
    turrets: { used: turrets, max: hull.turretHardpoints },
    launchers: { used: launchers, max: hull.launcherHardpoints },
  };
  if (turrets > hull.turretHardpoints)
    violations.push(`${turrets} turret modules but hull has ${hull.turretHardpoints} turret hardpoints`);
  if (launchers > hull.launcherHardpoints)
    violations.push(`${launchers} launcher modules but hull has ${hull.launcherHardpoints} launcher hardpoints`);

  const bayUsedM3 = drones.reduce((acc, d) => acc + d.volume * d.quantity, 0);
  const perType = drones.map((d) => ({
    name: d.name,
    quantity: d.quantity,
    volumeEach: d.volume,
    bandwidthEach: d.bandwidth,
  }));
  const maxActivePerType = drones.map((d) => ({
    name: d.name,
    active: Math.min(d.quantity, Math.floor(hull.droneBandwidth / Math.max(d.bandwidth, 1) || 0), 5),
  }));
  if (bayUsedM3 > hull.droneCapacity)
    violations.push(
      `Drone bay over by ${(bayUsedM3 - hull.droneCapacity).toFixed(1)} m³ (${bayUsedM3.toFixed(1)} of ${hull.droneCapacity} m³)`
    );

  const unmodeled = [
    "Electronics Upgrades CPU reduction on electronic-upgrade modules (co-processors, signal amplifiers, ECCM) is NOT applied — those modules count at raw CPU.",
    "T3 subsystem CPU/PG output bonuses are not applied (subsystem slots counted only).",
    "Implants, boosters, overheat, and command bursts are not modeled.",
    "No capacitor simulation, DPS/EHP, velocity, or cargo math (pyfa territory); stacking penalties are applied to inertia/align only (see propulsion).",
  ];

  return {
    fits: violations.length === 0,
    cpu,
    power,
    calibration,
    slots,
    hardpoints,
    drones: {
      bayCapacityM3: hull.droneCapacity,
      bayUsedM3,
      perType,
      shipBandwidth: hull.droneBandwidth,
      maxActivePerType,
    },
    offline,
    appliedSkills: { cpuManagement: cpuMgmt, powerGridManagement: pgMgmt, weaponUpgrades: wu, advancedWeaponUpgrades: awu, evasiveManeuvering: lvl(skills.evasiveManeuvering) },
    unmodeled,
    violations,
  };
}
