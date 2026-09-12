---
name: eve-fitting
description: Use this skill whenever helping a user build, validate, or iterate on an EVE Online ship fitting. Triggers include any mention of fitting, fits, EFT format, slot layouts, module selection, CPU/PG/calibration budgets, rig selection, drone bays, hull bonuses, ammo choices, or tank philosophy for EVE Online ships. Also triggers when reviewing killmails to suggest fit improvements, comparing module variants (T2 vs meta/compact), or pushing fits via ESI. Use this skill even for seemingly simple fitting questions — EVE fitting has many hidden constraints (calibration, drone bandwidth, hull bonuses, skill-modified costs) that are easy to get wrong from memory. Always consult this skill before stating slot counts, module names, or fitting feasibility.
---

# EVE Online Ship Fitting — Best Practices

This skill encodes hard-won lessons from iterative fitting sessions. Every rule
below exists because the opposite was tried and failed, usually multiple times.

**Scope and depth:** the rules here are universal — SDE verification, the four
fitting constraints, the coherence checks, the build workflow — and apply to every
hull. The worked examples and ammo tables, however, are Gallente/hybrid-weapon-
centric (they grew out of hybrid frigate/destroyer sessions). Before trusting
race-specific specifics (ammo tables, hull patterns) for projectile, missile, or
laser ships, verify them from the SDE the same way — and extend this file when a
new weapon system is fitted for the first time rather than improvising from memory.

## Contents
- CRITICAL RULE: Never Fit From Memory
- The Four Fitting Constraints (CPU, powergrid, calibration, slots)
- The Soft Fifth Constraint: Capacitor
- Stacking Penalties — Why "More Damage Mods" Stops Working
- Overheat — the Free 15%
- The CPU/PG Calculation Error — solved by check_fitting
- Hull Bonuses Drive Fit Design
- Tank Philosophy by Role
- Module Naming Conventions
- Ammo Selection for Hybrid Weapons
- Drone Verification
- Fit Coherence Check
- Workflow: Building a Fit
- Workflow: Reviewing a Killmail Fit
- Using MCP/SDE Tools
- Common Fitting Mistakes

## CRITICAL RULE: Never Fit From Memory

Claude's training data contains EVE fitting information that is frequently wrong
on specifics: slot counts, module names, drone bay sizes, rig calibration costs,
and hull bonuses. These errors are not obvious — they feel correct and are stated
confidently, but they produce fits that don't work in the client.

**Before building ANY fit, verify these from the SDE (via MCP tools or EVERef):**
1. Hull slot layout (high/mid/low/rig counts)
2. Turret and launcher hardpoints (not the same as high slots)
3. Drone bay capacity (m³) and drone bandwidth (Mbit/sec)
4. Hull bonuses (per-level and role bonuses)
5. Base CPU output and Powergrid output
6. Rig calibration capacity

**Never assume a hull "probably has" drones, or "should have" 3 mids.** Verify.
The Atron has zero drone bay. The Catalyst has 2 mids, not 3. These errors
recur because the wrong numbers feel plausible.


## The Four Fitting Constraints

Every fit must satisfy ALL FOUR constraints simultaneously. Missing any one
produces a fit that cannot be activated in-game.

### 1. CPU (tf)
- Ship base CPU × (1 + 0.05 × CPU Management level) = effective CPU supply
- Each module has a base CPU cost (from SDE)
- **Module CPU costs are REDUCED by character skills** (see below)
- Rigs have zero CPU cost

### 2. Powergrid (MW)
- Ship base PG × (1 + 0.05 × PG Management level) = effective PG supply
- Each module has a base PG cost (from SDE)
- **Module PG costs are REDUCED by character skills** (see below)
- Rigs have zero direct PG cost BUT may have drawbacks that increase weapon PG
- Hybrid weapon rigs typically add +10% PG need to hybrid weapons per rig

### 3. Rig Calibration (points)
- Ship has a calibration capacity (typically 400 for T1 frigates)
- Each rig has a calibration cost (from SDE, attribute "upgradeCost")
- **This is the most commonly forgotten constraint**
- Common calibration costs for small rigs:
  - Hybrid weapon rigs (Burst Aerator, Collision Accelerator): 200 each
  - Navigation rigs (Polycarbon, Auxiliary Thrusters): 100 each
  - Core rigs (Ancillary Current Router): 100
  - Targeting rigs (Ionic Field Projector): 50
  - Processor Overclocking Unit: 150
