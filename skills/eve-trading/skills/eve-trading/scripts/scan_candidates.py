#!/usr/bin/env python3
"""
scan_candidates.py — Workflow 1 candidate scan with the fill-evidence gates.

    python scripts/a4e.py fetch a4e/                  # raw A4E pages (saved tiers + high-velocity pull)
    python scripts/scan_candidates.py --a4e-dir a4e/ --orders orders.json \\
        [--safe] [--killed 18869,19111] [--exclude-prefix Corpum,"Dark Blood"] [--extra-held 14174,37849] \\
        [--hv-floor 7.5 | --no-hv] [--ledger ~/.eve-sde/ledger.db --character-id N] [--json scan.json]

TWO MODES (the run prints which one it used; say so in the report)
  default (relaxed)  Added 2026-11-10 at the user's direction. With idle cash a bid that never fills costs
                     the broker fee (0.5% at placement, about 0.5% per reprice) and nothing else, so the
                     checks that only ask "will it fill?" stop being gates for T2 and T3 rows. The
                     checks that ask "will the price hold after it fills?" stay, and one is added: the
                     margin at the price the item actually traded at. See the changes below.
  --safe             The original gate set, unchanged: every fill check is a hard gate in every tier,
                     a swept bid always rejects, sizing is capped at one day of Sold2Buy in units of 5,
                     and there is no traded-price test.

What the relaxed mode changes (everything not listed here is the same in both modes)
  S2B minimum and "no fresh fills" for T2/T3 rows: hard gates -> soft flags ("slow fills S2B ...").
                     T1 and T4+ rows keep both as hard gates.
  thin / unit size   rows priced at or above the T3 floor (T3, T4+) are sized in pairs, not fives.
  size cap           T2/T3 rows are capped at two days of Sold2Buy volume (safe mode: one day).
  swept bid          rejects only when the ask is also weakening (A4E 7dSell < -5%, or unknown);
                     otherwise a soft flag and the row is sized at half.
  traded-price test  NEW hard gate: the margin at the 5-day volume-weighted traded price must stay
                     within 1 point of the entry floor. It replaces the protection the fill gates gave
                     by accident: items whose ask sits well above where they trade.
  profit and rank    use the lower of the ask and the traded price (`profit_at_ask` keeps the old figure).

Run `sync_wallet_ledger` first: the repeat-open check reads the ledger's order history, which is
only as current as the last sync. The ledger and the character are found on their own (see below).

What it does: reads every A4E row, drops types already held or killed, keeps rows whose A4E
margin is within reach of the floor, then verifies each survivor live (public ESI book and
history — the two-call margin at the competitive bid) and applies the gates below. It prints
the rows that pass, ranked by M/1M/day, and the rejected rows with their reasons so the report
can carry an "excluded after checks" list. It places nothing. Run `depth.py` on the rows you
intend to recommend (the depth checklist in workflow-new-candidates.md is not automated here)
and hand the chosen unit counts to size_positions.py.

HARD gates (a row fails if any applies; "safe" marks what only applies in --safe mode)
  margin       live margin at the competitive bid, against the sell reference, is under the floor:
               tier entry floor (T1 10 / T2 11 / T3 13; T3 10 with >=50 trades/day and >=25 combined
               orders); with the high-velocity relaxation the floor drops to --hv-floor for rows that
               qualify (A4E >=100 trades/day, 3-day volume >=100, >=15 orders each side)
  traded price (default mode) margin at the 5-day volume-weighted traded price is under floor - 1
  fill (A4E)   Sold2Buy volume < 20 units/day or Sold2Buy trades < 15/day — sellers are not
               reaching buy orders at a useful rate (safe mode, and T1/T4+ rows in default mode)
  fill (book)  no young (<24h) partly-filled bid near the top of the live book (same scope)
  swept bid    A4E 7dBuy < -5%: the best bid is far below its own 7-day average, so the top bids were
               just swept and the margin on screen is temporary (the real bid returns). Default mode:
               only when the ask is also weakening (7dSell < -5% or unknown)
  falling ask  A4E 7dSell < -12%: the ask is dropping
  spike        A4E 7dSell > +25% (the ask is far above its 7-day level) — an unproven price level
               that can revert. A jump in the average price over the last day or two is NOT a gate
               any more (user's call, 2026-11-09): it is a soft flag, and the repeat-open check
               below is what catches positions that never fill.
  thin         one increment already exceeds the top of the sizing band of daily trades (the
               increment is 5 units; 2 for rows at or above the T3 floor in default mode)
  stale        the top asks are older than 14 days (abandoned listings)
  repeat open  2+ earlier buy orders for the type cancelled at under half filled — the position
               was opened repeatedly without filling. On by default: the ledger is
               ~/.eve-sde/ledger.db and the character is the one that owns the --orders buys; the
               run says plainly when the check is off and why
SOFT flags (shown on the row, judgement left to the caller)
  cushion under 2 points over the floor; thin top of the ask (<=2 units then a >=2% gap);
  ask 20-25% over its 7-day level; bids rising >15% over their 7-day level; 8-day average price
  range over 25%; the average price jumped 8%+ in the last one or two days; one earlier buy
  cancelled under half filled; the row only clears through the high-velocity relaxation.
  Default mode adds: "slow fills S2B ..." and "no fresh fills in top bids" (T2/T3, were gates),
  "bid swept ... half size", and "traded-price margin" when it sits within the 1-point slack.

Units are the middle of the sizing band of A4E trades/day in multiples of the unit increment,
capped at the Sold2Buy volume per day (an order larger than one day of sellers sits for days; two
days for T2/T3 in default mode). A row that clears with a swept bid is sized at half.

The repeat-open check is what limits the fee loss on bids that never fill: two earlier opens
that were cancelled under half filled end the item, so the loss per item stays near two placement
fees. Reprice a slow bid sparingly — each reprice costs about another 0.5% of its value.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sqlite3
import sys

import a4e
import market
import portfolio
import size_positions

ENTRY_FLOOR = {"T1": 10.0, "T2": 11.0, "T3": 13.0}   # margin-verification.md, "Margin thresholds"
T3_CARVE_OUT = 10.0
MIN_S2B_VOL, MIN_S2B_TRD = 20, 15
SWEPT_BID_PCT, FALLING_ASK_PCT = -5.0, -12.0
SPIKE_ASK_PCT, STEP_FLAG_PCT = 25.0, 8.0
REPEAT_OPEN_CANCELS = 2
LEDGER_DEFAULT = "~/.eve-sde/ledger.db"
STALE_DAYS = 14
HV_MIN_TRADES, HV_MIN_VOL, HV_MIN_ORDERS = 100, 100, 15

# Default ("relaxed") mode, added 2026-11-10 at the user's direction; --safe turns all of it off.
# Why: with idle cash a bid that never fills costs only its broker fee, and in the closed Perimeter
# buys since 2026-10-10 (a small sample chosen under the gates) the Sold2Buy gate did not separate good
# fillers from bad ones (reference/workflow-new-candidates.md, "Modes"). Change these here and in that
# document together.
RELAXED_FILL_TIERS = ("T2", "T3")    # tiers where the will-it-fill checks are soft flags, not gates
EXPENSIVE_TIERS = ("T3", "T4+")      # unit price at or above the T3 floor
EXPENSIVE_UNIT_INCREMENT = 2         # these rows are sized in pairs; a five-unit T3 slot is 100-250M
RELAXED_S2B_DAYS = 2                 # size cap for relaxed rows, in days of A4E Sold2Buy volume (safe: 1)
SWEPT_ASK_WEAK_PCT = -5.0            # a swept bid is only a gate while the ask is also weakening
SWEPT_SIZE_FACTOR = 0.5              # a row that clears with a swept bid is sized at half
REAL_PRICE_SLACK = 1.0               # margin at the 5-day traded price may sit this far under the floor


def entry_floor(tier: str, tr: float, orders: int, hv: bool, hv_floor):
    """(floor, relaxed) — the margin a new position must clear, and whether the HV relaxation set it."""
    floor = ENTRY_FLOOR.get(tier, ENTRY_FLOOR["T3"])
    if tier == "T3" and tr >= 50 and orders >= 25:
        floor = T3_CARVE_OUT
    if hv and hv_floor is not None and hv_floor < floor:
        return hv_floor, True
    return floor, False


def is_high_velocity(tr: float, vol3: float, nb: int, ns: int) -> bool:
    return tr >= HV_MIN_TRADES and vol3 >= HV_MIN_VOL and nb >= HV_MIN_ORDERS and ns >= HV_MIN_ORDERS


def evaluate(a: dict, v: dict, params: dict, hv_floor, cancels: int = 0, safe: bool = False) -> dict:
    """Apply the gates to one A4E row `a` and its live analysis `v` (market.analyse). Pure.

    `safe=True` is the original gate set; the default is the relaxed mode described in the module
    docstring. `v` may lack `nm_real` (older callers); the traded-price test is then skipped."""
    relaxed_mode = not safe
    inc0 = params["unit_increment"]
    lo, hi = params["sizing_band_pct_of_daily_trades"]
    tier = market.tier_of(v["bid"], params["tiers_isk_per_unit"])
    relax_fill = relaxed_mode and tier in RELAXED_FILL_TIERS
    inc = EXPENSIVE_UNIT_INCREMENT if (relaxed_mode and tier in EXPENSIVE_TIERS) else inc0
    tr = a["tr"] or 0
    hv = is_high_velocity(tr, v["vol3"], v["nb"], v["ns"])
    floor, hv_relaxed = entry_floor(tier, tr, v["nb"] + v["ns"], hv, hv_floor)
    hard, soft = [], []

    if v["nm_sup"] < floor:
        hard.append(f"margin {v['nm_sup']:.1f}<{floor:g}")
    elif v["nm_sup"] - floor < 2.0:
        soft.append(f"cushion {v['nm_sup'] - floor:.1f}")
    if hv_relaxed:
        soft.append("HV floor")
    nm_real = v.get("nm_real")
    if relaxed_mode and nm_real is not None:
        if nm_real < floor - REAL_PRICE_SLACK:
            hard.append(f"margin at traded price {nm_real:.1f}<{floor - REAL_PRICE_SLACK:g}")
        elif nm_real < floor:
            soft.append(f"traded-price margin {nm_real:.1f}")
    s2b_vol, s2b_trd = a.get("s2b_vol") or 0, a.get("s2b_trd") or 0
    if s2b_vol < MIN_S2B_VOL or s2b_trd < MIN_S2B_TRD:
        (soft if relax_fill else hard).append(
            f"slow fills S2B {s2b_vol:.0f}u/{s2b_trd:.0f}t" if relax_fill else f"S2B {s2b_vol:.0f}u/{s2b_trd:.0f}t")
    if v["fresh_fills"] < 1:
        (soft if relax_fill else hard).append("no fresh fills in top bids")
    d7b, d7s = a.get("d7buy"), a.get("d7sell")
    swept_half = False
    if d7b is not None and d7b < SWEPT_BID_PCT:
        if relaxed_mode and d7s is not None and d7s >= SWEPT_ASK_WEAK_PCT:
            soft.append(f"bid swept (7dBuy {d7b:.0f}%), ask steady: low bid, half size")
            swept_half = True
        else:
            hard.append(f"bid swept (7dBuy {d7b:.0f}%)")
    if d7s is not None and d7s < FALLING_ASK_PCT:
        hard.append(f"ask falling (7dSell {d7s:.0f}%)")
    if d7s is not None and d7s > SPIKE_ASK_PCT:
        hard.append(f"ask spike (7dSell +{d7s:.0f}%)")
    if tr and inc / tr * 100 > hi:
        hard.append("thin")
    if v["stale_days"] > STALE_DAYS:
        hard.append(f"stale asks {v['stale_days']:.0f}d")
    if cancels >= REPEAT_OPEN_CANCELS:
        hard.append(f"opened {cancels}x without filling (cancelled under half filled)")
    elif cancels == 1:
        soft.append("1 earlier buy cancelled under half filled")

    if v["top_units"] <= 2 and v["gap"] and v["gap"] >= 2:
        soft.append(f"thin top {v['top_units']}u/{v['gap']:.0f}%")
    if d7s is not None and 20 < d7s <= SPIKE_ASK_PCT:
        soft.append(f"ask +{d7s:.0f}% vs 7d")
    if d7b is not None and d7b > 15:
        soft.append(f"bids +{d7b:.0f}% vs 7d")
    if v["range8"] > 25:
        soft.append(f"8d range {v['range8']:.0f}%")
    if v["step2"] >= STEP_FLAG_PCT:
        soft.append(f"price stepped +{v['step2']:.0f}% in 2d")

    mid = (lo + hi) / 2 / 100
    base = max(inc, round(mid * tr / inc) * inc)
    cap = int(s2b_vol * (RELAXED_S2B_DAYS if relax_fill else 1) // inc * inc)
    units = max(inc, min(base, cap)) if cap else inc
    if cap and cap < base:
        soft.append(f"S2B-capped {cap}")
    if swept_half:
        units = max(inc, int(round(units * SWEPT_SIZE_FACTOR / inc)) * inc)
    # Profit and the M/1M/day rank use the ask in safe mode. In the default mode they use the lower of the
    # ask and the 5-day traded price, so a spiky ask cannot put a row first or inflate its profit.
    sell = min(v["ask"], v["vwap5"]) if (relaxed_mode and v.get("vwap5")) else v["ask"]
    ppu = sell * (1 - market.SELL_FEE - market.SALES_TAX) - v["bid"] * (1 + market.BUY_FEE)
    ppu_ask = v["ask"] * (1 - market.SELL_FEE - market.SALES_TAX) - v["bid"] * (1 + market.BUY_FEE)
    return dict(
        tier=tier, hv=hv, floor=floor, hard=hard, soft=soft, units=units, ppu=ppu,
        cost=units * v["bid"], profit=ppu * units, profit_at_ask=ppu_ask * units, yield_m=ppu / v["bid"] * tr,
        mode="safe" if safe else "relaxed",
    )


def cancel_count(con, character_id: int, type_id: int) -> int:
    """Earlier buy orders for the type that were cancelled with under half of the volume filled."""
    rows = con.execute(
        "select volume_total, volume_remain from orders where character_id=? and type_id=? "
        "and is_buy_order=1 and state='cancelled'", (character_id, type_id)).fetchall()
    return sum(1 for total, remain in rows if (total - (total if remain is None else remain)) < 0.5 * total)


def infer_character(con, order_ids) -> "int | None":
    """The character that owns the given order ids, found in the ledger (the most common owner)."""
    ids = list(order_ids)
    if not ids:
        return None
    rows = con.execute(
        f"select character_id, count(*) from orders where order_id in ({','.join('?' * len(ids))}) "
        "group by character_id order by 2 desc", ids).fetchall()
    return rows[0][0] if rows else None


def open_repeat_check(ledger, character_id, buy_order_ids):
    """(connection or None, character id or None, status line) for the repeat-open check.

    The check used to run only when --ledger and --character-id were both passed, and skipped
    silently otherwise, so scans ran without it. It now defaults to the standard ledger and finds
    the character from the open buys; if it cannot run, the status line says why."""
    path = os.path.expanduser(ledger or LEDGER_DEFAULT)
    if not os.path.exists(path):
        return None, None, f"repeat-open check OFF: no ledger at {path} (run sync_wallet_ledger, or pass --ledger)"
    try:
        con = sqlite3.connect(path)
        char = character_id or infer_character(con, buy_order_ids)
    except sqlite3.Error as exc:
        return None, None, f"repeat-open check OFF: ledger unreadable ({exc})"
    if not char:
        return None, None, ("repeat-open check OFF: could not tell which character owns the orders "
                            "(pass --orders with the open buys, or --character-id)")
    n = con.execute(
        "select count(*) from (select type_id from orders where character_id=? and is_buy_order=1 "
        "and state='cancelled' and (volume_total - coalesce(volume_remain, volume_total)) * 2 < volume_total "
        "group by type_id having count(*) >= ?)", (char, REPEAT_OPEN_CANCELS)).fetchone()[0]
    return con, char, (f"repeat-open check ON: character {char}, {n} types opened {REPEAT_OPEN_CANCELS}+ times "
                       f"without filling (ledger order history as of its last sync)")


def mode_line(safe: bool) -> str:
    """First-lines status for the run, like the repeat-open line: the report must say which mode ran."""
    if safe:
        return "mode: SAFE (original gates: every fill check is a hard gate, swept bids always reject, one-day size cap, no traded-price test)"
    return (f"mode: DEFAULT/relaxed (T2/T3: S2B and fresh-fill checks are soft flags, size cap {RELAXED_S2B_DAYS} days of S2B; "
            f"swept bid rejects only with a weakening ask, else half size; rows >= T3 floor sized in pairs; "
            f"traded-price margin test on; --safe restores the original gates)")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Workflow 1 candidate scan (default: relaxed fill gates; --safe: the original gates)")
    ap.add_argument("--safe", action="store_true",
                    help="use the original gate set (hard fill checks in every tier, swept bids always reject, "
                         "one-day size cap, no traded-price test)")
    ap.add_argument("--a4e-dir", required=True, help="folder written by `a4e.py fetch`")
    ap.add_argument("--orders", help="get_character_orders result (held types are skipped)")
    ap.add_argument("--killed", default="", help="comma-separated type ids the user killed — never re-added")
    ap.add_argument("--exclude-prefix", default="", help="comma-separated name prefixes (a killed item's family)")
    ap.add_argument("--extra-held", default="", help="type ids held outside the order book (hold containers, hangar stock)")
    ap.add_argument("--hv-floor", type=float, default=7.5, help="relaxed entry floor for high-velocity rows (user-directed)")
    ap.add_argument("--no-hv", action="store_true", help="disable the high-velocity relaxation")
    ap.add_argument("--prefilter", type=float, default=6.0, help="A4E margin below which a row is not even checked live")
    ap.add_argument("--ledger", help=f"ledger.db for the repeat-open check (default {LEDGER_DEFAULT})")
    ap.add_argument("--character-id", type=int, help="default: the owner of the --orders buys, found in the ledger")
    ap.add_argument("--db", help="SDE path (default ~/.eve-sde/eve.db)")
    ap.add_argument("--show-rejected", type=int, default=25)
    ap.add_argument("--json", help="write every checked row here")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    params = size_positions.load_params()
    hv_floor = None if args.no_hv else args.hv_floor
    rows = a4e.load_dir(args.a4e_dir, a4e.sde_resolver(args.db))
    held, mine = set(), set()
    if args.orders:
        o = portfolio.load_orders(args.orders)
        held = {x["type_id"] for x in o["buys"] + o["sells"]}
        mine = {x["order_id"] for x in o["buys"]}
    held |= portfolio.parse_id_list(args.extra_held)
    killed = portfolio.parse_id_list(args.killed)
    prefixes = tuple(p.strip() for p in args.exclude_prefix.split(",") if p.strip())

    skipped_family = []
    ids = []
    for t, r in rows.items():
        if t in held or t in killed:
            continue
        if prefixes and r["name"].startswith(prefixes):
            skipped_family.append(r["name"])
            continue
        if market.nm(r["buy"], r["sell"]) >= args.prefilter:
            ids.append(t)
    print(f"A4E rows {len(rows)} | held/killed skipped {sum(1 for t in rows if t in held or t in killed)} | "
          f"family-excluded {len(skipped_family)} | checking live {len(ids)} | HV floor "
          f"{'off' if hv_floor is None else f'{hv_floor:g}% (user-directed relaxation)'}")

    print(mode_line(args.safe))
    con, char, status = open_repeat_check(args.ledger, args.character_id, mine)
    print(status)

    data = market.fetch_many(ids)
    out = []
    for t in ids:
        b, h = data[t]
        v = market.analyse(t, b, h, mine)
        if "err" in v:
            out.append(dict(t=t, name=rows[t]["name"], error=v["err"]))
            continue
        e = evaluate(rows[t], v, params, hv_floor, cancel_count(con, char, t) if con else 0, safe=args.safe)
        out.append(dict(t=t, name=rows[t]["name"], a4e=rows[t], live=v, **e))

    ok = sorted((r for r in out if "error" not in r and not r["hard"]), key=lambda r: -r["yield_m"])
    bad = sorted((r for r in out if "error" not in r and r["hard"]), key=lambda r: -r["yield_m"])
    err = [r for r in out if "error" in r]
    print(f"\n{len(ok)} pass, {len(bad)} rejected, {len(err)} not checkable\n")
    head = (f"{'item':40s}{'t':>3s}{'bid':>12s}{'ask':>12s}{'nm@ask':>7s}{'sup':>6s}{'real':>6s}{'S2Bu':>6s}{'S2Bt':>5s}"
            f"{'7dBuy':>6s}{'7dSell':>7s}{'tr/d':>5s}{'vol3':>6s}{'nb/ns':>7s}{'fresh':>6s}{'units':>6s}{'cost M':>7s}{'prof M':>7s}{'M/1M/d':>7s}")
    print(head)
    f1 = lambda x: "-" if x is None else f"{x:.0f}"
    for r in ok:
        a, v = r["a4e"], r["live"]
        print(f"{r['name'][:40]:40s}{r['tier']:>3s}{v['bid']:12,.0f}{v['ask']:12,.0f}{v['nm_ask']:7.1f}{v['nm_sup']:6.1f}{v['nm_real']:6.1f}"
              f"{a['s2b_vol']:6.0f}{a['s2b_trd']:5.0f}{f1(a['d7buy']):>6s}{f1(a['d7sell']):>7s}{a['tr']:5.0f}{v['vol3']:6.0f}"
              f"{str(v['nb']) + '/' + str(v['ns']):>7s}{v['fresh_fills']:>3d}/{v['near']:<2d}{r['units']:6d}"
              f"{r['cost'] / 1e6:7.0f}{r['profit'] / 1e6:7.1f}{r['yield_m']:7.1f} {'HV ' if r['hv'] else ''}{'; '.join(r['soft'])}")
    if bad:
        print(f"\nRejected after live checks (top {min(len(bad), args.show_rejected)} by yield):")
        for r in bad[: args.show_rejected]:
            v = r["live"]
            print(f"  {r['name'][:40]:40s} nm@ask {v['nm_ask']:5.1f} sup {v['nm_sup']:5.1f} real {v['nm_real']:5.1f} | {'; '.join(r['hard'])}")
    if skipped_family:
        print(f"\nExcluded as the killed items' family ({len(skipped_family)}): {', '.join(sorted(skipped_family)[:12])}"
              f"{' …' if len(skipped_family) > 12 else ''}")
    if err:
        print(f"\nNot checkable (one-sided book, short history or fetch failure): {', '.join(r['name'] for r in err)}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
