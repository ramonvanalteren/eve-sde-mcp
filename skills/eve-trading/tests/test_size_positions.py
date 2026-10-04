"""Regression tests for scripts/size_positions.py (stdlib only).

The main fixture is the 4 Oct 2026 kill-and-redeploy plan: its totals were
checked by hand in that session, so they are the landmarks the arithmetic must
keep hitting.

    python3 -m unittest discover -s skills/eve-trading/tests -v
"""

import contextlib
import io
import json
import random
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "skills" / "eve-trading" / "scripts" / "size_positions.py"
FIXTURE = HERE / "fixtures" / "redeploy_2026-10-04.json"
sys.path.insert(0, str(SCRIPT.parent))

import size_positions as sp  # noqa: E402


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def fixture_kwargs(**overrides):
    kwargs = sp._plan_to_kwargs(load_fixture())
    kwargs.update(overrides)
    return kwargs


def run(**kwargs):
    """Call size_positions, returning (result, printed output)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = sp.size_positions(**kwargs)
    return result, buf.getvalue()


def row(name="Item", price=5_000_000, units=10, margin=20.0, trades=50, ppu=None, note=""):
    """A candidate whose profit_per_unit is consistent with its margin."""
    return (name, price, units, margin, trades, ppu if ppu is not None else round(price * 1.005 * margin / 100), note)


class RedeployPlanReproduction(unittest.TestCase):
    def setUp(self):
        self.result, self.out = run(**fixture_kwargs())

    def test_cash_math(self):
        self.assertEqual(self.result["pool"], 1_415_400_000 + 1_095_100_000)
        self.assertEqual(self.result["total"], 2_049_327_000)
        self.assertEqual(self.result["buffer"], 2_510_500_000 - 2_049_327_000)
        self.assertEqual(len(self.result["rows"]), 16)
        self.assertEqual(self.result["excluded"], [])

    def test_profit_is_the_sum_of_rounded_units_times_profit_per_unit(self):
        expected = sum(r["profit_per_unit"] * r["units"] for r in self.result["rows"])
        self.assertEqual(self.result["total_profit"], expected)
        self.assertAlmostEqual(self.result["total_profit"] / 1e6, 480.0, delta=0.1)

    def test_rows_are_ranked_by_yield_descending(self):
        yields = [r["yield_m_per_1m_day"] for r in self.result["rows"]]
        self.assertEqual(yields, sorted(yields, reverse=True))
        self.assertEqual(self.result["rows"][0]["name"], "Signal Amplifier II")
        self.assertEqual(self.result["rows"][-1]["name"], "Imperial Navy 800mm Steel Plates")

    def test_input_order_does_not_matter(self):
        baseline = [r["name"] for r in self.result["rows"]]
        for seed in range(5):
            kwargs = fixture_kwargs()
            shuffled = list(kwargs["candidates"])
            random.Random(seed).shuffle(shuffled)
            kwargs["candidates"] = shuffled
            result, _ = run(**kwargs)
            self.assertEqual([r["name"] for r in result["rows"]], baseline)

    def test_slot_discipline_summary(self):
        self.assertEqual(self.result["order_count_after"], 41)
        self.assertEqual(
            sorted(self.result["small_slot"]),
            ["720mm Howitzer Artillery II", "Ice Harvester I", "Signal Amplifier II"],
        )
        self.assertEqual(self.result["over_band"], [])
        mix = {tier: round(share) for tier, share in self.result["tier_mix_after"].items()}
        self.assertEqual(mix, {"T1": 17, "T2": 47, "T3": 35})
        self.assertEqual(self.result["variant"]["rows"], 9)
        self.assertEqual(self.result["variant"]["orders_after"], 34)
        self.assertEqual(self.result["variant"]["deployed"], 1_076_337_000)

    def test_parameters_line_is_printed_first(self):
        self.assertTrue(self.out.startswith("Parameters (reference/strategy.md):"))
        self.assertNotIn("above the 40-60", self.out)  # 41 orders is inside the comfortable range


class SizingRules(unittest.TestCase):
    def test_thin_item_exclusion_boundary(self):
        # minimum increment is 5 units: exactly half of 10 trades/day is allowed, more is thin
        ok, _ = run(candidates=[row("Ten", units=5, trades=10)], wallet=1e9)
        self.assertEqual([r["name"] for r in ok["rows"]], ["Ten"])
        for trades in (9.9, 8):
            result, _ = run(candidates=[row("Thin", units=5, trades=trades)], wallet=1e9)
            self.assertEqual(result["rows"], [])
            self.assertIn("thin", result["excluded_reasons"]["Thin"])

    def test_unknown_trades_per_day_skips_the_share_check(self):
        result, _ = run(candidates=[row("Unknown", units=5, trades=0)], wallet=1e9)
        self.assertEqual([r["name"] for r in result["rows"]], ["Unknown"])
        self.assertIsNone(result["rows"][0]["trade_share_pct"])

    def test_over_band_is_judged_at_whole_percent(self):
        at_ceiling, _ = run(candidates=[row("Edge", price=614_400, units=80, trades=159)], wallet=1e9)  # 50.3% -> 50
        self.assertEqual(at_ceiling["over_band"], [])
        over, _ = run(candidates=[row("Over", price=614_400, units=85, trades=159)], wallet=1e9)  # 53%
        self.assertEqual(over["over_band"], ["Over"])

    def test_units_round_to_the_increment_and_profit_uses_rounded_units(self):
        result, _ = run(candidates=[row("Odd", units=7, ppu=1_000_000, margin=20.0, price=4_975_000)], wallet=1e9)
        self.assertEqual(result["rows"][0]["units"], 5)  # 7 -> nearest multiple of 5
        self.assertEqual(result["rows"][0]["total_profit"], 5_000_000)
        result, _ = run(candidates=[row("Tiny", units=1)], wallet=1e9)
        self.assertEqual(result["rows"][0]["units"], 5)  # never below one increment

    def test_buffer_walk_follows_rank_order_and_reports_why(self):
        cands = [row("First", price=10_000_000, units=10, trades=100, margin=30.0),
                 row("Second", price=10_000_000, units=10, trades=50, margin=30.0)]
        result, out = run(candidates=cands, wallet=250_000_000, buffer_target_isk=100_000_000)
        self.assertEqual([r["name"] for r in result["rows"]], ["First"])
        self.assertEqual(result["excluded_reasons"]["Second"], "breaches the buffer target")
        everything, _ = run(candidates=cands, wallet=250_000_000, buffer_target_isk=100_000_000, stop_at_buffer=False)
        self.assertEqual(len(everything["rows"]), 2)

    def test_freed_escrow_joins_the_pool_and_isk_buffer_beats_percent(self):
        result, _ = run(candidates=[row()], wallet=100_000_000, freed=50_000_000, buffer_target_isk=20_000_000, buffer_target_pct=90)
        self.assertEqual(result["pool"], 150_000_000)
        self.assertEqual(len(result["rows"]), 1)  # the 90% buffer would have excluded it
        by_pct, _ = run(candidates=[row()], wallet=100_000_000, buffer_target_pct=95)
        self.assertEqual(by_pct["rows"], [])

    def test_rank_modes(self):
        by_yield, _ = run(**fixture_kwargs())
        by_profit, _ = run(**fixture_kwargs(rank_by="profit"))
        self.assertEqual(by_yield["rows"][0]["name"], "Signal Amplifier II")
        self.assertEqual(by_profit["rows"][0]["name"], "Corpum A-Type EM Energized Membrane")
        kwargs = fixture_kwargs(rank_by="input")
        by_input, _ = run(**kwargs)
        self.assertEqual([r["name"] for r in by_input["rows"]], [c[0] for c in kwargs["candidates"]])
        legacy, _ = run(**fixture_kwargs(rank_by_profit=True))
        self.assertEqual(legacy["rows"][0]["name"], by_profit["rows"][0]["name"])

    def test_order_count_note_only_above_the_comfortable_range(self):
        _, inside = run(**fixture_kwargs(current_open_orders=25))
        _, above = run(**fixture_kwargs(current_open_orders=50))
        self.assertNotIn("above the 40-60", inside)
        self.assertIn("above the 40-60", above)
        _, capped = run(**fixture_kwargs(current_open_orders=25, max_open_orders=30))
        self.assertIn("cap 30 — OVER by 11", capped)

    def test_tier_flag_only_when_asked_for(self):
        _, quiet = run(**fixture_kwargs(current_tier_escrow={"T3": 3_000_000_000}))
        _, flagged = run(**fixture_kwargs(current_tier_escrow={"T3": 3_000_000_000}, t3_share_flag_pct=40))
        self.assertNotIn("ABOVE", quiet)
        self.assertIn("T3 ABOVE the 40% reference", flagged)

    def test_slot_floor_can_be_switched_off(self):
        result, _ = run(**fixture_kwargs(min_profit_per_slot=None))
        self.assertEqual(result["small_slot"], [])


class InputValidation(unittest.TestCase):
    def test_every_problem_is_reported_at_once(self):
        bad = [("X", "abc", 0, -1, 5, 100, ""), ("short", "row"), row("Good")]
        with self.assertRaises(sp.InputError) as ctx:
            run(candidates=bad, wallet=-5, freed="x", current_open_orders=-2)
        message = str(ctx.exception)
        for fragment in ("row 1 ('X'): unit_price", "row 1 ('X'): units", "row 1 ('X'): margin_pct",
                         "row 2: expected 7 values", "wallet must be", "freed must be", "current_open_orders must be"):
            self.assertIn(fragment, message)
        self.assertNotIn("Good", message)

    def test_booleans_and_nan_are_not_numbers(self):
        for bad_value in (True, float("nan"), float("inf"), None):
            with self.assertRaises(sp.InputError):
                run(candidates=[("X", 1_000_000, bad_value, 20.0, 50, 200_000, "")], wallet=1e9)

    def test_empty_candidate_list_is_rejected(self):
        with self.assertRaises(sp.InputError):
            run(candidates=[], wallet=1e9)

    def test_margin_that_does_not_match_its_profit_warns(self):
        result, out = run(candidates=[("Mismatch", 1_000_000, 10, 40.0, 50, 100_000, "")], wallet=1e9)
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("WARNING: Mismatch: margin_pct 40%", out)
        consistent, _ = run(candidates=[row()], wallet=1e9)
        self.assertEqual(consistent["warnings"], [])

    def test_repeated_name_warns(self):
        result, _ = run(candidates=[row("Twice"), row("Twice")], wallet=1e9)
        self.assertTrue(any("appears in rows 1 and 2" in w for w in result["warnings"]))

    def test_bad_buffers_are_rejected(self):
        for kwargs in ({"buffer_target_isk": -1}, {"buffer_target_isk": "400M"}, {"buffer_target_pct": 150}):
            with self.assertRaises(sp.InputError, msg=str(kwargs)):
                run(candidates=[row()], wallet=1e9, **kwargs)

    def test_bad_band_and_floor_are_rejected(self):
        with self.assertRaises(sp.InputError):
            run(candidates=[row()], wallet=1e9, trade_share_band=(60, 50))
        with self.assertRaises(sp.InputError):
            run(candidates=[row()], wallet=1e9, min_profit_per_slot=-1)


class CommandLine(unittest.TestCase):
    def cli(self, *args, stdin=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, input=stdin)

    def test_plan_file_prints_the_table(self):
        proc = self.cli(str(FIXTURE))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(proc.stdout, r"Total deployed:\s+2,049,327,000")
        self.assertIn("Fewer-orders variant: top 9 rows", proc.stdout)

    def test_json_output_is_structured(self):
        proc = self.cli(str(FIXTURE), "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(len(data["rows"]), 16)
        self.assertEqual(data["total"], 2_049_327_000)
        self.assertNotIn("Parameters (reference", proc.stdout)

    def test_example_is_a_valid_plan_and_reads_from_stdin(self):
        example = self.cli("--example")
        self.assertEqual(example.returncode, 0)
        proc = self.cli("-", stdin=example.stdout)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("SMALL-SLOT", proc.stdout)
        self.assertIn("Thin T3 example: thin", proc.stdout)

    def test_params_prints_the_block(self):
        proc = self.cli("--params")
        self.assertEqual(json.loads(proc.stdout), sp.PARAMS)

    def test_bad_inputs_exit_2_with_a_specific_message(self):
        not_json = self.cli("-", stdin="{nope")
        self.assertEqual(not_json.returncode, 2)
        self.assertIn("not valid JSON", not_json.stderr)
        unknown = self.cli("-", stdin=json.dumps({"wallet": 1, "candidates": [], "options": {"bogus": 1}}))
        self.assertEqual(unknown.returncode, 2)
        self.assertIn("unknown option 'bogus'", unknown.stderr)
        missing = self.cli("-", stdin=json.dumps({"wallet": 1e9, "candidates": [{"name": "Y", "unit_price": 1}]}))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("missing units, margin_pct, trades_per_day, profit_per_unit", missing.stderr)
        values = self.cli("-", stdin=json.dumps({"wallet": -1, "candidates": load_fixture()["candidates"][:1]}))
        self.assertEqual(values.returncode, 2)
        self.assertIn("wallet must be", values.stderr)

    def test_no_arguments_is_a_usage_error(self):
        proc = self.cli()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("give a plan file", proc.stderr)


if __name__ == "__main__":
    unittest.main()