- Two hybrid weapon rigs (200+200=400) consume an entire T1 frigate's budget
- Always total calibration before proposing a rig combination

### 4. Slot Layout
- High slots ≠ turret hardpoints ≠ launcher hardpoints
- A hull may have 4 highs but only 3 turret hardpoints and 0 launchers
- The extra high can fit utility modules (neut, nos, drone link augmentor)
  but NOT an extra weapon
- Verify turret AND launcher hardpoints separately from high slot count


## The Soft Fifth Constraint: Capacitor

CPU/PG/calibration/slots decide whether a fit can be INSTALLED. Capacitor
decides whether it keeps RUNNING — a soft constraint the fitting window
never enforces, and `check_fitting` deliberately does not simulate (it
lists capacitor as unmodeled).

- Cap-stable = regen ≥ drain with tackle + prop + reppers running. Active
  armor/shield tanks and prop mods are the big drains; MWDs are enormous.
- A brawler with an active rep usually needs cap mods (battery, recharger)
  or a cap booster — or accepts being on a timer.
- Kiters usually don't care: buffer-tanked + pulsed AB fits are often
  stable by accident.
- Neuts flip the math: against a neut-fitted opponent even a "stable" fit
  drains in seconds. Brawlers should plan headroom for being neuted
  (booster charges in cargo).
- Rule of thumb without pyfa: sum the cap usage of everything running
  continuously, compare against peak recharge (~2.5× base regen at ~25%
  capacitor), and treat anything in the grey zone as a timer, not
  stability. For cap graphs, pyfa.

## Stacking Penalties — Why "More Damage Mods" Stops Working

Modules affecting the SAME attribute are stacking-penalized: the 2nd is ~87%
effective, the 3rd ~57%, the 4th ~28% — beyond the third, a module is
near-useless for its penalized bonus. This is fit-DESIGN math, not budget
math (`check_fitting` doesn't compute it — it doesn't change whether a fit
installs, only whether it's worth the slot).

- Damage mods (Mag Stab / BCS / DDAs): 3 is the practical ceiling; the 4th
  low is almost always better as tank/utility.
- Damage Controls are NOT stacking-penalized with resist modules (different
  mechanism) — always worth fitting alongside plates/hardeners.
- Plates/extenders/hardeners: same rule — don't stack 4+ of one kind.
- A rig's bonus stacks against same-bonus modules (resist rig + resist mod).

## Overheat — the Free 15%

Every T2/meta module can overheat: more damage/range/rep at the cost of
heat damage to the rack. In PvP frigate/destroyer fights, overheating is
ASSUMED — plan around it, don't discover it.

- A fit usually overheats ONE thing for the critical window: guns (DPS),
  the point (range), or the tank (rep amount).
- Carry nanite repair paste; it's the difference between one engagement
  and a fight.
- Overheat doesn't change fitting budgets (`check_fitting` ignores it —
  runtime behavior, not install cost), but it changes module choices:
  modules that can't swing a fight when overheated earn their slots less.

## The CPU/PG Calculation Error — solved by check_fitting

