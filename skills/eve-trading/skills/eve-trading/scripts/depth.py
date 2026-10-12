#!/usr/bin/env python3
"""
depth.py — order-book depth, fill test and hold break-even for specific items.

    python scripts/depth.py 4383 56076 [--orders orders.json]
        Depth checklist (workflow-new-candidates.md, step 4): the ask ladder with each order's age,
        the best competing bids, the 8-day history, and the margin at the top and durable ask.
        Look for: a fresh undercut over a settled price, stale asks, a thin top then a gap, a big
        queue of bids ahead, an average price that just stepped.

    python scripts/depth.py --diff 340 4383 56076 [--orders orders.json]
        Two-snapshot fill test: pull the buy side, wait SECONDS (about 5 minutes is plenty for an
        active item), pull again and report the units sold into each bid between the snapshots.
        This is direct evidence that sellers are hitting buy orders there — use it when the A4E
        Sold2Buy columns and the live book disagree, or before arguing that a bid will not fill.

    python scripts/depth.py --breakeven 14174:18778571:7 37849:2231322:30
        For stock held back from sale (TYPE:COST_PER_UNIT:UNITS): the sell price that breaks even
        after 1.5% broker and 3.4% tax, the prices for a 10/15/20% margin, the live ask against
        them, and the days in the last two weeks whose HIGH reached break-even.
"""

from __future__ import annotations

import argparse
import sys
import time

import market
import portfolio

SELL_NET = 1 - market.SELL_FEE - market.SALES_TAX


def money(p: float) -> str:
    return f"{p / 1e6:.3f}M" if p >= 1e5 else f"{p:,.0f}"


def cmd_depth(type_ids, mine) -> int:
    resolve_name = _names(type_ids)
    now = market.now_utc()
    for t in type_ids:
        bk, h = market.book(t), market.hist(t)
        if bk is None or h is None:
            print(f"== {t}: fetch failed")
            continue
        asks, bids = market.asks_of(bk), market.bids_of(bk, mine)
        if not asks or not bids:
            print(f"== {resolve_name.get(t, t)} ({t}): one-sided book")
            continue
        bid = bids[0]["price"] + market.tick(bids[0]["price"])
        ask, dur = asks[0]["price"], market.durable_ask(asks)
        print(f"== {resolve_name.get(t, t)} ({t}) bid {bid:,.0f} ask {ask:,.0f} durable(>=3u) {dur:,.0f} "
              f"nm@ask {market.nm(bid, ask):.1f} nm@dur {market.nm(bid, dur):.1f}")
        age = lambda o: f"{(now - market.parse_iso(o['issued'])).total_seconds() / 3600:.0f}h"
        print("  asks:", [(money(o["price"]), o["volume_remain"], age(o)) for o in asks[:6]])
        print("  bids:", [(money(o["price"]), o["volume_remain"], age(o)) for o in bids[:5]],
              f"| bid orders {len(bids)} | ask orders {len(asks)}")
        young = [o for o in bids if o["price"] >= bids[0]["price"] * market.NEAR_TOP
                 and o["volume_remain"] < o["volume_total"] and (now - market.parse_iso(o["issued"])).total_seconds() < 86400]
        print(f"  fresh partly-filled bids near the top: {len(young)}",
              [(money(o["price"]), o["volume_total"] - o["volume_remain"]) for o in young[:4]])
        rows = sorted(h, key=lambda r: r["date"])[-8:]
        print("  hist (date low avg high vol):", [(r["date"][5:], money(r["lowest"]), money(r["average"]), money(r["highest"]), r["volume"]) for r in rows])
    return 0


def _snapshot(type_ids, mine):
    out = {}
    for t in type_ids:
        bk = market.book(t) or []
        out[t] = {o["order_id"]: (o["price"], o["volume_remain"], o["location_id"])
                  for o in market.bids_of(bk, mine)}
    return out


