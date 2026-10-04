# eve-trading evals

Behavioural tests for the skill, run with `claude plugin eval` (Claude Code 2.1.269 or later). Each case is a realistic prompt plus graders; the harness runs it in an isolated session with only this plugin loaded and the `eve-sde` tools answered from recorded fixtures, so nothing touches ESI or a real character.

These complement the unit tests in `../tests/` (free, run in CI). Unit tests check the arithmetic and the docs; evals check what the model *does* with the skill.

## Run

From the repository root (every run is a real model call on your account; `results/` is git-ignored):

```bash
# authoring: one run, no baseline arm, cap the spend
claude plugin eval skills/eve-trading --trust-plugin --runs 1 --ablation none --max-cost-usd 5 --no-publish

# cheap smoke set (routing only), after any change to SKILL.md or the description
claude plugin eval skills/eve-trading --trust-plugin --tag routing --runs 1 --ablation none --no-publish

# before a release: default 3 runs per arm, with the no-plugin baseline (reports Δ)
claude plugin eval skills/eve-trading --trust-plugin --max-cost-usd 20 --no-publish -j 3
```

Add `--keep-temp` to keep each run's `out/trace.jsonl` (the full transcript) for debugging, and `--json out.json` for a machine-readable result.

## Layout

```
evals/
├── routing/   does the skill fire, and does it read the right reference?   (tags: routing, smoke)
├── format/    is the report in the agreed format with the right verdicts?   (tags: format, full)
├── traps/     one case per past mistake in reference/failure-cases.md       (tags: trap)
└── mocks/eve-sde/   recorded tool responses; fixtures/ holds the JSON
```

## The portfolio world

Every case that needs data reads the same frozen snapshot (character "Eval Trader", clock set to 2026-10-04T20:00:00Z by `append_system_prompt`). Every bought unit has a matching sale or is still held, so nothing looks "missing" — an early version without the sales made the model flag about 190 unaccounted units. Each position exists to exercise one rule:

| Position | Designed to test | Expected |
|---|---|---|
| 720mm Howitzer Artillery II | floor breach (live margin about 5.8%) | **Kill**, 13.95M freed |
| Signal Amplifier II | converting, order nearly empty (8 of 80 left) | **Increase** |
| Graviton Physics | proven converter but 20 of 25 still open, ~2 weeks of runway | **not** an Increase |
| Corpum C-Type Medium Energy Nosferatu | recent fills | Hold, converting |
| Coreli A-Type Small Armor Repairer | order issued today, but fills back to September (reprice) | judged on history, **not** "too early" |
| Osprey | one fill, most of the order open | Hold, no or few fills |
| Polarized Neutron Blaster Cannon | placed 2.5h ago, no history | Hold, too early |
| Badger | sell order only; 35 held, 73 ever bought (38 at ~1.35M, since sold; then 35 at 705,600) | Workflow 3: about +34% on the held lot, not −9% |
| Omnidirectional Tracking Link II | 20 units in the hangar, no sell order | Workflow 4: uncovered exposure |

## What the first measurements showed (October 2026)

Single runs are noisy; these use 2–6 runs per case with the default judge.

| Case | Result | What it told us |
|---|---|---|
| `format/full-portfolio-review` | 3 of 3 perfect with the skill; Δ **+0.78** (0.22 without it) | The skill is what produces the agreed format and verdicts |
| `traps/badger-bounded-cost-basis` | with 1.00, without 0.50 (Δ **+0.50**) | Without the skill the model sometimes blends all 73 units; the first prompt hinted the answer and scored 1.00 either way |
| `routing/undercut-out-of-scope` | **2 of 6 → 6 of 6** after one sentence in the description | The model was speculating about outbid orders or running a full review; the description now says to decline |
| `routing/portfolio-review-casual`, `routing/redeploy-plan` | perfect | The skill fires on casual phrasing and reads the right reference |

Cost: about $2.5 and 2.5 minutes for the whole suite at `-j 3`, one run per case, with no baseline arm.

## Cases tried and dropped

- `sell-only-not-a-buy-kill` ("which of my positions should I kill?") scored 1.00 with and without the skill, so it measured the model, not the skill. A case that fails without the skill needs a situation where the naive answer is wrong; a clean fixture doesn't create one.

## Conventions

- **One result grader and one process grader per case.** Check the answer (regex for structure and numbers, `llm` only for short PASS/FAIL rubrics) and the steps (`tool_used` / `tool_order`).
- **One claim per `llm` grader.** A rubric that bundles three or four claims fails whole when the small judge doubts one, and doesn't say which. Splitting one into seven took the review case from 0 of 3 to 3 of 3 perfect.
- **Assert facts, not phrasing.** Regexes match section names and numbers; rubrics list concrete PASS and FAIL conditions.
- **`tool_used: Skill` is a plugin-fired indicator**, not part of the score in a two-arm run. Use `arm: both` with `min: 0, max: 0` for a "must not do this" check.
- **New failure, new case.** When a failure case is added to `reference/failure-cases.md`, add the matching eval in `traps/` and, if the world lacks the situation, a position in `mocks/eve-sde/fixtures/`.
- Keep fixtures small: this directory ships inside the plugin.

## Things learned building the suite (October 2026)

- **Mocks work for a server the plugin does not declare.** The harness registers a standalone stand-in named `eve-sde`, so tools appear as `mcp__eve-sde__<tool>` (found through `ToolSearch`), the same names users have. A tool without a mock file is simply unavailable. `get_portfolio_margins` and `get_wallet_transactions` pick their fixture from the call's `location_id` / `type_id`; the `_` fixtures answer calls that omit them.
- **Bash cannot be granted on a machine whose managed settings disable the OS sandbox.** The harness refuses the whole run, so no case here runs `scripts/size_positions.py`; the script is covered by `../tests/test_size_positions.py`. Cases that need it must run where a sandbox backend exists (an unmanaged machine, or Linux with `bubblewrap` and `socat`).
- **`--judge-model sonnet` failed** on the first machine used (the alias resolved to a model the harness could not call). The default judge works; if you pin one, try a full model ID first.
- **A dated snapshot in a file the skill reads is treated as live state.** The first full-review run opened with a false "this book doesn't match the baseline we recorded" warning, taken from a baseline table in `reference/strategy.md`. Dated evidence now lives in `reference/strategy-evidence.md`, and a unit test keeps snapshots out of the files read on every review.
