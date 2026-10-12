#!/usr/bin/env python3
"""
review_portfolio.py — live-margin tables for Workflows 2 and 3, and extension candidates.

    python scripts/review_portfolio.py buys   --orders orders.json --tx tx.json
    python scripts/review_portfolio.py sells  --orders orders.json --tx tx.json [--assets assets.json]
    python scripts/review_portfolio.py extend --orders orders.json --tx tx.json [--a4e-dir a4e/]

Common options: --killed IDS (never extended), --hv-floor 7.5 (default; --no-hv disables),
--a4e-dir DIR (adds A4E trades/day to the high-velocity test and the Sold2Buy evidence).
Inputs are the saved eve-sde tool results described in portfolio.py. Nothing is placed or
cancelled; every verdict is the caller's judgement — the `hint` column is only a prompt.

buys   One row per open buy order, from public ESI books (two-call margin at the competitive bid).
       nm@comp   margin at max(own price, best competing bid) against the top Jita ask — THE live margin
       nm@dur    the same against the durable ask (first price with >=3 units behind it)
       nm@own    margin at the order's own price against the top ask (shown because it matters when the
                 two straddle the floor)
       hint      KILL?  both nm@comp and nm@own are under the floor — go and spot-check the ask first
                 EDGE   the two straddle the floor, or the breach is under one point
                 ok     above the floor
       Kill verdicts rest on this live figure plus the character's own realized sells (realSell, last
       72h) — never on ESI-history "traded-level" margins, which lag by 1-2 days (see failure-cases.md).
       The floor is the flat hold floor; high-velocity rows (A4E >=100 trades/day, so pass --a4e-dir) use
       --hv-floor (user-directed relaxation).
sells  One row per type held for sale (sell orders + unlisted hangar stock): bounded weighted-average
       cost of the newest lots covering the held units, margin at the top and durable ask and at the
       character's own price, sales in the last 24h and since the feed began, and how many cheaper units
       sit ahead. `unl` is stock at Jita 4-4 with no sell order (needs --assets); stock elsewhere is listed
       separately because it cannot be sold until it is moved.
extend Held types ranked by days of cover (stock + open buy units over the 3-day sales pace) with live
       margin and A4E Sold2Buy evidence — candidates for an Increase, subject to the runway check.
"""

from __future__ import annotations

import argparse
import collections
import datetime
import sqlite3
import statistics
import sys
from pathlib import Path

import a4e
import market
import portfolio
import scan_candidates
import size_positions

HOLD_FLOOR = 10.0
EDGE_POINTS = 1.0


def verdict_hint(nm_comp: float, nm_own: float, floor: float) -> str:
    """KILL? / EDGE / ok — see the module docstring."""
    if nm_comp >= floor and nm_own >= floor:
        return "ok"
    if nm_comp < floor and nm_own < floor and floor - max(nm_comp, nm_own) >= EDGE_POINTS:
        return "KILL?"
    return "EDGE"


def sum_qty(tx, type_id, is_buy, since=None):
    return sum(x["quantity"] for x in tx
               if x["typeId"] == type_id and x["isBuy"] == is_buy and (since is None or x["dt"] >= since))


def context(args):
    orders = portfolio.load_orders(args.orders)
    tx = portfolio.load_tx(*args.tx) if args.tx else []
    killed = portfolio.parse_id_list(args.killed)
    a4e_rows = a4e.load_dir(args.a4e_dir, a4e.sde_resolver()) if args.a4e_dir else {}
    return orders, tx, killed, a4e_rows, (None if args.no_hv else args.hv_floor)


def names_for(type_ids):
    """{type_id: name} from the local SDE; empty when it is unavailable."""
    try:
        con = sqlite3.connect(str(Path.home() / ".eve-sde" / "eve.db"))
        marks = ",".join(str(int(t)) for t in type_ids)
        return {r[0]: r[1] for r in con.execute(f"select typeID,typeName from invTypes where typeID in ({marks})")}
    except Exception:
        return {}


