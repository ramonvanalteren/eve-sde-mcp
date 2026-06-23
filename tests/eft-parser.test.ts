import { describe, it, expect, afterAll } from "vitest";
import { getDatabase, closeDatabase } from "../src/database.js";
import { parseEftFormat } from "../src/tools/fittings.js";

afterAll(() => closeDatabase());

describe("EFT parser", () => {
  it("parses a basic fitting", () => {
    const db = getDatabase();
    const eft = `[Rifter, Test Fit]
200mm AutoCannon II
200mm AutoCannon II
200mm AutoCannon II
1MN Afterburner II
Small Shield Extender II
Small Shield Extender II
Damage Control II
Gyrostabilizer II
Small Projectile Burst Aerator I`;

    const result = parseEftFormat(db, eft);
    expect(result.shipName).toBe("Rifter");
    expect(result.fitName).toBe("Test Fit");
    expect(result.shipTypeId).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    expect(result.items.length).toBeGreaterThanOrEqual(8);

    // Verify slot assignment
    const hiSlots = result.items.filter((i) => i.flag.startsWith("HiSlot"));
    const medSlots = result.items.filter((i) => i.flag.startsWith("MedSlot"));
    const loSlots = result.items.filter((i) => i.flag.startsWith("LoSlot"));
    const rigSlots = result.items.filter((i) => i.flag.startsWith("RigSlot"));

    expect(hiSlots.length).toBe(3);
    expect(medSlots.length).toBe(3);
    expect(loSlots.length).toBe(2);
    expect(rigSlots.length).toBe(1);
  });

  it("handles loaded ammo (module, charge format)", () => {
    const db = getDatabase();
    const eft = `[Rifter, Ammo Test]
200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S`;

    const result = parseEftFormat(db, eft);
    expect(result.errors).toHaveLength(0);

    const hiSlots = result.items.filter((i) => i.flag.startsWith("HiSlot"));
    const cargoItems = result.items.filter((i) => i.flag === "Cargo");

    expect(hiSlots.length).toBe(2);
    expect(cargoItems.length).toBe(2);
    // Each ammo line produces a Cargo item
    for (const cargo of cargoItems) {
      expect(cargo.quantity).toBe(1);
    }
  });

  it("handles drones with quantity", () => {
    const db = getDatabase();
    const eft = `[Rifter, Drone Test]
Hobgoblin II x5`;

    const result = parseEftFormat(db, eft);
    expect(result.errors).toHaveLength(0);

    const drones = result.items.filter((i) => i.flag === "DroneBay");
    expect(drones.length).toBe(1);
    expect(drones[0].quantity).toBe(5);
  });

  it("skips [Empty ...] slots", () => {
    const db = getDatabase();
    const eft = `[Rifter, Empty Test]
200mm AutoCannon II
[Empty High slot]
[Empty High slot]
1MN Afterburner II
[Empty Med slot]
[Empty Med slot]`;

    const result = parseEftFormat(db, eft);
    expect(result.errors).toHaveLength(0);

    const hiSlots = result.items.filter((i) => i.flag.startsWith("HiSlot"));
    const medSlots = result.items.filter((i) => i.flag.startsWith("MedSlot"));
    expect(hiSlots.length).toBe(1);
    expect(medSlots.length).toBe(1);
  });

  it("returns error for invalid header", () => {
    const db = getDatabase();
    const result = parseEftFormat(db, "not a valid header");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Invalid EFT header");
    expect(result.items).toHaveLength(0);
  });

  it("returns error for unknown ship", () => {
    const db = getDatabase();
    const result = parseEftFormat(db, "[FakeShipXYZ123, Test]");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("not found in SDE");
    expect(result.shipTypeId).toBe(0);
  });

  it("collects errors for unknown items but keeps valid ones", () => {
    const db = getDatabase();
    const eft = `[Rifter, Partial Test]
200mm AutoCannon II
FakeModuleXYZ123
Damage Control II`;

    const result = parseEftFormat(db, eft);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("FakeModuleXYZ123");
    // Valid items still parsed
    expect(result.items.length).toBe(2);
  });

  it("handles charges in cargo", () => {
    const db = getDatabase();
    const eft = `[Rifter, Cargo Test]
Republic Fleet EMP S x1000`;

    const result = parseEftFormat(db, eft);
    expect(result.errors).toHaveLength(0);

    const cargo = result.items.filter((i) => i.flag === "Cargo");
    expect(cargo.length).toBe(1);
    expect(cargo[0].quantity).toBe(1000);
  });

  it("assigns sequential slot flags", () => {
    const db = getDatabase();
    const eft = `[Rifter, Slots Test]
200mm AutoCannon II
200mm AutoCannon II
200mm AutoCannon II`;

    const result = parseEftFormat(db, eft);
    expect(result.errors).toHaveLength(0);

    const flags = result.items.map((i) => i.flag);
    expect(flags).toEqual(["HiSlot0", "HiSlot1", "HiSlot2"]);
  });
});
