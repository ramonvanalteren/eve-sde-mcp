"""Offline tests for the live-market scripts (market, a4e, portfolio, scan_candidates, review_portfolio).

No network and no character data: books, history and A4E pages are small synthetic fixtures.
The A4E URLs are also checked against the ones written in workflow-new-candidates.md, so the
script and the document cannot drift apart.

Stdlib only:  python3 -m unittest discover -s skills/eve-trading/tests -v
"""

import datetime
import json
import os
import re
import sqlite3
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

    def test_traded_price_is_the_five_day_volume_weighted_average(self):
        rows = [dict(date=f"2026-10-{i + 1:02d}", lowest=1, average=a, highest=9999, volume=v)
                for i, (a, v) in enumerate([(500, 10)] * 5 + [(1000, 100), (1000, 100), (800, 300), (800, 300), (900, 200)])]
        stats = market.history_stats(rows, 900, 1000)
        self.assertAlmostEqual(stats["vwap5"], (1000 * 100 * 2 + 800 * 300 * 2 + 900 * 200) / (100 * 2 + 300 * 2 + 200))
        # no volume at all falls back to the plain mean instead of dividing by zero
        flat = [dict(r, volume=0) for r in rows]
        self.assertAlmostEqual(market.history_stats(flat, 900, 1000)["vwap5"], (1000 + 1000 + 800 + 800 + 900) / 5)

    def test_analyse_reports_the_margin_at_the_traded_price(self):
        hist = history(10, 1000)                        # traded at 1,000 every day
        v = market.analyse(1, self.book(), hist, now=NOW)
        self.assertAlmostEqual(v["nm_real"], market.nm(v["bid"], 1000.0))
        # an ask far above where the item trades: the traded-price margin is far below the ask margin
        v2 = market.analyse(1, [order(3, 800, 50, buy=True), order(4, 1500, 5), order(5, 1510, 5)], history(10, 1000), now=NOW)
        self.assertLess(v2["nm_real"], v2["nm_ask"] - 20)

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
        # volume cells 400 (BuyfSell) / 73 (Sold2Buy); trades cells 67 (BuyfSell) / 50 (Sold2Buy)
        row = ["Large Micro Jump Drive", "", "480.000", "21,2", "2.265.000", "2.745.000", "322", "900.000.000", "7", "4,8", "7,1",
               "", "", "", "", "", "", "400", "73", "", "", "67", "50", "", "", "", "", "", ""]
        html = "<table>" + tr(header) + tr(row) + "</table>"
        parsed = [a4e.parse_row(c) for c in a4e.table_rows(html)]
        self.assertIsNone(parsed[0])
        self.assertEqual(parsed[1]["name"], "Large Micro Jump Drive")
        self.assertEqual((parsed[1]["buy"], parsed[1]["sell"], parsed[1]["tr"]), (2265000.0, 2745000.0, 322.0))
        self.assertEqual((parsed[1]["s2b_vol"], parsed[1]["s2b_trd"], parsed[1]["d7buy"], parsed[1]["d7sell"]), (73.0, 50.0, 4.8, 7.1))

    def test_trades_pair_is_buyfsell_then_sold2buy_despite_the_page_header(self):
        """The page header says Sold2Buy, BuyfSell for the trades group, but the cells follow the volume group's order.

        Real row from the 2026-11-08 pull (cells 17-23: volumes 264 / 7, ratio 37,7; trades 44 / 2, ratio 22,0).
        Read the header's way, Sold2Buy would be 7 units over 44 trades, which cannot happen.
        """
        row = ["Small Trimark Armor Pump II", "", "475.440", "12,0", "3.946.000,00", "4.670.000,00", "108", "2.015.514.379", "3,0",
               "40,9", "3,2", "38,9", "-29,6", "1", "5", "2", "9", "264", "7", "37,7", "", "44", "2", "22,0", "-", "-", "-", "-", "0.4h"]
        self.assertEqual(len(row), len(a4e.COLUMNS))
        parsed = a4e.parse_row(a4e.table_rows("<table><tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr></table>")[0])
        self.assertEqual((parsed["s2b_vol"], parsed["s2b_trd"], parsed["b4s_vol"], parsed["b4s_trd"]), (7.0, 2.0, 264.0, 44.0))
        # units sold per side can never be below the trades that moved them, and the ratio cells agree with the labels
        self.assertGreaterEqual(parsed["s2b_vol"], parsed["s2b_trd"])
        self.assertGreaterEqual(parsed["b4s_vol"], parsed["b4s_trd"])
        self.assertAlmostEqual(parsed["b4s_vol"] / parsed["s2b_vol"], 37.7, delta=0.05)
        self.assertAlmostEqual(parsed["b4s_trd"] / parsed["s2b_trd"], 22.0, delta=0.05)

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

    def test_unlisted_stock_is_what_the_assets_feed_shows_at_the_station(self):
        # The feed leaves out units in sell orders, so nothing is subtracted for listings.
        assets = {1: {market.JITA: 10, 99: 3}, 2: {market.JITA: 5}, 3: {55: 4}}
        at_station, elsewhere = portfolio.unlisted_stock(assets)
        self.assertEqual(at_station, {1: 10, 2: 5})
        self.assertEqual(elsewhere, {1: {99: 3}, 3: {55: 4}})

    def test_load_assets_sums_repeated_locations_and_rows(self):
        grouped = {"assets": [{"typeId": 1, "quantity": 39, "locations": [
            {"locationId": market.JITA, "quantity": 7}, {"locationId": market.JITA, "quantity": 32}]}]}
        rows = {"assets": [dict(typeId=2, quantity=4, locationId=market.JITA), dict(typeId=2, quantity=6, locationId=market.JITA),
                           dict(typeId=2, quantity=1, locationId=99)]}
        with tempfile.TemporaryDirectory() as d:
            pg, pr = Path(d) / "g.json", Path(d) / "r.json"
            pg.write_text(json.dumps(grouped))
            pr.write_text(json.dumps(rows))
            self.assertEqual(portfolio.load_assets(pg), {1: {market.JITA: 39}})
            self.assertEqual(portfolio.load_assets(pr), {2: {market.JITA: 10, 99: 1}})

    def test_recently_listed_flags_orders_inside_the_feed_lag(self):
        sells = [dict(type_id=1, remain=1, issued=iso(0.5)), dict(type_id=2, remain=1, issued=iso(3)), dict(type_id=3, remain=1, issued=None)]
        self.assertEqual(portfolio.recently_listed(sells, NOW), {1})

    def test_held_stock_adds_unlisted_units_to_listed_ones(self):
        sells = [dict(type_id=1, remain=6), dict(type_id=1, remain=2), dict(type_id=2, remain=5)]
        self.assertEqual(portfolio.held_stock(sells, {1: 4, 3: 7}), {1: 12, 2: 5, 3: 7})


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

    def check(self, a=None, v=None, hv_floor=7.5, cancels=0, safe=False):
        return scan_candidates.evaluate(a or self.a4e_row(), v or self.live(), self.PARAMS, hv_floor, cancels, safe=safe)

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

    def test_swept_bid_fails_even_with_a_huge_margin_in_safe_mode(self):
        e = self.check(a=self.a4e_row(d7buy=-46.0), v=self.live(ask=1_600_000.0), safe=True)
        self.assertTrue(any("bid swept" in r for r in e["hard"]))

    def test_falling_ask_and_spiked_ask_fail(self):
        self.assertTrue(any("ask falling" in r for r in self.check(a=self.a4e_row(d7sell=-15.0))["hard"]))
        self.assertTrue(any("ask spike" in r for r in self.check(a=self.a4e_row(d7sell=30.0))["hard"]))

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

    def test_a_price_step_is_flagged_not_rejected(self):
        # the 15%+ step rejection was removed (2026-11-09); the repeat-open check replaced its role
        for step in (9.0, 16.0, 34.0):
            e = self.check(v=self.live(step2=step))
            self.assertEqual(e["hard"], [], step)
            self.assertTrue(any("stepped" in r for r in e["soft"]), step)
        self.assertFalse(any("stepped" in r for r in self.check(v=self.live(step2=5.0))["soft"]))

    def test_opened_twice_without_filling_fails_once_is_a_flag(self):
        self.assertTrue(any("without filling" in r for r in self.check(cancels=2)["hard"]))
        self.assertTrue(any("without filling" in r for r in self.check(cancels=3)["hard"]))
        once = self.check(cancels=1)
        self.assertEqual(once["hard"], [])
        self.assertTrue(any("cancelled under half filled" in r for r in once["soft"]))
        self.assertFalse(any("cancelled" in r for r in self.check(cancels=0)["soft"]))


    # ---- default (relaxed) mode against --safe ----------------------------------------------
    # T2 row: bid 8M. T3 row: bid 30M. T4+ row: bid 80M. Asks leave 13%+ margins; tr=40 keeps them out of the
    # high-velocity relaxation so the tier floors apply.
    def t2(self, **kw):
        return self.live(bid=8_000_000.0, ask=9_900_000.0, **kw)

    def t3(self, **kw):
        return self.live(bid=30_000_000.0, ask=38_000_000.0, **kw)

    def t4(self, **kw):
        return self.live(bid=80_000_000.0, ask=100_000_000.0, **kw)

    SLOW = dict(tr=40.0, s2b_vol=3.0, s2b_trd=2.0)

    def test_the_mode_is_reported_on_every_row(self):
        self.assertEqual(self.check()["mode"], "relaxed")
        self.assertEqual(self.check(safe=True)["mode"], "safe")

    def test_fill_checks_are_soft_flags_for_t2_and_t3_in_the_default_mode(self):
        for make in (self.t2, self.t3):
            row = self.a4e_row(**self.SLOW)
            e = self.check(a=row, v=make(fresh_fills=0))
            self.assertEqual(e["tier"] in ("T2", "T3"), True)
            self.assertEqual(e["hard"], [], make.__name__)
            self.assertTrue(any(r.startswith("slow fills S2B") for r in e["soft"]), make.__name__)
            self.assertIn("no fresh fills in top bids", e["soft"], make.__name__)

    def test_safe_mode_keeps_the_fill_checks_as_gates_in_every_tier(self):
        for make in (self.live, self.t2, self.t3):
            e = self.check(a=self.a4e_row(**self.SLOW), v=make(fresh_fills=0), safe=True)
            self.assertTrue(any(r.startswith("S2B") for r in e["hard"]), make.__name__)
            self.assertIn("no fresh fills in top bids", e["hard"], make.__name__)

    def test_t1_and_t4_keep_the_fill_checks_as_gates_in_the_default_mode(self):
        for make in (self.live, self.t4):
            e = self.check(a=self.a4e_row(tr=40.0, s2b_vol=3.0, s2b_trd=2.0), v=make(fresh_fills=0))
            self.assertTrue(any(r.startswith("S2B") for r in e["hard"]), make.__name__)
            self.assertIn("no fresh fills in top bids", e["hard"], make.__name__)

    def test_default_mode_caps_t2_t3_at_two_days_of_sold_to_buy_and_safe_mode_at_one(self):
        row = self.a4e_row(tr=400.0, s2b_vol=40.0)
        self.assertEqual(self.check(a=row, v=self.t2())["units"], 80)
        self.assertEqual(self.check(a=row, v=self.t2(), safe=True)["units"], 40)
        self.assertEqual(self.check(a=row, v=self.live())["units"], 40)            # T1 keeps the one-day cap

    def test_expensive_rows_are_sized_in_pairs_in_the_default_mode_and_fives_in_safe_mode(self):
        row = self.a4e_row(tr=12.0, s2b_vol=5.0, s2b_trd=5.0)
        relaxed = self.check(a=row, v=self.t3())
        self.assertEqual(relaxed["units"], 4)
        self.assertEqual(relaxed["units"] % scan_candidates.EXPENSIVE_UNIT_INCREMENT, 0)
        self.assertEqual(self.check(a=row, v=self.t3(), safe=True)["units"], 5)

    def test_a_pair_is_not_thin_where_five_units_are(self):
        row = self.a4e_row(tr=6.0, s2b_vol=5.0, s2b_trd=5.0)
        self.assertIn("thin", self.check(a=row, v=self.t3(), safe=True)["hard"])
        self.assertNotIn("thin", self.check(a=row, v=self.t3())["hard"])
        self.assertIn("thin", self.check(a=row, v=self.live())["hard"])             # cheap rows still need fives

    def test_a_swept_bid_with_a_steady_ask_is_a_half_size_soft_flag_in_the_default_mode(self):
        steady = self.a4e_row(d7buy=-20.0, d7sell=0.0)
        e = self.check(a=steady)
        self.assertEqual(e["hard"], [])
        self.assertTrue(any(r.startswith("bid swept") for r in e["soft"]))
        self.assertEqual(e["units"], self.check(a=self.a4e_row())["units"] // 2)

    def test_a_swept_bid_still_rejects_when_the_ask_is_weakening_or_unknown_or_in_safe_mode(self):
        for d7sell in (-8.0, None):
            e = self.check(a=self.a4e_row(d7buy=-20.0, d7sell=d7sell))
            self.assertTrue(any(r.startswith("bid swept") for r in e["hard"]), d7sell)
        self.assertTrue(any(r.startswith("bid swept") for r in
                            self.check(a=self.a4e_row(d7buy=-20.0, d7sell=0.0), safe=True)["hard"]))

    def test_the_traded_price_margin_is_a_gate_in_the_default_mode_only(self):
        row = self.a4e_row(tr=40.0)                         # not high velocity: the T1 floor is 10
        v = self.live(ask=1_200_000.0)
        self.assertEqual(self.check(a=row, v=dict(v, nm_real=12.0))["hard"], [])
        near = self.check(a=row, v=dict(v, nm_real=9.5))     # inside the 1-point slack: flagged, not rejected
        self.assertEqual(near["hard"], [])
        self.assertTrue(any(r.startswith("traded-price margin") for r in near["soft"]))
        far = self.check(a=row, v=dict(v, nm_real=5.0))
        self.assertTrue(any(r.startswith("margin at traded price") for r in far["hard"]))
        self.assertEqual(self.check(a=row, v=dict(v, nm_real=5.0), safe=True)["hard"], [])
        self.assertEqual(self.check(a=row, v=v)["hard"], [])                      # no nm_real: test skipped

    def test_profit_and_rank_use_the_lower_of_ask_and_traded_price_in_the_default_mode(self):
        v = dict(self.live(ask=1_200_000.0), vwap5=1_100_000.0)
        relaxed, safe = self.check(v=v), self.check(v=v, safe=True)
        ppu = lambda price: price * 0.951 - 1_000_000.0 * 1.005
        self.assertAlmostEqual(relaxed["ppu"], ppu(1_100_000.0))
        self.assertAlmostEqual(safe["ppu"], ppu(1_200_000.0))
        self.assertAlmostEqual(relaxed["profit_at_ask"], ppu(1_200_000.0) * relaxed["units"])
        # a traded price above the ask never raises the figure
        self.assertAlmostEqual(self.check(v=dict(v, vwap5=1_500_000.0))["ppu"], ppu(1_200_000.0))

    def test_the_price_after_fill_gates_are_identical_in_both_modes(self):
        for safe in (False, True):
            self.assertTrue(any("ask falling" in r for r in self.check(a=self.a4e_row(d7sell=-15.0), safe=safe)["hard"]))
            self.assertTrue(any("ask spike" in r for r in self.check(a=self.a4e_row(d7sell=30.0), safe=safe)["hard"]))
            self.assertTrue(any("stale" in r for r in self.check(v=self.live(stale_days=20.0), safe=safe)["hard"]))
            self.assertTrue(any("without filling" in r for r in self.check(cancels=2, safe=safe)["hard"]))
            self.assertTrue(any(r.startswith("margin") for r in self.check(v=self.live(ask=1_110_000.0), safe=safe)["hard"]))

    def test_the_safe_mode_matches_the_original_gate_set_on_a_slow_t3_row(self):
        e = self.check(a=self.a4e_row(**self.SLOW), v=self.t3(fresh_fills=0, nm_real=1.0), safe=True)
        self.assertEqual(sorted(h.split(" ")[0] for h in e["hard"]), ["S2B", "no"])   # S2B and fresh fills, nothing new

    def test_the_parser_defaults_to_the_relaxed_mode(self):
        self.assertFalse(scan_candidates.build_parser().parse_args(["--a4e-dir", "x"]).safe)
        self.assertTrue(scan_candidates.build_parser().parse_args(["--a4e-dir", "x", "--safe"]).safe)
        self.assertIn("SAFE", scan_candidates.mode_line(True))
        self.assertIn("DEFAULT", scan_candidates.mode_line(False))


class RepeatOpenCheck(unittest.TestCase):
    CHAR, OTHER = 111, 222

    def ledger(self, rows, path=":memory:"):
        con = sqlite3.connect(path)
        con.execute("create table orders (order_id integer primary key, character_id integer, type_id integer, "
                    "is_buy_order integer, volume_total integer, volume_remain integer, state text)")
        con.executemany("insert into orders values (?,?,?,?,?,?,?)", rows)
        con.commit()
        return con

    def test_counts_only_this_characters_buys_cancelled_under_half_filled(self):
        con = self.ledger([
            (1, self.CHAR, 7, 1, 100, 100, "cancelled"),     # never filled
            (2, self.CHAR, 7, 1, 100, 60, "cancelled"),      # 40% filled: counts
            (3, self.CHAR, 7, 1, 100, 40, "cancelled"),      # 60% filled: does not
            (4, self.CHAR, 7, 1, 100, 100, "expired"),       # not a cancel
            (5, self.CHAR, 7, 0, 100, 100, "cancelled"),     # a sell order
            (6, self.OTHER, 7, 1, 100, 100, "cancelled"),    # another character
            (7, self.CHAR, 7, 1, 100, None, "cancelled"),    # unknown remainder counts as unfilled
            (8, self.CHAR, 9, 1, 100, 100, "cancelled"),
        ])
        self.assertEqual(scan_candidates.cancel_count(con, self.CHAR, 7), 3)
        self.assertEqual(scan_candidates.cancel_count(con, self.CHAR, 9), 1)
        self.assertEqual(scan_candidates.cancel_count(con, self.CHAR, 5), 0)

    def test_the_character_is_found_from_the_open_buy_orders(self):
        con = self.ledger([(10, self.CHAR, 1, 1, 5, 5, "open"), (11, self.CHAR, 2, 1, 5, 5, "open"),
                           (12, self.OTHER, 3, 1, 5, 5, "open")])
        self.assertEqual(scan_candidates.infer_character(con, {10, 11}), self.CHAR)
        self.assertEqual(scan_candidates.infer_character(con, {12}), self.OTHER)
        self.assertIsNone(scan_candidates.infer_character(con, {99}))
        self.assertIsNone(scan_candidates.infer_character(con, set()))

    def test_the_status_line_says_when_the_check_is_off(self):
        con, char, line = scan_candidates.open_repeat_check("/nonexistent/ledger.db", None, {1})
        self.assertIsNone(con)
        self.assertIn("OFF", line)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ledger.db")
            self.ledger([(1, self.CHAR, 7, 1, 100, 100, "cancelled"), (2, self.CHAR, 7, 1, 100, 100, "cancelled"),
                         (3, self.CHAR, 8, 1, 100, 100, "open")], path).close()
            con, char, line = scan_candidates.open_repeat_check(path, None, {3})
            self.assertEqual(char, self.CHAR)
            self.assertIn("ON", line)
            self.assertIn("1 types", line)
            con.close()
            con, char, line = scan_candidates.open_repeat_check(path, None, set())
            self.assertIsNone(con)
            self.assertIn("OFF", line)


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