def cmd_buys(args) -> int:
    orders, tx, killed, rows, hv_floor = context(args)
    params = size_positions.load_params()
    buys = orders["buys"]
    types = sorted({b["type_id"] for b in buys})
    names = names_for(types)
    mine = {b["order_id"] for b in buys}
    data = market.fetch_many(types)
    now = market.now_utc()
    out, esc_by_tier = [], collections.Counter()
    for b in buys:
        t, price = b["type_id"], b["price"]
        bk, h = data[t]
        asks, bids = market.asks_of(bk or []), market.bids_of(bk or [], mine)
        name = (names.get(t) or b["name"])[:36]
        esc = price * b["remain"]
        tier = market.tier_of(price, params["tiers_isk_per_unit"])
        esc_by_tier[tier] += esc
        if not asks or not bids or not h:
            out.append(dict(name=name, error="book/history unavailable", esc=esc, tier=tier))
            continue
        comp = bids[0]["price"]
        live_bid = max(price, comp)
        ask, ask_d = asks[0]["price"], market.durable_ask(asks)
        hs = market.history_stats(h, live_bid, ask)
        a = rows.get(t, {})
        nb, ns = len(bids), len(asks)
        # The relaxed floor needs A4E evidence of >=100 trades/day; without a row the flat hold floor applies.
        hv = bool(a) and scan_candidates.is_high_velocity(a.get("tr") or 0, hs["vol3"], nb, ns)
        floor = hv_floor if (hv and hv_floor is not None and hv_floor < HOLD_FLOOR) else HOLD_FLOOR
        nm_comp, nm_own = market.nm(live_bid, ask), market.nm(price, ask)
        sells72 = [x for x in tx if x["typeId"] == t and not x["isBuy"] and (now - x["dt"]).total_seconds() <= 72 * 3600]
        real = sum(x["total"] for x in sells72) / sum(x["quantity"] for x in sells72) if sells72 else None
        day = lambda d: now - datetime.timedelta(days=d)
        out.append(dict(
            name=name, t=t, tier=tier, price=price, rem=b["remain"], tot=b["total"], esc=esc, ask=ask, comp=comp,
            nm_comp=nm_comp, nm_dur=market.nm(live_bid, ask_d), nm_own=nm_own, sup=market.nm(live_bid, hs["med_hi"] if hs["ask_days"] < 2 else ask),
            floor=floor, hv=hv, hint="KILL?" if killed and t in killed else verdict_hint(nm_comp, nm_own, floor),
            filled=b["total"] - b["remain"], b24=sum_qty(tx, t, True, day(1)), b72=sum_qty(tx, t, True, day(3)),
            b10=sum_qty(tx, t, True), s10=sum_qty(tx, t, False), ahead=sum(o["volume_remain"] for o in bids if o["price"] > price),
            real=real, vol3=hs["vol3"], trend=hs["trend"], nb=nb, ns=ns,
        ))
    ok = [r for r in out if "error" not in r]
    total = sum(r["esc"] for r in out)
    zero = sum(r["esc"] for r in ok if r["filled"] == 0)
    mix = {k: f"{v / total * 100:.0f}%" for k, v in sorted(esc_by_tier.items())} if total else {}
    print(f"BUYS {len(buys)} | escrow {total / 1e6:,.0f}M (avg {total / max(len(buys), 1) / 1e6:.1f}M) | tier mix {mix} | "
          f"escrow with no fills since placement {zero / 1e6:,.0f}M ({zero / total * 100 if total else 0:.0f}%)")
    print(f"transactions feed ends {tx[0]['dt']:%m-%d %H:%M}Z — fills after that are not in the b24/b72 columns" if tx else "(no --tx: fill columns empty)")
    print(f"{'item':36s}{'t':>3s}{'price':>11s}{'rem/tot':>9s}{'esc M':>6s}{'nm@comp':>8s}{'nm@dur':>7s}{'nm@own':>7s}{'floor':>6s}{'fills':>6s}"
          f"{'b24/72/10d':>12s}{'s10d':>5s}{'ahead':>7s}{'v3':>6s}{'realSell':>11s}  hint")
    for r in sorted(ok, key=lambda r: -r["esc"]):
        print(f"{r['name']:36s}{r['tier']:>3s}{r['price']:11,.0f}{str(r['rem']) + '/' + str(r['tot']):>9s}{r['esc'] / 1e6:6.0f}"
              f"{r['nm_comp']:8.1f}{r['nm_dur']:7.1f}{r['nm_own']:7.1f}{r['floor']:6.1f}{r['filled']:6d}"
              f"{'%d/%d/%d' % (r['b24'], r['b72'], r['b10']):>12s}{r['s10']:5d}{r['ahead']:7d}{r['vol3']:6.0f}{(r['real'] or 0):11,.0f}  "
              f"{r['hint']}{' HV' if r['hv'] else ''}")
    for r in out:
        if "error" in r:
            print(f"ERR {r['name']}: {r['error']}")
    return 0


