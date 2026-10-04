"""Guards for the eve-trading skill's single source of truth for strategy parameters.

The parameter values live in one JSON block in reference/strategy.md. These tests
fail if the script's defaults drift from it, if another file repeats a value that
should only be stated there, or if the skill's frontmatter or links break.

Stdlib only:  python3 -m unittest discover -s skills/eve-trading/tests -v
"""

import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "eve-trading"
sys.path.insert(0, str(SKILL / "scripts"))

import size_positions as sp  # noqa: E402

DOCS = [SKILL / "SKILL.md", *sorted((SKILL / "reference").glob("*.md"))]
# strategy.md owns the values; failure-cases.md is history and may quote what happened.
VALUE_OWNERS = {"strategy.md", "failure-cases.md"}

# Phrases that state a parameter value. Each must appear only in the owner files.
REPEATED_VALUE_PATTERNS = {
    "sizing band": r"\b\d+\s*[-–]\s*\d+\s*%\s+of\b.{0,45}daily trade",
    "comfortable order range": r"\b\d+\s*[-–]\s*\d+\s+open\s+buy",
    "profit-per-slot floor": r"\b\d+M\s+(?:profit\s+)?per\s+(?:full\s+)?cycle|\bfloor\s*\(\d+M\)",
    "tier boundaries": r"T1\s+0\.5\s*[-–]\s*5M|T2\s+5\s*[-–]\s*20M|T3\s+20\s*[-–]\s*50M",
    "order-count note threshold": r"\babove\s+60\b",
}


def run_quietly(*args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return sp.size_positions(*args, **kwargs)


class ParameterBlock(unittest.TestCase):
    def test_block_loads_and_is_sane(self):
        p = sp.load_params()
        lo, hi = p["sizing_band_pct_of_daily_trades"]
        self.assertTrue(0 < lo < hi <= 100)
        self.assertGreater(p["unit_increment"], 0)
        self.assertIn(p["rank_by"], ("yield", "profit", "input"))
        self.assertGreater(p["min_profit_per_slot_isk"], 0)
        olo, ohi = p["comfortable_order_range"]
        self.assertTrue(0 < olo < ohi)
        self.assertTrue(0 < p["fewer_orders_variant_profit_share"] <= 1)
        t = p["tiers_isk_per_unit"]
        self.assertEqual(t["T1"][1], t["T2"][0])
        self.assertEqual(t["T2"][1], t["T3"][0])

    def test_script_defaults_follow_the_block(self):
        p = sp.load_params()
        result = run_quietly([("Probe", 1_000_000, 10, 15.0, 100, 150_000, "")], wallet=1e9)
        got = result["parameters"]
        self.assertEqual(got["unit_increment"], p["unit_increment"])
        self.assertEqual(got["rank_by"], p["rank_by"])
        self.assertEqual(got["trade_share_band"], tuple(p["sizing_band_pct_of_daily_trades"]))
        self.assertEqual(got["min_profit_per_slot"], p["min_profit_per_slot_isk"])
        self.assertEqual(got["order_range"], tuple(p["comfortable_order_range"]))
        self.assertEqual(got["max_open_orders"], p["max_open_orders"])
        self.assertEqual(got["t3_share_flag_pct"], p["t3_share_flag_pct"])
        self.assertEqual(got["variant_profit_share"], p["fewer_orders_variant_profit_share"])

    def test_tier_of_uses_the_block_boundaries(self):
        t = sp.load_params()["tiers_isk_per_unit"]
        self.assertEqual(sp.tier_of(t["T1"][0] - 1), "micro")
        self.assertEqual(sp.tier_of(t["T1"][0]), "T1")
        self.assertEqual(sp.tier_of(t["T2"][0]), "T2")
        self.assertEqual(sp.tier_of(t["T3"][0]), "T3")
        self.assertEqual(sp.tier_of(t["T3"][1]), "T4+")


class DocsDoNotRepeatValues(unittest.TestCase):
    def test_parameter_values_appear_only_in_the_owner_files(self):
        offenders = []
        for doc in DOCS:
            if doc.name in VALUE_OWNERS:
                continue
            text = doc.read_text(encoding="utf-8")
            for name, pattern in REPEATED_VALUE_PATTERNS.items():
                for m in re.finditer(pattern, text, re.I):
                    offenders.append(f"{doc.name}: repeats the {name} ({m.group(0)!r}) — refer to it by name")
        self.assertEqual(offenders, [], "\n".join(offenders))


class SkillStructure(unittest.TestCase):
    def frontmatter(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        m = re.match(r"---\n(.*?)\n---\n", text, re.S)
        self.assertIsNotNone(m, "SKILL.md has no YAML frontmatter")
        return m.group(1)

    def test_frontmatter_limits(self):
        fm = self.frontmatter()
        name = re.search(r"^name:\s*(\S+)\s*$", fm, re.M).group(1)
        desc = re.search(r'^description:\s*"(.*)"\s*$', fm, re.M | re.S).group(1)
        self.assertRegex(name, r"^[a-z0-9-]{1,64}$")
        self.assertTrue(0 < len(desc) <= 1024, f"description is {len(desc)} characters")
        self.assertNotRegex(desc, r"[<>]")

    def test_description_is_third_person_and_names_the_triggers(self):
        desc = self.frontmatter().lower()
        for opener in ("use this skill", "i can", "you can"):
            self.assertNotIn(f'description: "{opener}', desc)
        for trigger in ("portfolio review", "kill list", "redeploy", "refresh", "day close", "strategy", "a4e", "tier"):
            self.assertIn(trigger, desc, f"description does not mention {trigger!r}")

    def test_relative_file_links_resolve(self):
        missing = []
        for doc in DOCS:
            text = doc.read_text(encoding="utf-8")
            for m in re.finditer(r"\]\(([^)\s#]+\.md)(?:#[^)]*)?\)", text):
                if not (doc.parent / m.group(1)).resolve().exists():
                    missing.append(f"{doc.name} -> {m.group(1)}")
        self.assertEqual(missing, [])

    def test_report_templates_and_checklists_are_present(self):
        review = (SKILL / "reference" / "workflow-portfolio-review.md").read_text(encoding="utf-8")
        plan = (SKILL / "reference" / "capital-allocation.md").read_text(encoding="utf-8")
        self.assertIn("Report skeleton and pre-send checklist", review)
        self.assertIn("Pre-send checklist:", review)
        self.assertIn("Plan skeleton and pre-send checklist", plan)
        self.assertIn("Pre-send checklist:", plan)


if __name__ == "__main__":
    unittest.main()
