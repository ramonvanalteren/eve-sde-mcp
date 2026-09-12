import { describe, it, expect } from "vitest";
import { computeFittingBudget, type BudgetItemInput, type HullBudgetInput, type SkillLevels } from "../src/fitting/budget.js";

function hull(partial: Partial<HullBudgetInput> = {}): HullBudgetInput {
  return {
    name: "Test Frigate",
    typeId: 1,
    cpuOutput: 145,
    powerOutput: 49,
    upgradeCapacity: 400,
    hiSlots: 3,
    medSlots: 3,
    lowSlots: 3,
    rigSlots: 3,
    turretHardpoints: 2,
    launcherHardpoints: 0,
    droneCapacity: 0,
    droneBandwidth: 0,
    subsystemSlots: null,
    ...partial,
  };
}

function mod(partial: Partial<BudgetItemInput> = {}): BudgetItemInput {
  return {
    name: "Module",
    typeId: 1,
    flag: "LoSlot0",
    quantity: 1,
    offline: false,
    cpu: 10,
    power: 1,
    isTurret: false,
    isLauncher: false,
    weaponFamily: null,
    upgradeCost: 0,
    pgDrawbackPct: null,
    drawbackFamily: null,
    ...partial,
  };
}

function skills(partial: Partial<SkillLevels> = {}): SkillLevels {
  return {
    cpuManagement: 0,
    powerGridManagement: 0,
    weaponUpgrades: 0,
    advancedWeaponUpgrades: 0,
    ...partial,
  };
}