def cmd_sells(args) -> int:
    orders, tx, killed, rows, hv_floor = context(args)
    sells, buys = orders["sells"], orders["buys"]
    at_station, elsewhere, unl = {}, {}, {}
    if args.assets:
        at_station, elsewhere = portfolio.unlisted_stock(portfolio.load_assets(args.assets), sells)
        unl = at_station
    types = sorted({s["type_id"] for s in sells} | set(unl))
    names = names_for(types)
    data = market.fetch_many(types)
    now = market.now_utc()
    buy_types = {b["type_id"] for b in buys}
    rowsout = []
    for t in types:
        bk, h = data[t]
        asks = market.asks_of(bk or [])
        mine = [s for s in sells if s["type_id"] == t]
        listed = sum(s["remain"] for s in mine)
        held = listed + unl.get(t, 0)
        own = min((s["price"] for s in mine), default=None)
        ask = asks[0]["price"] if asks else None
        ask_d = market.durable_ask(asks) if asks else None
        buy_txs = [x for x in tx if x["typeId"] == t and x["isBuy"]]
        avg, got, _lots = portfolio.bounded_cost(buy_txs, held)
        net = lambda p: (p * (1 - market.SELL_FEE - market.SALES_TAX) / avg - 1) * 100 if (p and avg) else None
        s24 = sum_qty(tx, t, False, now - datetime.timedelta(days=1))
        sp = [x for x in tx if x["typeId"] == t and not x["isBuy"] and (now - x["dt"]).total_seconds() <= 86400]
        rowsout.append(dict(
            name=(names.get(t) or str(t))[:36], held=held, listed=listed, unl=unl.get(t, 0), own=own, ask=ask, ask_d=ask_d,
            avg=avg, got=got, m_dur=net(ask_d), m_own=net(own), s24=s24, s10=sum_qty(tx, t, False),
            real24=(sum(x["total"] for x in sp) / sum(x["quantity"] for x in sp)) if sp else None,
            v3=statistics.mean(r["volume"] for r in sorted(h, key=lambda r: r["date"])[-3:]) if h else 0,
            buyo=t in buy_types, cheaper=sum(o["volume_remain"] for o in asks if own and o["price"] < own),
        ))
    fm = lambda x, n=0: "-" if x is None else f"{x:,.{n}f}"
    print(f"{'item':36s}{'held':>5s}{'lst':>4s}{'unl':>4s}{'own':>12s}{'ask':>12s}{'dur ask':>12s}{'avg cost':>12s}{'got':>5s}"
          f"{'m@dur':>7s}{'m@own':>7s}{'s24h':>5s}{'sTot':>5s}{'real24h':>12s}{'v3':>6s}{'buyO':>5s}{'cheaper':>8s}")
    for r in sorted(rowsout, key=lambda r: -(r["held"] * (r["own"] or r["ask"] or 0))):
        flag = "  <- cost covers only %d of %d units" % (r["got"], r["held"]) if r["avg"] and r["got"] < r["held"] else ""
        print(f"{r['name']:36s}{r['held']:5d}{r['listed']:4d}{r['unl']:4d}{fm(r['own']):>12s}{fm(r['ask']):>12s}{fm(r['ask_d']):>12s}"
              f"{fm(r['avg']):>12s}{r['got']:5d}{fm(r['m_dur'], 1):>7s}{fm(r['m_own'], 1):>7s}{r['s24']:5d}{r['s10']:5d}"
              f"{fm(r['real24']):>12s}{r['v3']:6.0f}{str(r['buyo'])[0]:>5s}{r['cheaper']:8d}{flag}")
    print(f"listed value {sum(s['remain'] * s['price'] for s in sells) / 1e6:,.0f}M")
    if args.assets and elsewhere:
        print("stock at other locations (cannot be listed at Jita 4-4 until moved):",
              {names_for([t]).get(t, t): v for t, v in list(elsewhere.items())[:15]})
    if not args.assets:
        print("(no --assets: unlisted hangar stock is NOT included in the held units — Workflow 4 must cover it)")
    return 0


