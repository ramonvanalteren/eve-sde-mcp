"""Offline tests for the live-market scripts (market, a4e, portfolio, scan_candidates, review_portfolio).

No network and no character data: books, history and A4E pages are small synthetic fixtures.
The A4E URLs are also checked against the ones written in workflow-new-candidates.md, so the
script and the document cannot drift apart.

Stdlib only:  python3 -m unittest discover -s skills/eve-trading/tests -v
"""

import datetime
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "eve-trading"
sys.path.insert(0, str(SKILL / "scripts"))

import a4e  # noqa: E402
import market  # noqa: E402
import portfolio  # noqa: E402
import review_portfolio  # noqa: E402
import scan_candidates  # noqa: E402
import size_positions  # noqa: E402

NOW = datetime.datetime(2026, 10, 10, 12, 0, tzinfo=datetime.timezone.utc)


def iso(hours_ago):
    return (NOW - datetime.timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def order(oid, price, remain, total=None, buy=False, loc=market.JITA, hours=48, rng="station", system=30000142):
    return dict(order_id=oid, price=price, volume_remain=remain, volume_total=total or remain, is_buy_order=buy,
                location_id=loc, issued=iso(hours), range=rng, system_id=system)


def history(days=10, avg=1000.0, last=None):
    rows = []
    for i in range(days):
        a = last if (last is not None and i >= days - 2) else avg
        rows.append(dict(date=f"2026-10-{i + 1:02d}", lowest=a * 0.99, average=a, highest=a * 1.01, volume=500))
    return rows


class Formulae(unittest.TestCase):
    def test_nm_matches_the_documented_formula(self):
        buy, sell = 1_000_000, 1_200_000
        expected = (sell * 0.951 - buy * 1.005) / (buy * 1.005) * 100
        self.assertAlmostEqual(market.nm(buy, sell), expected)

    def test_break_even_sell_is_cost_over_net_factor(self):
        cost = 1_005_000  # a buy at 1,000,000 plus the 0.5% broker fee
        self.assertAlmostEqual(market.nm(1_000_000, cost / 0.951), 0.0, places=6)

    def test_tick(self):
        self.assertEqual(market.tick(2_265_000), 1_000)
        self.assertEqual(market.tick(560_500), 100)
        self.assertEqual(market.tick(500), 0.01)

    def test_reaches_jita(self):
        self.assertTrue(market.reaches_jita(order(1, 1, 1, buy=True)))
        self.assertTrue(market.reaches_jita(order(1, 1, 1, buy=True, loc=1, rng="region", system=1)))
        self.assertTrue(market.reaches_jita(order(1, 1, 1, buy=True, loc=market.PERIMETER, rng="1", system=market.PERI_SYS)))
        self.assertFalse(market.reaches_jita(order(1, 1, 1, buy=True, loc=market.PERIMETER, rng="station", system=market.PERI_SYS)))
        self.assertFalse(market.reaches_jita(order(1, 1, 1, buy=True, loc=5, rng="40", system=999)))

    def test_tier_of_uses_the_strategy_boundaries(self):
        tiers = size_positions.load_params()["tiers_isk_per_unit"]
        self.assertEqual(market.tier_of(1_000_000, tiers), "T1")
        self.assertEqual(market.tier_of(6_000_000, tiers), "T2")
        self.assertEqual(market.tier_of(30_000_000, tiers), "T3")


class Analyse(unittest.TestCase):
    def book(self):
        return [
            order(1, 860, 5, buy=True, loc=market.PERIMETER, rng="1", system=market.PERI_SYS, hours=2),
            order(2, 850, 20, total=40, buy=True, loc=market.PERIMETER, rng="1", system=market.PERI_SYS, hours=3),
            order(3, 800, 50, buy=True, hours=90),
            order(4, 1000, 3, hours=1), order(5, 1002, 30, hours=60), order(6, 1100, 10, hours=70),
            order(7, 700, 5, buy=True, loc=market.PERIMETER, rng="1", system=market.PERI_SYS, hours=1),   # mine
        ]

    def test_competitive_bid_excludes_own_orders_and_new_bid_leads_by_a_tick(self):
        v = market.analyse(1, self.book(), history(), mine={7}, now=NOW)
        self.assertEqual(v["comp"], 860)
        self.assertEqual(v["bid"], 860 + market.tick(860))
        self.assertEqual(v["ask"], 1000)
        self.assertEqual(v["nb"], 3)

    def test_fresh_fills_count_young_partly_filled_bids_near_the_top(self):
        v = market.analyse(1, self.book(), history(), now=NOW)
        self.assertEqual(v["fresh_fills"], 1)          # order 2 is young and partly filled; order 1 is untouched
        self.assertEqual(v["fresh_units"], 20)

    def test_durable_ask_skips_a_lone_outlier(self):
        asks = market.asks_of([order(1, 900, 1), order(2, 1000, 5)])
        self.assertEqual(market.durable_ask(asks, 3), 1000)

    def test_one_sided_and_short_history_are_reported_not_guessed(self):
        self.assertEqual(market.analyse(1, [order(1, 5, 1)], history(), now=NOW)["err"], "one-sided")
        self.assertEqual(market.analyse(1, self.book(), history(2), now=NOW)["err"], "short-history")
        self.assertEqual(market.analyse(1, None, history(), now=NOW)["err"], "fetch")

    def test_price_step_in_the_last_day_is_detected(self):
        flat = market.history_stats(history(10, 1000), 900, 1000)
        stepped = market.history_stats(history(10, 1000, last=1250), 900, 1250)
        self.assertLess(flat["step2"], 1)
        self.assertGreater(stepped["step2"], 15)

    def test_sell_reference_falls_back_to_recent_highs_when_the_ask_is_new(self):
        hist = history(10, 1000)                       # highs ~1010
        v = market.analyse(1, [order(3, 800, 50, buy=True), order(4, 1500, 5), order(5, 1510, 5)], hist, now=NOW)
        self.assertLess(v["sell_ref"], v["ask"])       # the 1,500 ask has not traded: use the median high


class A4EParsing(unittest.TestCase):
    def test_numbers_are_european(self):
        self.assertEqual(a4e.to_number("1.234.567"), 1234567.0)
        self.assertEqual(a4e.to_number("-46,5"), -46.5)
        self.assertEqual(a4e.to_number("12,5%"), 12.5)
        self.assertIsNone(a4e.to_number("Buy"))

    def test_row_and_header_parsing(self):
        def tr(cells):
            return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"

        header = ["Name"] + ["h"] * (len(a4e.COLUMNS) - 1)
        row = ["Large Micro Jump Drive", "", "480.000", "21,2", "2.265.000", "2.745.000", "322", "900.000.000", "7", "4,8", "7,1",
               "", "", "", "", "", "", "400", "73", "", "", "67", "50", "", "", "", "", "", ""]
        html = "<table>" + tr(header) + tr(row) + "</table>"
        parsed = [a4e.parse_row(c) for c in a4e.table_rows(html)]
        self.assertIsNone(parsed[0])
        self.assertEqual(parsed[1]["name"], "Large Micro Jump Drive")
        self.assertEqual((parsed[1]["buy"], parsed[1]["sell"], parsed[1]["tr"]), (2265000.0, 2745000.0, 322.0))
        self.assertEqual((parsed[1]["s2b_vol"], parsed[1]["s2b_trd"], parsed[1]["d7buy"], parsed[1]["d7sell"]), (73.0, 67.0, 4.8, 7.1))

    def test_tier_urls_match_the_ones_in_workflow_new_candidates(self):
        text = (SKILL / "reference" / "workflow-new-candidates.md").read_text(encoding="utf-8")
        in_doc = set(re.findall(r"`(https://dev\.adam4eve\.eu/margin_finder\.php[^`]+)`", text))
        for tier in ("t1", "t2", "t3"):
            self.assertIn(a4e.tier_url(tier, 1), in_doc, f"{tier} URL in a4e.py differs from workflow-new-candidates.md")
        self.assertIn(a4e.hv_url(1), in_doc, "the high-velocity URL in a4e.py differs from workflow-new-candidates.md")


class CharacterFiles(unittest.TestCase):
    def test_orders_shape_from_the_tool_result(self):
        raw = {"orders": [
            dict(orderId=1, typeId=10, typeName="A", price=5, volumeRemain=2, volumeTotal=4, locationId=market.PERIMETER, issued=iso(1), isBuyOrder=True, escrow=10),
            dict(orderId=2, typeId=11, typeName="B", price=6, volumeRemain=1, volumeTotal=1, locationId=market.JITA, issued=iso(1), isBuyOrder=False),
        ]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "orders.json"
            p.write_text(json.dumps(raw))
            o = portfolio.load_orders(p)
        self.assertEqual([b["type_id"] for b in o["buys"]], [10])
        self.assertEqual([s["type_id"] for s in o["sells"]], [11])

    def test_transactions_are_merged_deduplicated_and_sorted_newest_first(self):
        a = {"transactions": [dict(transactionId=1, date="2026-10-09T10:00:00Z", typeId=1, quantity=1, unitPrice=1, total=1, isBuy=True)]}
        b = [dict(transactionId=1, date="2026-10-09T10:00:00Z", typeId=1, quantity=1, unitPrice=1, total=1, isBuy=True),
             dict(transactionId=2, date="2026-10-10T10:00:00Z", typeId=1, quantity=1, unitPrice=1, total=1, isBuy=False)]
        with tempfile.TemporaryDirectory() as d:
            pa, pb = Path(d) / "a.json", Path(d) / "b.json"
            pa.write_text(json.dumps(a))
            pb.write_text(json.dumps(b))
            tx = portfolio.load_tx(pa, pb)
        self.assertEqual([t["transactionId"] for t in tx], [2, 1])

    def test_bounded_cost_uses_only_the_newest_lots_that_cover_the_held_units(self):
        buys = [dict(date="2026-10-09", quantity=35, unitPrice=705_600), dict(date="2026-10-01", quantity=38, unitPrice=1_350_000)]
        avg, got, lots = portfolio.bounded_cost(buys, 35)
        self.assertEqual((avg, got, len(lots)), (705_600, 35, 1))          # the Badger case: do not blend all 73 units
        avg, got, _ = portfolio.bounded_cost(buys, 100)
        self.assertEqual(got, 73)                                           # history shorter than the holding: say so

    def test_unlisted_stock_splits_station_and_elsewhere(self):
        assets = {1: {market.JITA: 10, 99: 3}, 2: {market.JITA: 5}, 3: {55: 4}}
        sells = [dict(type_id=1, remain=6), dict(type_id=2, remain=5)]
        at_station, elsewhere = portfolio.unlisted_stock(assets, sells)
        self.assertEqual(at_station, {1: 4})
        self.assertEqual(elsewhere, {1: {99: 3}, 3: {55: 4}})


class Gates(unittest.TestCase):
    PARAMS = size_positions.load_params()

    def a4e_row(self, **kw):
        row = dict(name="X", tr=200.0, s2b_vol=60.0, s2b_trd=40.0, d7buy=0.0, d7sell=0.0)
        row.update(kw)
        return row

    def live(self, **kw):
        v = dict(t=1, bid=1_000_000.0, ask=1_150_000.0, nb=25, ns=25, vol3=500.0, fresh_fills=2, near=5, stale_days=2.0,
                 top_units=20, gap=None, range8=3.0, step2=0.0, nm_sup=lambda: 0)
        v.update(kw)
        v["nm_ask"] = market.nm(v["bid"], v["ask"])
        v.setdefault("sell_ref", v["ask"])
        v["nm_sup"] = market.nm(v["bid"], v["sell_ref"])
        return v

    def check(self, a=None, v=None, hv_floor=7.5, cancels=0):
        return scan_candidates.evaluate(a or self.a4e_row(), v or self.live(), self.PARAMS, hv_floor, cancels)

    def test_a_clean_row_passes_and_is_sized_to_the_band(self):
        e = self.check()
        self.assertEqual(e["hard"], [])
        self.assertEqual(e["tier"], "T1")
        self.assertEqual(e["units"] % self.PARAMS["unit_increment"], 0)
        lo, hi = self.PARAMS["sizing_band_pct_of_daily_trades"]
        self.assertLessEqual(e["units"], 200 * hi / 100)

    def test_units_are_capped_at_one_day_of_sold_to_buy_volume(self):
        e = self.check(a=self.a4e_row(tr=400.0, s2b_vol=40.0))
        self.assertEqual(e["units"], 40)

    def test_low_sold_to_buy_fails(self):
        self.assertTrue(any("S2B" in r for r in self.check(a=self.a4e_row(s2b_vol=15.0))["hard"]))
        self.assertTrue(any("S2B" in r for r in self.check(a=self.a4e_row(s2b_trd=10.0))["hard"]))

    def test_no_fresh_fills_in_the_top_bids_fails(self):
        self.assertIn("no fresh fills in top bids", self.check(v=self.live(fresh_fills=0))["hard"])

    def test_swept_bid_fails_even_with_a_huge_margin(self):
        e = self.check(a=self.a4e_row(d7buy=-46.0), v=self.live(ask=1_600_000.0))
        self.assertTrue(any("bid swept" in r for r in e["hard"]))

    def test_falling_ask_and_spiked_ask_fail(self):
        self.assertTrue(any("ask falling" in r for r in self.check(a=self.a4e_row(d7sell=-15.0))["hard"]))
        self.assertTrue(any("ask spike" in r for r in self.check(a=self.a4e_row(d7sell=30.0))["hard"]))
        self.assertTrue(any("stepped" in r for r in self.check(v=self.live(step2=16.0))["hard"]))

    def test_margin_floor_and_the_high_velocity_relaxation(self):
        v = self.live(ask=1_110_000.0)                     # about 4% at this bid: under every floor
        self.assertTrue(any(r.startswith("margin") for r in self.check(v=v)["hard"]))
        v = self.live(ask=1_152_000.0)                     # about 9%: under the 10% T1 floor, over the 7.5% relaxed floor
        self.assertAlmostEqual(market.nm(v["bid"], v["ask"]), 9.0, delta=1.0)
        self.assertTrue(any(r.startswith("margin") for r in self.check(v=v, hv_floor=None)["hard"]))
        relaxed = self.check(v=v, hv_floor=7.5)
        self.assertEqual(relaxed["hard"], [])
        self.assertIn("HV floor", relaxed["soft"])

    def test_relaxation_needs_real_velocity(self):
        v = self.live(ask=1_152_000.0, nb=8)               # a thin buy side is not "high velocity"
        self.assertTrue(any(r.startswith("margin") for r in self.check(v=v)["hard"]))
        self.assertTrue(any(r.startswith("margin") for r in self.check(a=self.a4e_row(tr=60.0), v=v)["hard"]))

    def test_t3_floor_and_carve_out(self):
        self.assertEqual(scan_candidates.entry_floor("T3", 20, 10, False, None), (13.0, False))
        self.assertEqual(scan_candidates.entry_floor("T3", 60, 30, False, None), (10.0, False))
        self.assertEqual(scan_candidates.entry_floor("T2", 60, 30, False, None), (11.0, False))

    def test_thin_stale_and_cancelled_items_fail(self):
        self.assertIn("thin", self.check(a=self.a4e_row(tr=8.0))["hard"])
        self.assertTrue(any("stale" in r for r in self.check(v=self.live(stale_days=20.0))["hard"]))
        self.assertTrue(any("cancels" in r for r in self.check(cancels=2)["hard"]))


class ReviewHints(unittest.TestCase):
    def test_hints(self):
        self.assertEqual(review_portfolio.verdict_hint(15, 16, 10), "ok")
        self.assertEqual(review_portfolio.verdict_hint(5.5, 6.0, 10), "KILL?")          # clear breach
        self.assertEqual(review_portfolio.verdict_hint(9.6, 10.4, 10), "EDGE")          # straddles the floor
        self.assertEqual(review_portfolio.verdict_hint(9.4, 9.6, 10), "EDGE")           # under a point below it


class SkillMentionsItsScripts(unittest.TestCase):
    def test_every_script_is_named_in_skill_md(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        missing = [p.name for p in sorted((SKILL / "scripts").glob("*.py")) if p.name not in skill]
        self.assertEqual(missing, [], "scripts not mentioned in SKILL.md: " + ", ".join(missing))


if __name__ == "__main__":
    unittest.main()