The historical single most important lesson: the SDE provides BASE module
costs, while character skills reduce what modules actually consume (output
skills raise the ship's supply, cost-reduction skills lower module needs) —
raw SDE math systematically overstates usage.

**Use `check_fitting` instead of hand-math before presenting any fit.** It
applies the well-defined effects — CPU/PG Management output bonuses, Weapon
Upgrades (-5% turret/launcher CPU per level), Advanced Weapon Upgrades
(-2% turret/launcher PG per level), weapon-rig PG drawbacks — and returns
exact CPU/PG/calibration/slot/hardpoint/drone budgets plus everything it
deliberately leaves unmodeled (Electronics Upgrades reductions, T3
subsystem output, implants, boosters, overheat, capacitor — pyfa's eos is
the reference for that tier).

The fallback rules when no tools are available still apply:
- Never declare "doesn't fit" from raw math — if it's close (within ~15%),
  it likely fits once module cost-reduction skills are applied
- The in-game fitting window is ground truth
- When the user reports fitting-window numbers, trust those over any
  calculation

**This is the single most important lesson in this skill.**

The SDE provides BASE module costs before any skill reductions. When computing
whether a fit works, there are TWO categories of skills that affect fitting:

### Category 1: Ship Output Skills (increase supply)
- CPU Management: +5% ship CPU per level
- Power Grid Management: +5% ship PG per level
- These modify the SHIP's output, not module costs

### Category 2: Module Cost Reduction Skills (decrease demand)
- Weapon Upgrades: reduces PG need of weapon modules
- Advanced Weapon Upgrades: further reduces weapon PG need
- Electronics Upgrades: reduces CPU need of certain modules
- Energy Grid Upgrades: reduces CPU need of certain modules

**The critical mistake:** Computing "hull CPU × 1.25" (for Management V) and
comparing against raw SDE module costs. This OVERSTATES the CPU/PG usage because
it ignores Category 2 skills that reduce what modules actually consume.

**The correct approach:**
- If MCP tools are available: compute the approximate budget (hull × skill bonus),
  total the raw SDE module costs, and note the margin is APPROXIMATE because
  module cost reduction skills are not factored in
- Always flag that the fitting window is the ground truth
- Never declare "this doesn't fit" based solely on manual math — if it's close
  (within ~15%), it likely fits once module reduction skills are applied
- When the user reports fitting window numbers, trust those over calculations


## Hull Bonuses Drive Fit Design

Hull bonuses are not flavor text — they fundamentally determine what a ship
should do. Always check bonuses before building a fit.

**Example (Atron):**
- +10% Small Hybrid Turret falloff per Gallente Frigate level
- +5% Small Hybrid Turret damage per level
- 80% reduction in Propulsion Jamming activation cost

These bonuses make the Atron a rail kiter: the falloff bonus extends rail range
dramatically, the damage bonus rewards hybrid weapons, and the tackle cap
reduction means the Warp Disruptor is nearly free to run. Building a blaster
brawler on this hull wastes the falloff bonus entirely.

**Anti-pattern:** Fitting shield modules on an armor-bonused hull (or vice versa)
without understanding why. Sometimes it's correct (kite fits shield-tank to keep
lows free for damage), but the reasoning must be explicit, not accidental.


## Tank Philosophy by Role

### Brawlers (close range, scram+web, high DPS)
- Armor tank in the lows (plates, reps, hardeners)
- Lows used for tank + damage (Damage Control, Magnetic Field Stabilizer, rep)
- Mids for tackle (scram, web) + prop mod
- Rigs for tank support (armor reps, resist)

### Kiters (long range, point, speed)
- Shield buffer in the mids (shield extender) OR no tank at all
- Lows FREE for damage mods (Mag Stab, Drone Damage Amp) + speed (Nanofiber)
- Why: armor modules (plates, rigs) add mass and slow the ship — fatal for kiters
- Shield rigs reduce armor HP (irrelevant) not speed
- Armor rigs reduce max velocity — directly undermines kiting

### The rule: Tank goes where it doesn't compete with the ship's primary need.
- Brawlers need DPS + tank → armor in lows, tackle in mids
- Kiters need DPS + speed → damage in lows, shield (if any) in mids


## Module Naming Conventions

EVE module names follow patterns, but Claude frequently gets them wrong.
Always verify exact names via SDE search before including in a fit.

**Common errors to avoid:**
- "75mm Railgun" — does not exist. Small railguns are 125mm or 150mm
- "Small Anti-EM Screen Reinforcer" — verify this is a real rig name
- Mixing shield rig names with armor rig names
- Using a hybrid weapon rig name on a projectile weapon fit (or vice versa)

**Module tiers and when to use each:**
- **T2 (Tech II):** Best stats, highest fitting cost (CPU/PG). Use when budget allows.
- **Meta/Compact:** Lower fitting costs, slightly worse stats. Use when T2 doesn't fit.
  Named variants like "IFFA Compact Damage Control" or "J5 Enduring Warp Disruptor"
  save significant CPU/PG for small stat losses.