def cmd_extend(args) -> int:
    orders, tx, killed, rows, hv_floor = context(args)
    buys, sells = orders["buys"], orders["sells"]
    stock, buy_rem = collections.Counter(), collections.Counter()
    for s in sells:
        stock[s["type_id"]] += s["remain"]
    for b in buys:
        buy_rem[b["type_id"]] += b["remain"]
    ignore = portfolio.parse_id_list(args.ignore)
    types = sorted((set(stock) | set(buy_rem)) - killed - ignore)
    names = names_for(types)
    mine = {b["order_id"] for b in buys}
    data = market.fetch_many(types)
    last = tx[0]["dt"] if tx else market.now_utc()
    print(f"transactions feed ends {last:%m-%d %H:%M}Z")
    print(f"{'item':36s}{'buyRem':>7s}{'stock':>6s}{'sld72h':>7s}{'bght72':>7s}{'cover d':>8s}{'nm@ask':>7s}{'sup':>6s}{'S2Bvol':>7s}{'S2Btrd':>7s}{'7dBuy':>7s}{'7dSell':>7s}{'fresh':>7s}")
    res = []
    for t in types:
        v = market.analyse(t, *data[t], mine)
        if "err" in v:
            continue
        s72 = sum(x["quantity"] for x in tx if x["typeId"] == t and not x["isBuy"] and (last - x["dt"]).total_seconds() <= 72 * 3600)
        b72 = sum(x["quantity"] for x in tx if x["typeId"] == t and x["isBuy"] and (last - x["dt"]).total_seconds() <= 72 * 3600)
        cover = (stock[t] + buy_rem[t]) / max(s72 / 3, 0.01)
        res.append((cover, t, v, s72, b72))
    f = lambda x, fmt="{:.0f}": "-" if x is None else fmt.format(x)
    for cover, t, v, s72, b72 in sorted(res, key=lambda r: r[0]):
        a = rows.get(t, {})
        print(f"{(names.get(t) or str(t))[:36]:36s}{buy_rem[t]:7d}{stock[t]:6d}{s72:7d}{b72:7d}{cover:8.1f}{v['nm_ask']:7.1f}{v['nm_sup']:6.1f}"
              f"{f(a.get('s2b_vol')):>7s}{f(a.get('s2b_trd')):>7s}{f(a.get('d7buy'), '{:.1f}'):>7s}{f(a.get('d7sell'), '{:.1f}'):>7s}"
              f"{v['fresh_fills']:>4d}/{v['near']:<2d}")
    print("\nAn Increase also needs the runway check (open units against the recent sales pace) and a live margin above the floor.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Live-margin portfolio tables (Workflows 2-3) and extension candidates")
    ap.add_argument("command", choices=["buys", "sells", "extend"])
    ap.add_argument("--orders", required=True)
    ap.add_argument("--tx", nargs="*", default=[], help="one or more get_wallet_transactions result files")
    ap.add_argument("--assets")
    ap.add_argument("--a4e-dir")
    ap.add_argument("--killed", default="")
    ap.add_argument("--ignore", default="", help="type ids to leave out of `extend` (production stock, hold containers)")
    ap.add_argument("--hv-floor", type=float, default=7.5)
    ap.add_argument("--no-hv", action="store_true")
    args = ap.parse_args(argv)
    return {"buys": cmd_buys, "sells": cmd_sells, "extend": cmd_extend}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
