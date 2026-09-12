// Propulsion math (mass / inertia / align) for check_fitting — the numbers
// hand-math keeps getting wrong. Ground-truthed against the in-game fitting
// simulator during the Viator session (2026-09): sim showed mass 15,000 t and
// inertia 0.2659x => align 5.53 s, and every component is reproduced here.
//
// Modeled:
//   - ship mass: hull base + massAddition of ONLINE prop modules — MWDs add
//     mass while merely online (the classic hidden align penalty)
//   - inertia: hull base × Evasive Maneuvering (×0.95/level, unpenalized) ×
//     stack-penalized agility modifiers (agilityMultiplier attr 169 on modules,
//     agilityBonus attr 151 on rigs — one dogma stack, strongest first)
//   - align: ln(4) × inertia × massKg / 1e6 — the in-game displayed value
//     (time to 75% of max velocity, the warp-entry condition), NOT the ln(2)
//     shortcut that halves the true figure
//
// Stacking penalty: the k-th strongest modifier applies at
// 0.5^(((k-1)/2.26)^2) — k=1 full, k=2 ≈ 87%, k=3 ≈ 58%, k=4 ≈ 29%.
//
// Validation: Viator + 50MN Compact MWD + 2× Nanofiber II + Medium Low
// Friction Nozzle Joints II at Evasive Maneuvering V: engine 5.62 s vs
// in-game sim 5.53 s (~1.7% — the exact dogma stacking constants are not
// exposed by SDE/ESI; pyfa remains the reference for that residual).

export interface PropulsionItemInput {
  name: string;
  flag: string;
  offline: boolean;
  /** Dogma attr 169 (agilityMultiplier), percent. Modules (nanos, istabs). */
  agilityMultiplierPct?: number;
  /** Dogma attr 151 (agilityBonus), percent. Rigs (Low Friction Nozzle Joints). */
  agilityBonusPct?: number;
  /** Dogma attr 796 (massAddition), kg — prop modules add mass while online. */
  massAdditionKg?: number;
}

export interface PropulsionInput {
  hullName: string;
  /** Hull base mass in kg; null = unresolvable (SDE lacks it, ESI unreachable). */
  hullMassKg: number | null;
  /** Hull base inertia — dogma attr "agility" (Inertia Modifier); null = unknown. */
  hullInertia: number | null;
  /** Trained Evasive Maneuvering level (0-5). */
  evasiveManeuveringLevel: number;
  items: PropulsionItemInput[];
}

export interface StackedModifier {
  item: string;
  /** Raw modifier percent (negative = agility improvement). */
  percent: number;
  /** Stack-penalty factor applied (1 = full strength). */
  penalty: number;
  effectivePercent: number;
}

export interface PropulsionReport {
  available: boolean;
  reason?: string;
  mass?: {
    baseKg: number;
    propMassAdditions: Array<{ item: string; kg: number }>;
    totalKg: number;
  };
  inertia?: {
    base: number;
    evasiveManeuvering: { level: number; multiplier: number };
    modifiers: StackedModifier[];
    modifierMultiplier: number;
    effective: number;
  };
  alignSeconds?: number;
  formula?: string;
  notes: string[];
}

/** Dogma stacking-penalty factor for the rank-th strongest modifier (1-indexed). */
export function stackingPenalty(rank: number): number {
  if (rank < 1) return 1;
  return 0.5 ** (((rank - 1) / 2.26) ** 2);
}

/** Sort modifiers strongest-first, apply stacking penalties, return the product. */
export function applyStacking(modifiers: Array<{ item: string; percent: number }>): {
  sorted: StackedModifier[];
  multiplier: number;
} {
  const sorted = [...modifiers]
    .sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent))
    .map((m, i) => {
      const penalty = stackingPenalty(i + 1);
      return { item: m.item, percent: m.percent, penalty, effectivePercent: m.percent * penalty };
    });
  let multiplier = 1;
  for (const m of sorted) multiplier *= 1 + (m.percent * m.penalty) / 100;
  return { sorted, multiplier };
}

export function computePropulsion(input: PropulsionInput): PropulsionReport {
  const notes: string[] = [
    "Align uses the in-game ln(4) × inertia × mass formula (75%-of-max-velocity warp entry); matches the in-game simulator within ~2% (exact dogma stacking constants unexposed — pyfa is the reference for the residual).",
  ];

  if (input.hullMassKg == null || input.hullMassKg <= 0 || input.hullInertia == null || input.hullInertia <= 0) {
    return {
      available: false,
      reason:
        input.hullMassKg == null || input.hullMassKg <= 0
          ? `Hull mass not resolvable for ${input.hullName} (SDE lacks attr 'mass' for hulls and ESI universe/types was unreachable) — align not computed.`
          : `Hull inertia ('agility') missing for ${input.hullName} in the SDE — align not computed.`,
      notes,
    };
  }

  const online = input.items.filter((it) => !it.offline);

  const propMassAdditions = online
    .filter((it) => (it.massAdditionKg ?? 0) > 0)
    .map((it) => ({ item: it.name, kg: it.massAdditionKg as number }));
  const totalKg = input.hullMassKg + propMassAdditions.reduce((sum, a) => sum + a.kg, 0);
  if (propMassAdditions.length > 0) {
    notes.push(
      "Prop mass additions apply while the module is ONLINE (not only when cycling) — the classic MWD align penalty."
    );
  }

  const emLevel = Math.max(0, Math.min(5, input.evasiveManeuveringLevel));
  const emMultiplier = 1 - 0.05 * emLevel;

  const agilityMods = online
    .map((it) => ({
      item: it.name,
      percent: it.agilityMultiplierPct ?? it.agilityBonusPct ?? 0,
    }))
    .filter((m) => m.percent !== 0);

  const { sorted, multiplier } = applyStacking(agilityMods);
  const inertiaEffective = input.hullInertia * emMultiplier * multiplier;

  const alignSeconds = (Math.log(4) * inertiaEffective * totalKg) / 1e6;

  return {
    available: true,
    mass: {
      baseKg: input.hullMassKg,
      propMassAdditions,
      totalKg,
    },
    inertia: {
      base: input.hullInertia,
      evasiveManeuvering: { level: emLevel, multiplier: emMultiplier },
      modifiers: sorted,
      modifierMultiplier: multiplier,
      effective: inertiaEffective,
    },
    alignSeconds,
    formula: "ln(4) × inertia × massKg / 1e6",
    notes,
  };
}