def cmd_diff(seconds: int, type_ids, mine) -> int:
    names = _names(type_ids)
    a = _snapshot(type_ids, mine)
    t0 = market.now_utc()
    print(f"snapshot A {t0:%H:%M:%S}Z; waiting {seconds}s…", flush=True)
    time.sleep(seconds)
    b = _snapshot(type_ids, mine)
    print(f"snapshot B {market.now_utc():%H:%M:%S}Z")
    for t in type_ids:
        sold, lines = 0, []
        for oid, (price, rem, loc) in a[t].items():
            if oid in b[t]:
                d = rem - b[t][oid][1]
                if d > 0:
                    sold += d
                    lines.append((price, d, rem, b[t][oid][1], loc))
            else:
                lines.append((price, None, rem, 0, loc))     # filled out or cancelled
        top = max((v[0] for v in a[t].values()), default=0)
        print(f"\n== {names.get(t, t)} ({t}): best bid {top:,.0f}; units sold into buy orders between snapshots: {sold}")
        for price, d, r0, r1, loc in sorted(lines, reverse=True)[:8]:
            what = f"SOLD INTO {d}" if d else "order gone (filled out or cancelled)"
            print(f"   bid {price:>12,.0f}: remain {r0} -> {r1}  ({what})  {'Jita 4-4' if loc == market.JITA else 'elsewhere'}")
    return 0


def cmd_breakeven(specs) -> int:
    for spec in specs:
        t, cost, units = spec.split(":")
        t, cost, units = int(t), float(cost), int(units)
        bk, h = market.book(t), market.hist(t)
        asks = market.asks_of(bk or [])
        if not asks:
            print(f"== {t}: no asks")
            continue
        be = cost / SELL_NET
        dur = market.durable_ask(asks)
        print(f"\n== {_names([t]).get(t, t)} ({t}) x{units} | cost {cost:,.0f}/unit | break-even sell {be:,.0f} | "
              + " | ".join(f"{m}%: {cost * (1 + m / 100) / SELL_NET:,.0f}" for m in (10, 15, 20)))
        print(f" live: best ask {asks[0]['price']:,.0f}, durable {dur:,.0f} ({(dur * SELL_NET / cost - 1) * 100:+.1f}% margin at the durable ask); "
              f"units asking under break-even: {sum(o['volume_remain'] for o in asks if o['price'] < be)}")
        for r in sorted(h or [], key=lambda r: r["date"])[-14:]:
            print(f"   {r['date']} low {r['lowest']:,.0f} avg {r['average']:,.0f} high {r['highest']:,.0f} vol {r['volume']}"
                  + ("   <-- reached break-even" if r["highest"] >= be else ""))
    return 0


def _names(type_ids) -> dict:
    try:
        import sqlite3
        from pathlib import Path
        con = sqlite3.connect(str(Path.home() / ".eve-sde" / "eve.db"))
        marks = ",".join(str(int(t)) for t in type_ids)
        return {r[0]: r[1] for r in con.execute(f"select typeID,typeName from invTypes where typeID in ({marks})")}
    except Exception:
        return {}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Depth checklist, two-snapshot fill test, hold break-even")
    ap.add_argument("type_ids", nargs="*", type=int)
    ap.add_argument("--orders", help="get_character_orders result; the character's own bids are excluded from the book")
    ap.add_argument("--diff", type=int, metavar="SECONDS")
    ap.add_argument("--breakeven", nargs="+", metavar="TYPE:COST:UNITS")
    args = ap.parse_args(argv)
    mine = {b["order_id"] for b in portfolio.load_orders(args.orders)["buys"]} if args.orders else set()
    if args.breakeven:
        return cmd_breakeven(args.breakeven)
    if not args.type_ids:
        ap.error("give at least one type id")
    return cmd_diff(args.diff, args.type_ids, mine) if args.diff else cmd_depth(args.type_ids, mine)


if __name__ == "__main__":
    sys.exit(main())
