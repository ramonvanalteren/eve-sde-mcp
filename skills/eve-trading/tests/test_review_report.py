"""Offline tests for scripts/review_report.py: section placement, totals and the snapshot comparison.

Stdlib only:  python3 -m unittest discover -s skills/eve-trading/tests -v
"""

import datetime
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "eve-trading"
sys.path.insert(0, str(SKILL / "scripts"))

import market  # noqa: E402
import review_portfolio  # noqa: E402
import review_report  # noqa: E402

NOW = datetime.datetime(2026, 11, 20, 12, 0, tzinfo=datetime.timezone.utc)
M = 1_000_000.0


def ago(days):
    return NOW - datetime.timedelta(days=days)


def iso(days):
    return ago(days).strftime("%Y-%m-%dT%H:%M:%SZ")


def level(price, units=10, buy=False, oid=None, days=1.0):
    return dict(order_id=oid or int(price) + units + (1 if buy else 0), price=price, volume_remain=units, volume_total=units,
                is_buy_order=buy, location_id=market.JITA, issued=iso(days), range="station", system_id=30000142)


def history():
    return [dict(date=f"2026-11-{i:02d}", lowest=9 * M, average=10 * M, highest=11 * M, volume=300) for i in range(1, 15)]


def book(ask, bid, thin_top=None):
    rows = [level(ask, 10), level(bid, 5, buy=True)]
    if thin_top:
        rows.append(level(thin_top, 1))
    return rows, history()


def buy(order_id, type_id, price=10 * M, remain=10, total=10, days=1.0, loc=market.PERIMETER):
    return dict(order_id=order_id, type_id=type_id, name=f"Item {type_id}", price=price, remain=remain, total=total,
                location=loc, issued=iso(days), range="1")


def tx(type_id, units, days, is_buy=True, price=10 * M):
    return dict(transactionId=int(type_id * 1000 + units * 10 + days * 100), date=iso(days), typeId=type_id,
                quantity=units, unitPrice=price, isBuy=is_buy, dt=ago(days))


GOOD, BAD = 14 * M, 11 * M          # asks over a 10M bid: about 32% and about 4% net