describe("computeFittingBudget", () => {
  it("computes a plain fit with raw costs and no skill effects", () => {
    const report = computeFittingBudget(
      hull(),
      [mod({ name: "DC II", cpu: 30, power: 1 }), mod({ name: "MAPC", flag: "LoSlot1", cpu: 0, power: 0 })],
      [],
      skills()
    );
    expect(report.fits).toBe(true);
    expect(report.cpu.used).toBe(30);
    expect(report.power.used).toBe(1);
    expect(report.slots.low.used).toBe(2);
  });

  it("applies CPU/PG Management output bonuses", () => {
    const report = computeFittingBudget(hull(), [mod({ cpu: 145, power: 49 })], [], skills({ cpuManagement: 5, powerGridManagement: 5 }));
    expect(report.cpu.capacity).toBeCloseTo(145 * 1.25, 6);
    expect(report.power.capacity).toBeCloseTo(49 * 1.25, 6);
    expect(report.fits).toBe(true);
  });

  it("applies Weapon Upgrades (CPU) and AWU (PG) to turrets/launchers only", () => {
    const items = [
      mod({ name: "150mm Rail", flag: "HiSlot0", cpu: 20, power: 8, isTurret: true, weaponFamily: "hybrid" }),
      mod({ name: "DC II", flag: "LoSlot0", cpu: 30, power: 1 }),
    ];
    const none = computeFittingBudget(hull(), items, [], skills());
    expect(none.cpu.used).toBe(50);
    expect(none.power.used).toBe(9);

    const trained = computeFittingBudget(hull(), items, [], skills({ weaponUpgrades: 5, advancedWeaponUpgrades: 5 }));
    expect(trained.cpu.used).toBeCloseTo(30 + 20 * 0.75, 6); // DC untouched, turret -25%
    expect(trained.power.used).toBeCloseTo(1 + 8 * 0.9, 6); // DC untouched, turret -10%
  });

  it("weapon-rig PG drawback hits the matching weapon family only", () => {
    const items = [
      mod({ name: "Collision Acc", flag: "RigSlot0", cpu: 0, power: 0, upgradeCost: 200, pgDrawbackPct: 10, drawbackFamily: "hybrid" }),
      mod({ name: "150mm Rail", flag: "HiSlot0", cpu: 20, power: 10, isTurret: true, weaponFamily: "hybrid" }),
      mod({ name: "200mm AC", flag: "HiSlot1", cpu: 20, power: 10, isTurret: true, weaponFamily: "projectile" }),
    ];
    const report = computeFittingBudget(hull({ hiSlots: 3, turretHardpoints: 2 }), items, [], skills());
    // hybrid turret: 10 PG + 10% drawback = 11; projectile: untouched 10
    const rail = report.power.items.find((i) => i.name === "150mm Rail");
    const ac = report.power.items.find((i) => i.name === "200mm AC");
    expect(rail?.effective).toBeCloseTo(11, 6);
    expect(rail?.reductions.join(" ")).toContain("weapon rig +10% PG need");
    expect(ac?.effective).toBeCloseTo(10, 6);
    expect(report.power.used).toBeCloseTo(21, 6);
    // the rig itself costs no CPU/PG — only calibration
    expect(report.calibration.used).toBe(200);
  });

  it("flags calibration overflow and slot overflow with human reasons", () => {
    const report = computeFittingBudget(
      hull(),
      [
        mod({ name: "Rig A", flag: "RigSlot0", upgradeCost: 200 }),
        mod({ name: "Rig B", flag: "RigSlot1", upgradeCost: 200 }),
        mod({ name: "Rig C", flag: "RigSlot2", upgradeCost: 50 }),
      ],
      [],
      skills()
    );
    expect(report.fits).toBe(false);
    expect(report.violations.join(" ")).toMatch(/Calibration over by 50/);
    expect(report.slots.rig.used).toBe(3);

    const slotOverflow = computeFittingBudget(
      hull({ lowSlots: 2 }),
      [mod({ flag: "LoSlot0" }), mod({ flag: "LoSlot1" }), mod({ name: "third", flag: "LoSlot2" })],
      [],
      skills()
    );
    expect(slotOverflow.fits).toBe(false);
    expect(slotOverflow.violations.join(" ")).toMatch(/3 low-slot modules but hull has 2/);
  });

  it("flags turret and launcher hardpoint violations", () => {
    const report = computeFittingBudget(
      hull({ turretHardpoints: 1, launcherHardpoints: 1 }),
      [
        mod({ name: "gun1", flag: "HiSlot0", isTurret: true }),
        mod({ name: "gun2", flag: "HiSlot1", isTurret: true }),
        mod({ name: "launcher", flag: "HiSlot2", isLauncher: true }),
      ],
      [],
      skills()
    );
    expect(report.fits).toBe(false);
    expect(report.violations.join(" ")).toMatch(/2 turret modules but hull has 1/);
    // launchers: 1 used, 1 max — no violation for them
    expect(report.violations.join(" ")).not.toMatch(/launcher/);
    expect(report.hardpoints.turrets).toEqual({ used: 2, max: 1 });
    expect(report.hardpoints.launchers).toEqual({ used: 1, max: 1 });
  });

  it("offline modules occupy slots but not budget — and report what online needs", () => {
    const report = computeFittingBudget(
      hull(),
      [mod({ name: "Neut", flag: "HiSlot0", cpu: 30, power: 8, offline: true }), mod({ name: "DC", flag: "LoSlot0", cpu: 30, power: 1 })],
      [],
      skills()
    );
    expect(report.slots.high.used).toBe(1);
    expect(report.cpu.used).toBe(30); // only the DC counts
    expect(report.offline).toEqual([{ name: "Neut", needsCpu: 30, needsPower: 8 }]);
    expect(report.fits).toBe(true);
  });

  it("flags drone bay overflow and reports fieldable counts", () => {
    const report = computeFittingBudget(
      hull({ droneCapacity: 10, droneBandwidth: 15 }),
      [],
      [
        { name: "Warrior II", typeId: 1, quantity: 5, volume: 2.5, bandwidth: 5 },
        { name: "Hobgoblin II", typeId: 2, quantity: 3, volume: 2.5, bandwidth: 5 },
      ],
      skills()
    );
    expect(report.fits).toBe(false); // 20 m³ of drones in a 10 m³ bay
    expect(report.violations.join(" ")).toMatch(/Drone bay over by 10/);
    expect(report.drones.bayUsedM3).toBe(20);
    // ship bandwidth 15 / warrior 5 = 3 fieldable at once
    expect(report.drones.maxActivePerType.find((t) => t.name === "Warrior II")?.active).toBe(3);
  });

  it("clamps skill levels to 0-5 and stays honest about what's unmodeled", () => {
    const report = computeFittingBudget(hull(), [mod()], [], skills({ cpuManagement: 9, weaponUpgrades: -3 }));
    expect(report.appliedSkills.cpuManagement).toBe(5);
    expect(report.appliedSkills.weaponUpgrades).toBe(0);
    expect(report.unmodeled.length).toBeGreaterThan(0);
    expect(report.unmodeled.join(" ")).toContain("Electronics Upgrades");
  });
});