- **Faction/Navy:** Best stats AND reasonable fitting costs, but expensive ISK.
  Good for ammo (Caldari Navy Antimatter) but expensive for modules while learning.
- **Deadspace/Officer:** Best-in-slot stats, extreme prices. Rarely worth it
  on throwaway hulls; legitimate on escalation/hero ships.
- **Abyssal (mutated):** Stats roll within a range per mutaplasmid — and
  they are NOT in the SDE by display name. `parse_eft`/`check_fitting` skip
  them with a warning, so budgets under-count an abyssal module. Verify
  abyssal fits in the in-game window.

**The practical rule:** Start with all-T2, check if it fits. If CPU/PG is over,
swap the highest-CPU module to its compact variant first. Common high-CPU culprits
on frigates: Warp Disruptor II (44 tf), Damage Control II (30 tf), Sensor Booster II
(16 tf). Their compact variants save 4-10 CPU each.


## Ammo Selection for Hybrid Weapons

### Blasters (short range)
- **Void:** Maximum damage, minimum range/tracking. Point-blank only (~1-2km usable).
  Only load when orbiting at 500m with web applied.
- **Null:** Lower damage, extended falloff. Usable at medium range (~5-8km depending
  on gun size and skills). NOT a kiting ammo — still short range.
- **Caldari Navy Antimatter:** Good damage, better range than Void, expensive.
  General-purpose close combat ammo.

### Railguns (long range)
- **Spike:** Maximum range, lowest damage and tracking. The kiting ammo.
  Load for engagements at 15-20km+.
- **Javelin:** Maximum damage, minimum range. Close-range rail ammo.
- **Caldari Navy Antimatter/Tungsten/Thorium:** Various range/damage trade-offs.

**The lesson learned:** A blaster ship loaded with Void at 10km+ does ZERO damage.
Always carry multiple ammo types and swap based on engagement range. A kiter
should default to Spike and carry Antimatter for emergencies.


## Drone Verification

**Never assume a hull has drones.** Always check:
- `droneCapacity` (m³) — how many drones fit in the bay
- `droneBandwidth` (Mbit/sec) — how many can be active simultaneously
- Light drones typically use 5 m³ bay and 5 Mbit/sec bandwidth each

**Known drone-less hulls that are commonly assumed to have drones:**
- Atron (0 bay, 0 bandwidth)
- Catalyst (0 bay, 0 bandwidth)

**Drone-primary hulls (drones are the main weapon):**
- Tristan (large bay for a frigate, 5 light drones active)
- Algos (destroyer drone boat)
- Vexor (cruiser drone boat)

Including drones on a hull that can't field them is a recurring error.
Always verify before adding drones to a fit.


## Fit Coherence Check

Before presenting any fit, verify internal coherence:

1. **Range coherence:** Do ALL modules work at the same engagement range?
   - A web (10km) on a ship planning to orbit at 20km is incoherent
   - A neut (6km) on a kite fit (20km) is incoherent
   - A tracking disruptor (any range) on a missile/drone ship is incoherent
   (tracking disruptors only affect turrets)

2. **Tank coherence:** Is the tank in one layer, not split?
   - A shield rig + an armor rig with neither tank built = wasted slots
   - Pick shield OR armor and commit

3. **Weapon system coherence:** Do rigs match the weapon type?
   - Hybrid rigs on projectile weapons = zero benefit
   - A hull-bonused weapon system ignored for an unbonused one = wasted potential

4. **Skill coherence:** Can the character actually use these modules?
   - Check trained skills via ESI before recommending T2 modules
   - T2 weapons need the specialization skill (e.g., Small Blaster Specialization)
   - Drones need Drones skill at the right level to field the desired count


## Workflow: Building a Fit

1. **Identify the role** (brawler/kiter/EWAR/support)
2. **Check hull data from SDE:**
   - Slot layout (high/mid/low/rig + turret/launcher hardpoints)
   - Drone bay and bandwidth
   - Hull bonuses
   - CPU output, PG output, calibration capacity
3. **Check character skills** (via ESI if available, or ask the user)
4. **Build the fit around the hull bonuses and role:**
   - Weapons first (use all turret/launcher hardpoints)
   - Prop mod + tackle (mandatory for PvP)
   - Tank (armor for brawl, shield/none for kite)
   - Damage mods in remaining lows
   - Rigs last (check calibration budget)
