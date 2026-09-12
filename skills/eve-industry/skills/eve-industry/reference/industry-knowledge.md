# Industry Knowledge — ME/TE, facilities, indices, research, invention

The reference layer the workflows draw on. Honest scope marker throughout: the MCP can verify blueprints, materials, products, skills, job lists, and system cost indices from the SDE/ESI; **facility bonuses and structure tax rates are in-game data the SDE does not carry** — verify those in the client, never from this file's generalities.

## Material Efficiency (ME) and Time Efficiency (TE)

- **ME** reduces material quantities per run: each level −1%, T1 BPO cap 10 (~10% less material). Quantities round **per material** (floor 1) — on small quantities the rounding eats the benefit; price_build shows the adjusted quantities so this is visible.
- **TE** reduces job duration: each level −1%, cap 20. TE pays where slots are the constraint (see slot economics in the production review), not where materials dominate cost.
- Research valuation: **ME pays on volume** (savings × units over the line's life), **TE pays on slot-time** (durations × batches through a constrained slot). A research job costs index-driven installation + the research slot's time — the founding audit flagged a 1.45M ISK TE job on a BPO whose production volume had not been proven large enough to amortize it. Every research job gets the same explicit payback statement a BPO acquisition gets.
- Copying exists to parallelize (build from copies in multiple facilities) or to feed invention; for a solo T1 operation, originals usually suffice.

## Facilities and structure bonuses

- **NPC stations**: fixed-install base index, no rig bonuses, typically higher tax; always available, no access risk.
- **Engineering complexes / structures**: rig bonuses (manufacturing time, material cost for T2 rigs; assembly arrays multiply specific lines) and player-set tax; access can change; the SDE has **no facility data** — structure bonuses and tax are read in the client (facility window) and are part of the facility's real margin.
- When a production line's margins are computed at Jita prices but installed in a structure, the installation number (in-client dialog) is the only trustworthy facility-cost figure — that's why price_build takes it as an explicit input.

## System cost indices

- Each system has a per-activity cost index; installation cost scales with the activity's estimated item value × index + facility tax. Indices move with system activity — busy trade-hub systems often run expensive indices.
- `get_industry_cost_indices` shows current indices; check before large or thin-margin batches. On a healthy line (+50%+) the index is noise; on a thin line it IS the margin — the founding dead line's installation was ~6% of unit cost.
- Index shopping (building in a cheap-index system nearby, hauling output to the sell hub) trades cost against haul risk and time — for a highsec operation one jump from Jita, usually only worth it on thin lines.

## Invention (T2)

- T2 blueprints are invented copies, not built: datacores (two sciences per blueprint — see get_blueprint activity 8) + an encryptor-type skill + the T1 item, with a skill-dependent success probability. Output is a limited-run T2 BPC.
- get_blueprint shows invention materials and skills per blueprint; T2 build margins then verify with price_build on the invented BPC's ME/runs (pass the BPC's actual runs and ME).
- Datacore cost is the dominant invention input and is priced like any material — the same margin discipline applies to the whole chain (invent cost ÷ success probability = expected BPC cost, amortized into the T2 line's economics).
- The same skills chain also gates T2 module production — check skill requirements with the tools before committing to an invention line.

## Reactions (note)

Reactions (moon mining chain, boosters) are the same discipline — materials in, product out, margin verified — with the added wrinkle that reaction input products often have thin books. Verify at the reaction's blueprint (get_blueprint) and expect the thin-book warnings to matter.

## Skills that matter for production operations

- **Industry** (job speed), **Advanced Mass Production** (+1 concurrent job per level) — slots are the scarce resource; more slots compound every healthy line.
- **Science** family for research; the encryption + science pairs for invention.
- **Metallurgy/Research** for ME/TE research speed.
- Verify character gaps with the skill-check tooling before planning a line that depends on them.

## The ledger and production (BOM linkage — shipped)

Delivered manufacturing jobs are bill-of-materials linked in the daily close: materials consume from FIFO buy lots oldest-first, a synthetic product lot is created at all-in basis (materials + installation / units), the close reports a production section, and per-position realized P&L on produced items is correct. Each job's BPO ME resolves automatically from the character's synced ESI blueprints (exact item match), with config `blueprintME` as type-keyed fallback and ME 0 as the conservative floor. Jobs count at delivery; research jobs stay journal cashflow; materials without buy basis are flagged, not guessed. Remaining honest gap: BPOs themselves sit as open positions at cost (capital assets — amortize them in candidate decisions, not the close).