class Report(unittest.TestCase):
    def setUp(self):
        # 1 converting, 2 floor breach, 3 new without fills, 4 old without fills, 5 breach only on a thin top ask,
        # 6 a week old without fills, 7 sell-only stock
        buys = [buy(101, 1, remain=5, days=6), buy(102, 2, days=6), buy(103, 3, days=0.3), buy(104, 4, days=20),
                buy(105, 5, days=6), buy(106, 6, days=9)]
        sells = [dict(order_id=201, type_id=7, name="Item 7", price=15 * M, remain=4, total=4, location=market.JITA,
                      issued=iso(2), range="region")]
        self.orders = dict(buys=buys, sells=sells)
        self.data = {1: book(GOOD, 9.9 * M), 2: book(BAD, 9.9 * M), 3: book(GOOD, 9.9 * M), 4: book(GOOD, 10.5 * M),
                     5: book(GOOD, 9.9 * M, thin_top=BAD), 6: book(GOOD, 9.9 * M), 7: book(12 * M, 9 * M)}
        self.tx = [tx(1, 5, 1.0), tx(2, 3, 2.0), tx(5, 4, 1.0), tx(7, 6, 5.0, price=13 * M)]
        self.names = {t: f"Item {t}" for t in range(1, 10)}
        self.assets = {7: {market.JITA: 2}, 8: {99: 5}, 9: {market.JITA: 3}}

    def build(self, **kw):
        args = dict(orders=self.orders, data=self.data, tx=self.tx, first_seen={}, assets=self.assets, a4e_rows={},
                    names=self.names, wallet=1000 * M, now=NOW, ignore={9})
        args.update(kw)
        return review_report.build(**args)

    def section(self, text, title):
        start = text.index(title)
        rest = text[start + len(title):]
        ends = [i for i in (rest.find("\n## "), rest.find("\n### "), rest.find("\n**Consolidation")) if i >= 0]
        return rest[: min(ends)] if ends else rest

    def test_every_skeleton_section_is_present_in_order(self):
        text, _ = self.build()
        titles = ["**Snapshot:**", "## Workflow 2", "### Kill", "### Increase", "### Hold, converting",
                  "### Hold, no or few fills", "### Hold, too early", "**Consolidation candidates**", "## Workflow 3",
                  "## Workflow 4", "## Workflow 5"]
        positions = [text.index(t) for t in titles]
        self.assertEqual(positions, sorted(positions))

    def test_orders_land_in_the_right_table(self):
        text, _ = self.build()
        kill = self.section(text, "### Kill")
        self.assertIn("`Item 2`", kill)                      # under the floor everywhere
        self.assertIn("`Item 4`", kill)                      # no fills for the whole lookback
        self.assertIn("zero fills in 20.0d", kill)
        self.assertIn("a competing bid at 10.5M is above the order", kill)
        for name in ("`Item 1`", "`Item 3`", "`Item 5`", "`Item 6`"):
            self.assertNotIn(name, kill)
        self.assertIn("`Item 1`", self.section(text, "### Hold, converting"))
        self.assertIn("`Item 3`", self.section(text, "### Hold, too early"))
        self.assertIn("`Item 6`", self.section(text, "### Hold, no or few fills"))
        self.assertIn("durable ask gives", text)             # item 5: the thin top ask is flagged, not killed

    def test_kill_totals_and_the_book_after_them(self):
        text, _ = self.build()
        self.assertIn("2 orders, 20 units, 200.0M freed. After them: 4 buys", text)
        self.assertIn("cash 1,200.0M", text)

    def test_the_own_price_margin_shows_only_when_the_two_straddle_the_floor(self):
        row = dict(nm=9.5, nm_own=10.4, floor=10.0, hv=False)
        self.assertEqual(review_report.margin_cell(row), "9.5% (own 10.4%)")
        self.assertEqual(review_report.margin_cell(dict(row, nm_own=9.9)), "9.5%")

    def test_a_legacy_jita_buy_uses_the_jita_fee(self):
        perimeter = review_report.margin(10 * M, GOOD)
        jita = review_report.margin(10 * M, GOOD, market.SELL_FEE)
        self.assertAlmostEqual(perimeter, market.nm(10 * M, GOOD))
        self.assertLess(jita, perimeter)
        self.orders["buys"][0]["location"] = market.JITA
        self.assertIn("Buys outside Perimeter HQ", self.build()[0])

    def test_age_comes_from_the_first_seen_date_not_the_repriced_issued(self):
        text, _ = self.build(first_seen={103: ago(30)})
        self.assertIn("`Item 3`", self.section(text, "### Kill"))
        self.assertIn("zero fills in 30.0d", text)

    def test_sell_table_uses_bounded_cost_and_unlisted_stock_is_reported(self):
        text, _ = self.build()
        sell = self.section(text, "## Workflow 3")
        self.assertIn("6 (4 listed / 2 unlisted)", sell)
        self.assertIn("Underwater", sell)                    # 12M ask nets 11.4M against a 13M cost
        risk = self.section(text, "## Workflow 4")
        self.assertIn("| `Item 7` | 2 | 24M |", risk)
        self.assertNotIn("`Item 9`", risk)                   # ignored production stock
        self.assertIn("5 `Item 8`", risk)                    # stock elsewhere

    def test_without_assets_the_report_says_it_is_incomplete(self):
        self.assertIn("**No --assets:**", self.build(assets=None)[0])

    def test_an_empty_book_still_renders_every_section(self):
        text, _ = self.build(orders=dict(buys=[], sells=[]), data={}, assets={})
        self.assertGreaterEqual(text.count("None."), 6)

    def test_an_item_without_a_book_is_named_not_dropped(self):
        del self.data[1]
        text, _ = self.build()
        self.assertIn("Not checkable: `Item 1`", text)

    def test_the_next_run_reports_what_changed_since_the_snapshot(self):
        _, first = self.build(wallet=900 * M, now=ago(2))
        self.orders["buys"] = self.orders["buys"][1:] + [buy(107, 1, days=0.1)]
        self.orders["buys"][0]["price"] = 10.1 * M
        text, _ = self.build(previous=first)
        line = next(l for l in text.splitlines() if l.startswith("**Snapshot:**"))
        for part in ("wallet +100.0M", "bought 90M", "no sales", "1 repriced", "orders gone: `Item 1`", "new orders: `Item 1`"):
            self.assertIn(part, line)
        self.assertIn("no earlier snapshot", self.build()[0])


class Ledger(unittest.TestCase):
    def test_first_seen_dates_and_transactions_come_from_the_owning_character(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ledger.db")
            con = sqlite3.connect(path)
            con.execute("create table orders (order_id integer primary key, character_id integer, issued text)")
            con.execute("create table wallet_transactions (transaction_id integer primary key, character_id integer, "
                        "date text, type_id integer, quantity integer, unit_price real, is_buy integer)")
            con.execute("insert into orders values (101, 5, '2026-11-01T00:00:00Z')")
            con.executemany("insert into wallet_transactions values (?,?,?,?,?,?,?)",
                            [(1, 5, "2026-11-02T00:00:00Z", 1, 2, 3.0, 1), (2, 6, "2026-11-02T00:00:00Z", 1, 2, 3.0, 1)])
            con.commit()
            con.close()
            seen, rows = review_report.read_ledger(path, {101})
        self.assertEqual(list(seen), [101])
        self.assertEqual([r["transactionId"] for r in rows], [1])

    def test_no_ledger_means_nothing_read(self):
        self.assertEqual(review_report.read_ledger("/nonexistent/ledger.db", {1}), ({}, []))

    def test_report_needs_a_wallet(self):
        self.assertEqual(review_portfolio.main(["report", "--orders", "unused.json"]), 2)


if __name__ == "__main__":
    unittest.main()
