import { describe, it, expect } from "vitest";
import {
  stackingPenalty,
  applyStacking,
  computePropulsion,
  type PropulsionItemInput,
} from "../src/fitting/propulsion.js";

describe("stacking penalties", () => {
  it("applies the dogma penalty curve: full, ~87%, ~58%, ~29%", () => {
    expect(stackingPenalty(1)).toBe(1);
    expect(stackingPenalty(2)).toBeCloseTo(0.8731, 3);
    expect(stackingPenalty(3)).toBeCloseTo(0.5810, 3);
    expect(stackingPenalty(4)).toBeCloseTo(0.2948, 3);
    expect(stackingPenalty(0)).toBe(1); // defensive
  });

  it("sorts strongest-first and compounds the penalized percentages", () => {
    const { sorted, multiplier } = applyStacking([
      { item: "Low Friction Nozzle Joints II", percent: -14 },
      { item: "Nanofiber Internal Structure II", percent: -15.75 },
      { item: "Nanofiber Internal Structure II", percent: -15.75 },
    ]);
    // strongest (nano, -15.75) first at full strength, LFJ rig last at ~58%
    expect(sorted[0].item).toBe("Nanofiber Internal Structure II");
    expect(sorted[0].penalty).toBe(1);
    expect(sorted[2].item).toBe("Low Friction Nozzle Joints II");
    expect(sorted[2].penalty).toBeCloseTo(0.5810, 3);
    // 0.8425 × 0.86246 × 0.91851 ≈ 0.6673
    expect(multiplier).toBeCloseTo(0.6673, 3);
  });
});

// Viator fixture — the 2026-09 in-game simulator validation:
// sim showed mass 15,000 t, inertia 0.2659x (Evasive Maneuvering V),
// align 5.53 s. Engine at EM V reads 5.62 s (~1.7% residual from the
// exact dogma stacking constants, which SDE/ESI do not expose).
function viatorItems(): PropulsionItemInput[] {
  return [
    { name: "Covert Ops Cloaking Device II", flag: "HiSlot0", offline: false },
    { name: "50MN Y-T8 Compact Microwarpdrive", flag: "MedSlot0", offline: false, massAdditionKg: 5_000_000 },
    { name: "Medium Shield Extender II", flag: "MedSlot1", offline: false },
    { name: "EM Shield Amplifier II", flag: "MedSlot2", offline: false },
    { name: "Expanded Cargohold II", flag: "LoSlot0", offline: false },
    { name: "Nanofiber Internal Structure II", flag: "LoSlot1", offline: false, agilityMultiplierPct: -15.75 },
    { name: "Nanofiber Internal Structure II", flag: "LoSlot2", offline: false, agilityMultiplierPct: -15.75 },
    { name: "Medium Cargohold Optimization II", flag: "RigSlot0", offline: false },
    { name: "Medium Low Friction Nozzle Joints II", flag: "RigSlot1", offline: false, agilityBonusPct: -14 },
  ];
}

describe("computePropulsion (Viator, sim-validated)", () => {
  const base = {
    hullName: "Viator",
    hullMassKg: 10_000_000, // ESI universe/types — SDE lacks hull mass
    hullInertia: 0.54,
    items: viatorItems(),
  };

  it("reproduces mass 15,000 t, effective inertia, and the ln(4) align", () => {
    const r = computePropulsion({ ...base, evasiveManeuveringLevel: 5 });
    expect(r.available).toBe(true);
    expect(r.mass?.totalKg).toBe(15_000_000);
    expect(r.mass?.propMassAdditions).toEqual([{ item: "50MN Y-T8 Compact Microwarpdrive", kg: 5_000_000 }]);
    // 0.54 × 0.75 (EM V) × 0.6673 ≈ 0.2703 — sim read 0.2659 (~1.6% residual)
    expect(r.inertia?.effective).toBeCloseTo(0.2703, 3);
    // ln(4) × 0.2703 × 15,000,000 / 1e6 ≈ 5.62 s — sim read 5.53 s
    expect(r.alignSeconds).toBeCloseTo(5.62, 1);
  });

  it("at Evasive Maneuvering IV (Helga's level) the align reads ~6.0 s", () => {
    const r = computePropulsion({ ...base, evasiveManeuveringLevel: 4 });
    expect(r.inertia?.effective).toBeCloseTo(0.2882, 3);
    expect(r.alignSeconds).toBeCloseTo(5.99, 1);
  });

  it("offline prop modules contribute neither mass nor agility", () => {
    const items = viatorItems().map((it) =>
      it.name === "50MN Y-T8 Compact Microwarpdrive" ? { ...it, offline: true } : it
    );
    const r = computePropulsion({ ...base, items, evasiveManeuveringLevel: 5 });
    expect(r.mass?.totalKg).toBe(10_000_000);
    expect(r.mass?.propMassAdditions).toEqual([]);
  });

  it("reports unavailable with a reason when hull mass is unresolvable", () => {
    const r = computePropulsion({ ...base, hullMassKg: null, evasiveManeuveringLevel: 5 });
    expect(r.available).toBe(false);
    expect(r.reason).toContain("mass not resolvable");
  });
});