5. **Verify fitting math — run `check_fitting`** (it applies skill levels
   and rig drawbacks; its report lists what's unmodeled). Fallback without
   tools: raw SDE costs vs ship output × skill bonus, noting the margin is
   pessimistic because cost-reduction skills aren't factored; the fitting
   window stays ground truth.
6. **If over budget:**
   - Swap highest-CPU/PG module to compact/meta variant
   - Consider a fitting rig (Processor Overclocking Unit for CPU,
     Ancillary Current Router for PG)
   - Drop one damage mod for a fitting mod
   - Never drop tackle to fit damage
7. **Verify coherence** (range, tank, weapon system, skills)
8. **Present fit with honest caveats** about what's verified vs estimated


## Workflow: Reviewing a Killmail Fit

1. `get_killmail` (id + hash from `get_recent_killmails` or zkillboard)
2. `killmail_to_eft` — reconstructs the victim's full fit (destroyed +
   dropped) as EFT, charges re-attached to their guns via slot flags
3. `check_fitting` on that EFT — note the victim's skills are unknown;
   pass `skills` overrides (yours, or all-V for an upper bound) and say
   which assumption you used
4. Coherence check as for any fit — but the framing is doctrine: what was
   this fit trying to do, did the killer's class counter it, and what ONE
   change most improves it?
5. If recommending a replacement: verify it with `check_fitting` (and
   `price_fitting` for the ISK check) before presenting.

## Using MCP/SDE Tools

When EVE SDE MCP tools are available, use them for EVERY hull and module lookup — the tools' own descriptions cover each interface; what matters here is the query recipes and the order of operations. Fitting-loop tools: `check_fitting` (exact budget), `killmail_to_eft` (loss review), `price_fitting` (acquisition cost), `parse_eft` (preview), `save_fitting`/`delete_fitting`/`get_fittings` (in-game list).

**SDE attribute query recipes (the non-obvious filters):**
- Slot counts: filter "slot" on hull type
- CPU/PG output: filter "cpu" / "power" on hull type
- CPU/PG cost: filter "cpu" / "power" on module type
- Drone bay: filter "drone" → droneCapacity (m³), droneBandwidth (Mbit/sec)
- Calibration capacity: filter "calibration" → upgradeCapacity on hull
- Calibration cost: filter "upgrade" → upgradeCost on rig
- Rig drawback: filter "drawback" on rig (typically 10% for T1)

**Workflow with MCP:**
1. `search_types` to find the hull type ID
2. `get_type` for bonuses and description
3. `get_type_attributes` with "slot" filter for layout
4. `get_type_attributes` with "drone" filter for drone capability
5. `get_type_attributes` with "calibration" filter for rig budget
6. `search_types` for each module, then `compare_types` for fitting costs
7. `check_skill_requirements` against the active character
8. `check_fitting` for the exact budget (before presenting — not after)
9. `parse_eft` to validate before `save_fitting`; `price_fitting` when the
   ISK cost of the fit matters

## Common Fitting Mistakes (All Encountered in Practice)

1. **Stating slot counts from memory** → wrong slots → fit doesn't work
2. **Adding drones to drone-less hulls** → Hobgoblin in an Atron
3. **Forgetting rig calibration** → fit looks good on CPU/PG but rigs won't install
4. **Two hybrid weapon rigs on a T1 frigate** → 400 calibration, no room for anything else
5. **Shield rig + armor rig on the same fit** → split tank, wasted slots
6. **Web on a 20km kiter** → module can't reach at engagement range
7. **Neut on a kiter** → 6km range, kiting at 20km, never fires
8. **Wrong ammo for engagement range** → Void at 10km = zero damage
9. **Declaring "doesn't fit" from raw SDE math** → ignoring module cost reduction skills — run check_fitting; it exists for exactly this
10. **Using module names from memory** → "75mm Railgun" doesn't exist
11. **Fitting projectile weapons on a hybrid-bonused hull** → wasting hull bonus
12. **Not checking turret hardpoints vs high slots** → trying to fit 4 guns in 3 hardpoints
