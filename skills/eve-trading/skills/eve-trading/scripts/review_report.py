#!/usr/bin/env python3
"""
review_report.py — build the portfolio review (Workflows 2-5) as one markdown draft.

Run it through review_portfolio.py:

    python scripts/review_portfolio.py report --orders orders.json --wallet ISK --assets assets.json \\
        [--a4e-dir a4e/] [--tx tx.json] [--ledger ~/.eve-sde/ledger.db] [--ignore IDS] \\
        [--save snapshot.json] [--since previous_snapshot.json]

It does the mechanical part of the report skeleton in workflow-portfolio-review.md: live margins
at the competitive bid, true order ages, fills, section placement and sorting, Kill totals and the
book after them, bounded cost on stock held, unlisted stock, pipeline inputs and the changes since
the last snapshot. Verdicts and notes stay with the caller: the Kill table holds the orders that meet
the floor or zero-fill criterion, to confirm; the caller adds judgement Kills (volume dried up, an
adverse move), picks Increases and pipeline outliers, and writes the notes.

Inputs. `--orders` is the saved get_character_orders result (live prices: the ledger keeps the
first-seen price). Transactions come from --tx, or from the ledger when --tx is absent. True order
age is the ledger's first-seen `issued` for the order id, so run sync_wallet_ledger first.
Nothing is placed or cancelled.
"""

from __future__ import annotations

import datetime
import json
import os
import sqlite3
import statistics
import sys

import a4e
import market
import portfolio
import scan_candidates
import size_positions

HOLD_FLOOR = 10.0            # margin-verification.md, "Margin thresholds"
FILL_WINDOW_DAYS = 14        # workflow-portfolio-review.md, Workflow 5 lookback
PACE_DAYS = (3, 7)           # runway uses the last 3-7 days of fills (Workflow 2, runway check)
SLOW_RUNWAY_DAYS = 7         # "more than about a week at the observed fill pace" (table 4)
EARLY_DAYS = 1.0             # "placed in roughly the last 24h" (table 5)
MARGINAL_PCT, THIN_PCT = 15.0, 20.0   # Workflow 3: marginal is "under ~15-20%"
INCREASE_ROWS = 5


def order_fee(location) -> float:
    """A buy order's broker fee: Perimeter HQ's rate there, Jita 4-4's at any other station."""
    return market.BUY_FEE if location == market.PERIMETER else market.SELL_FEE


def margin(bid: float, ask: float, buy_fee: float = market.BUY_FEE) -> float:
    """Net margin %: the two-call formula with the buy fee of the order's own location."""
    cost = bid * (1 + buy_fee)
    return (ask * (1 - market.SELL_FEE - market.SALES_TAX) - cost) / cost * 100


def isk(x: float) -> str:
    return scan_candidates._isk(x)


def code(name: str) -> str:
    return f"`{name}`"


def days_since(now, when) -> float:
    return (now - when).total_seconds() / 86400


def units(tx, type_id, is_buy, now=None, days=None) -> int:
    return sum(t["quantity"] for t in tx
               if t["typeId"] == type_id and t["isBuy"] == is_buy and (days is None or days_since(now, t["dt"]) <= days))


def average_price(tx, type_id, is_buy, now, days):
    rows = [t for t in tx if t["typeId"] == type_id and t["isBuy"] == is_buy and days_since(now, t["dt"]) <= days]
    total = sum(t["quantity"] for t in rows)
    return (sum(t["quantity"] * t["unitPrice"] for t in rows) / total) if total else None


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

def buy_rows(buys, data, tx, first_seen, names, a4e_rows, hv_floor, now, mine):
    """One dict per open buy order; rows without a usable book carry `error`."""
    open_units = {}
    for o in buys:
        open_units[o["type_id"]] = open_units.get(o["type_id"], 0) + o["remain"]
    out = []
    for o in buys:
        t, price = o["type_id"], o["price"]
        book, hist = data.get(t, (None, None))
        name = names.get(t) or o["name"]
        base = dict(order_id=o["order_id"], type_id=t, name=name, price=price, remain=o["remain"], total=o["total"],
                    escrow=price * o["remain"], location=o["location"])
        asks = market.asks_of(book or [])
        if not asks or not hist:
            out.append(dict(base, error="book or history unavailable"))
            continue
        bids = market.bids_of(book, mine)
        comp = bids[0]["price"] if bids else price
        live_bid = max(price, comp)
        ask, ask_d = asks[0]["price"], market.durable_ask(asks)
        fee = order_fee(o["location"])
        a = a4e_rows.get(t, {})
        vol3 = market.history_stats(hist, live_bid, ask)["vol3"]
        hv = bool(a) and scan_candidates.is_high_velocity(a.get("tr") or 0, vol3, len(bids), len(asks))
        floor = hv_floor if (hv and hv_floor is not None and hv_floor < HOLD_FLOOR) else HOLD_FLOOR
        started = [d for d in (first_seen.get(o["order_id"]), market.parse_iso(o["issued"]) if o["issued"] else None) if d]
        age = days_since(now, min(started)) if started else None
        window = min(max(age or PACE_DAYS[1], PACE_DAYS[0]), PACE_DAYS[1])
        pace = units(tx, t, True, now, window) / window
        out.append(dict(
            base, comp=comp, ask=ask, ask_d=ask_d, floor=floor, hv=hv,
            nm=margin(live_bid, ask, fee), nm_own=margin(price, ask, fee), nm_dur=margin(live_bid, ask_d, fee),
            profit_unit=ask * (1 - market.SELL_FEE - market.SALES_TAX) - live_bid * (1 + fee),
            filled=o["total"] - o["remain"], bought=units(tx, t, True, now, FILL_WINDOW_DAYS), pace=pace,
            runway=(open_units[t] / pace) if pace else None, age=age,     # all open units of the item
            sold72=units(tx, t, False, now, 3), sold72_price=average_price(tx, t, False, now, 3),
            trades=a.get("tr"), s2b=a.get("s2b_vol"), vol3=vol3,
        ))
    return out


def floor_breach(r) -> bool:
    """Under the floor at the competitive bid, at the order's own price and at the durable ask."""
    return max(r["nm"], r["nm_own"], r["nm_dur"]) < r["floor"]


def stalled(r) -> bool:
    """No fill on the order or the item for the whole lookback window, on an order at least that old."""
    return r["filled"] == 0 and not r["bought"] and r["age"] is not None and r["age"] >= FILL_WINDOW_DAYS


def classify(r) -> str:
    """kill / early / few / converting — the review's tables, in the order the tests apply.

    A floor breach that only one of the three figures shows stays a hold, with the difference noted.
    """
    if floor_breach(r) or stalled(r):
        return "kill"
    if r["filled"] == 0 and not r["bought"] and r["age"] is not None and r["age"] < EARLY_DAYS:
        return "early"
    if r["bought"] <= 1 or r["runway"] is None or r["runway"] > SLOW_RUNWAY_DAYS:
        return "few"
    return "converting"


def margin_cell(r) -> str:
    text = f"{r['nm']:.1f}%"
    if (r["nm"] < r["floor"]) != (r["nm_own"] < r["floor"]):
        text += f" (own {r['nm_own']:.1f}%)"
    if r["hv"] and r["floor"] < HOLD_FLOOR:
        text += " HV"
    if r["nm"] < r["floor"] <= r.get("nm_dur", r["nm"]):
        text += f"; top ask is under the floor, durable ask gives {r['nm_dur']:.1f}%: spot-check"
    return text


def _age(r) -> str:
    return "age unknown" if r["age"] is None else f"{r['age']:.1f}d old"


def _market_days(r):
    return (r["total"] / r["trades"]) if r.get("trades") else None


def hold_note(r) -> str:
    parts = [_age(r), f"{r['bought']} bought in {FILL_WINDOW_DAYS}d" if r["bought"] else "no fills in 14d"]
    if r["runway"] is not None:
        parts.append(f"runway {r['runway']:.0f}d")
    if _market_days(r) is not None:
        parts.append(f"{_market_days(r):.2f} days of market trades ({r['trades']:.0f}/day)")
    # the jump-range diagnosis: only for an order old enough that having no fills is a signal
    if not r["bought"] and (r["age"] or 0) >= SLOW_RUNWAY_DAYS and r["comp"] > r["price"]:
        parts.append(f"competing bid {isk(r['comp'])} is above the order")
    if r["nm"] < r["floor"] <= r["nm_own"]:
        parts.append("under the floor at the competitive bid only")
    elif r["nm_own"] < r["floor"] <= r["nm"]:
        parts.append("under the floor at the own price only")
    return "; ".join(parts)


def kill_why(r) -> str:
    parts = []
    if floor_breach(r):
        parts.append(f"under the {r['floor']:g}% floor at the competitive bid and own price")
        if r["floor"] - max(r["nm"], r["nm_own"]) < 1:
            parts.append("within a point of the floor")
        need = max(r["price"], r["comp"]) * (1 + order_fee(r["location"])) * (1 + r["floor"] / 100) / (
            1 - market.SELL_FEE - market.SALES_TAX)
        parts.append(f"floor needs a {isk(need)} ask, live {isk(r['ask'])}")
    if stalled(r):
        parts.append(f"zero fills in {r['age']:.1f}d")
        parts.append(f"outcompeted: a competing bid at {isk(r['comp'])} is above the order" if r["comp"] > r["price"]
                     else f"no competing bid above the order; bid {isk(r['price'])} against ask {isk(r['ask'])}")
    parts.append(f"own sells 72h: {r['sold72']} at {isk(r['sold72_price'])}" if r["sold72"] else "no own sells in 72h")
    if not stalled(r):
        parts.append(f"{r['filled']} filled, {_age(r)}")
    return "; ".join(parts)


def sell_rows(sells, unlisted, data, tx, names, now):
    """One dict per type held for sale: sell orders plus unlisted stock at Jita 4-4."""
    held = portfolio.held_stock(sells, unlisted)
    out = []
    for t, qty in held.items():
        if qty <= 0:
            continue
        book, _ = data.get(t, (None, None))
        asks = market.asks_of(book or [])
        mine = [s for s in sells if s["type_id"] == t]
        listed = sum(s["remain"] for s in mine)
        buy_txs = [x for x in tx if x["typeId"] == t and x["isBuy"]]
        cost, got, _ = portfolio.bounded_cost(buy_txs, qty)
        ask = asks[0]["price"] if asks else None
        durable = market.durable_ask(asks) if asks else None
        net = durable * (1 - market.SELL_FEE - market.SALES_TAX) if durable else None
        out.append(dict(
            type_id=t, name=names.get(t) or str(t), held=qty, listed=listed, unlisted=qty - listed, cost=cost, got=got,
            own=min((s["price"] for s in mine), default=None), ask=ask, durable=durable, net=net,
            margin=((net / cost - 1) * 100) if (net and cost) else None,
            value=qty * (ask or min((s["price"] for s in mine), default=0)),
            sold72=units(tx, t, False, now, 3),
            last_buy=max((x["dt"] for x in buy_txs), default=None),
            listed_since=min((market.parse_iso(s["issued"]) for s in mine if s["issued"]), default=None),
        ))
    return sorted(out, key=lambda r: -r["value"])


def sell_verdict(r) -> str:
    if r["margin"] is None:
        return "no cost basis" if r["cost"] is None else "no live ask"
    if r["margin"] < 0:
        word = "Underwater"
    elif r["margin"] < MARGINAL_PCT:
        word = "Marginal"
    elif r["margin"] < THIN_PCT:
        word = "Marginal?"
    else:
        word = "Profitable"
    if r["got"] < r["held"]:
        word += f" (cost covers {r['got']} of {r['held']})"
    return word


# ---------------------------------------------------------------------------
# Snapshot and "since last review"
# ---------------------------------------------------------------------------

def snapshot(orders, wallet, now) -> dict:
    rows = {str(o["order_id"]): dict(type_id=o["type_id"], remain=o["remain"], price=o["price"], buy=side == "buys")
            for side in ("buys", "sells") for o in orders[side]}
    return dict(time=now.strftime("%Y-%m-%dT%H:%M:%SZ"), wallet=wallet, orders=rows)


def since_line(previous, current, tx, names) -> str:
    if not previous:
        return "no earlier snapshot"
    then = market.parse_iso(previous["time"])
    before, after = previous["orders"], current["orders"]
    label = lambda o: code(names.get(o["type_id"]) or str(o["type_id"]))
    gone = sorted({label(before[k]) for k in before.keys() - after.keys()})
    new = sorted({label(after[k]) for k in after.keys() - before.keys()})
    repriced = sum(1 for k in before.keys() & after.keys() if before[k]["price"] != after[k]["price"])
    recent = [t for t in tx if t["dt"] > then]
    bought = sum(t["quantity"] * t["unitPrice"] for t in recent if t["isBuy"])
    sold = sum(t["quantity"] * t["unitPrice"] for t in recent if not t["isBuy"])
    delta = current["wallet"] - previous["wallet"]
    wallet = "unchanged" if not delta else ("+" if delta > 0 else "") + isk(delta)
    parts = [f"since {previous['time']}: wallet {wallet}",
             f"bought {isk(bought)}" if bought else "no buy fills",
             f"sold {isk(sold)}" if sold else "no sales",
             f"{repriced} repriced"]
    if gone:
        parts.append("orders gone: " + ", ".join(gone))
    if new:
        parts.append("new orders: " + ", ".join(new))
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def table(headers, rows) -> list:
    if not rows:
        return ["None."]
    return ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)] + ["| " + " | ".join(map(str, r)) + " |" for r in rows]


def tier_mix(rows) -> str:
    escrow = {}
    for r in rows:
        tier = size_positions.tier_of(r["price"])
        escrow[tier] = escrow.get(tier, 0) + r["escrow"]
    return size_positions._fmt_mix(escrow)


def render(buys, sells, wallet, now, since, params, listed_value, elsewhere, fresh, names) -> str:
    good = [r for r in buys if "error" not in r]
    groups = {k: [] for k in ("kill", "early", "few", "converting")}
    for r in good:
        groups[classify(r)].append(r)
    escrow = sum(r["escrow"] for r in buys)
    idle = sum(r["escrow"] for r in good if r["filled"] == 0 and not r["bought"])
    floor_slot = params["min_profit_per_slot_isk"]
    out = [f"**Portfolio review — {now:%Y-%m-%d %H:%M}Z**", "",
           f"**Snapshot:** wallet {isk(wallet)} | buys {len(buys)} / sells {sells['orders']} | buy escrow {isk(escrow)} "
           f"(avg {isk(escrow / len(buys)) if buys else '0'} per order) | tier mix {tier_mix(buys)} | escrow in orders with "
           f"no fills {isk(idle)} ({idle / escrow * 100 if escrow else 0:.0f}%) | listed sells {isk(listed_value)} at own prices"
           f" | {since}"]
    legacy = [r for r in buys if r["location"] != market.PERIMETER]
    out += ["", "## Workflow 2 — Buy portfolio",
            "All buys sit at Perimeter HQ." if not legacy else
            "Buys outside Perimeter HQ (margins use Jita 4-4's broker fee): " + ", ".join(code(r["name"]) for r in legacy),
            "Live margin is at the competitive bid; the own-price figure appears when the two straddle the floor."]
    for r in buys:
        if "error" in r:
            out.append(f"Not checkable: {code(r['name'])} ({r['error']}).")

    kills = sorted(groups["kill"], key=lambda r: -r["escrow"])
    out += ["", "### Kill (floor breach or zero fills, to confirm)"] + table(
        ["Item", "Order price", "Left/total", "Live margin", "Why", "ISK freed"],
        [[code(r["name"]), isk(r["price"]), f"{r['remain']}/{r['total']}", f"{r['nm']:.1f}% (own {r['nm_own']:.1f}%)",
          kill_why(r), isk(r["escrow"])] for r in kills])
    if kills:
        freed = sum(r["escrow"] for r in kills)
        kept = [r for r in buys if r not in kills]
        out.append(f"\n{len(kills)} orders, {sum(r['remain'] for r in kills)} units, {isk(freed)} freed. After them: "
                   f"{len(kept)} buys, {isk(escrow - freed)} escrow, tier mix {tier_mix(kept)}, cash {isk(wallet + freed)}.")

    runway = sorted((r for r in groups["converting"] if r["nm"] >= r["floor"]), key=lambda r: r["runway"])[:INCREASE_ROWS]
    out += ["", "### Increase (runway check: shortest runway first, you choose or write none)"] + table(
        ["Item", "Left/total", "Live margin", "Suggested add (units × price)", "Velocity basis"],
        [[code(r["name"]), f"{r['remain']}/{r['total']}", margin_cell(r), "",
          f"{r['pace']:.1f}/day, runway {r['runway']:.1f}d" + (f", {r['s2b']:.0f}/day sold into bids" if r["s2b"] is not None else "")]
         for r in runway])

    out += ["", "### Hold, converting"] + table(
        ["Item", "Price", "Left/total", "Live margin", f"Fills in window ({FILL_WINDOW_DAYS}d)"],
        [[code(r["name"]), isk(r["price"]), f"{r['remain']}/{r['total']}", margin_cell(r),
          f"{r['bought']} units, runway {r['runway']:.1f}d"]
         for r in sorted(groups["converting"], key=lambda r: -r["bought"])])

    few = sorted(groups["few"], key=lambda r: -r["escrow"])
    out += ["", "### Hold, no or few fills"] + table(
        ["Item", "Price", "Left/total", "Live margin", "Escrow", "Note"],
        [[code(r["name"]), isk(r["price"]), f"{r['remain']}/{r['total']}", margin_cell(r), isk(r["escrow"]), hold_note(r)] for r in few])

    out += ["", "### Hold, too early"] + table(
        ["Item", "Price", "Units", "Margin", "Escrow"],
        [[code(r["name"]), isk(r["price"]), r["remain"], margin_cell(r), isk(r["escrow"])]
         for r in sorted(groups["early"], key=lambda r: -r["escrow"])])

    cycle = lambda r: r["profit_unit"] * r["total"]
    weak = sorted((r for r in few if r["nm"] >= r["floor"]), key=cycle)[:3]
    out.append("")
    out.append("**Consolidation candidates** (user-directed, above the floor, not a breach): " + (
        ", ".join(f"{code(r['name'])} ({isk(cycle(r))} a cycle, {isk(r['escrow'])} escrow)" for r in weak) if weak else "none."))
    small = sorted((r for r in good if r not in kills and cycle(r) < floor_slot), key=cycle)
    out.append(f"**Under the {isk(floor_slot)} profit-per-slot floor:** "
               + (", ".join(f"{code(r['name'])} ({isk(cycle(r))})" for r in small) if small else "none."))

    rows = sells["rows"]
    out += ["", "## Workflow 3 — Sell portfolio"] + table(
        ["Item", "Held units", "Bounded avg cost", "Achievable net sell", "Real margin", "Verdict"],
        [[code(r["name"]), f"{r['held']} ({r['listed']} listed / {r['unlisted']} unlisted)",
          "—" if r["cost"] is None else isk(r["cost"]), "—" if r["net"] is None else isk(r["net"]),
          "—" if r["margin"] is None else f"{r['margin']:.1f}%", sell_verdict(r)] for r in rows])

    uncovered = [r for r in rows if r["unlisted"] > 0]
    out += ["", "## Workflow 4 — Inventory risk"] + table(
        ["Item", "Uncovered units", "Rough ISK value", "Recommendation"],
        [[code(r["name"]), r["unlisted"], "—" if r["ask"] is None else isk(r["unlisted"] * r["ask"]),
          "list it" + (" (listed or repriced in the last hour, count may be high)" if r["type_id"] in fresh else "")]
         for r in sorted(uncovered, key=lambda r: -(r["unlisted"] * (r["ask"] or 0)))])
    if uncovered:
        out.append(f"\nUncovered: {isk(sum(r['unlisted'] * r['cost'] for r in uncovered if r['cost']))} at cost, "
                   f"{isk(sum(r['unlisted'] * r['ask'] for r in uncovered if r['ask']))} at the live asks.")
    if elsewhere:
        out.append(f"Stock outside Jita 4-4 (cannot be listed until moved): {len(elsewhere)} types, including " + ", ".join(
            f"{sum(v.values())} {code(names.get(t) or str(t))}" for t, v in list(elsewhere.items())[:8]) + ".")

    out += ["", "## Workflow 5 — Pipeline (inputs: pick the 2-3 clearest outliers, or say none stand out)"]
    if escrow:
        share = lambda k: sum(r["escrow"] for r in groups[k]) / escrow * 100
        out.append(f"- Buy escrow: {share('converting'):.0f}% converting, {share('few'):.0f}% no or few fills, "
                   f"{share('early'):.0f}% too early, {share('kill'):.0f}% Kill.")
    stalled = sorted((r for r in groups["few"] if not r["bought"] and r["age"] is not None), key=lambda r: -r["escrow"])[:5]
    if stalled:
        out.append("- Unfilled buys: " + "; ".join(
            f"{code(r['name'])} {isk(r['escrow'])} unfilled after {r['age']:.1f}d" for r in stalled) + ".")
    waiting = [r for r in uncovered if r["last_buy"]][:5]
    if waiting:
        out.append("- Unlisted stock: " + "; ".join(
            f"{code(r['name'])} {isk(r['unlisted'] * (r['ask'] or 0))}, last bought {days_since(now, r['last_buy']) * 24:.0f}h ago"
            for r in waiting) + ".")
    unsold = [r for r in rows if r["listed"] and not r["sold72"]][:5]
    if unsold:
        out.append("- Listed with no sales in 72h: " + "; ".join(
            f"{code(r['name'])} {isk(r['value'])}" for r in unsold) + ".")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Command
# ---------------------------------------------------------------------------

def read_ledger(path, order_ids):
    """(first-seen datetime by order id, the character's transactions) from the ledger; ({}, []) without one."""
    file = os.path.expanduser(path or str(portfolio.default_ledger()))
    if not os.path.exists(file):
        return {}, []
    con = sqlite3.connect(file)
    try:
        character = scan_candidates.infer_character(con, order_ids)
        if not character:
            return {}, []
        ids = list(order_ids)
        marks = ",".join("?" * len(ids))
        seen = {i: market.parse_iso(issued) for i, issued in
                con.execute(f"select order_id, issued from orders where order_id in ({marks})", ids)}
        tx = [dict(transactionId=i, date=d, typeId=t, quantity=q, unitPrice=p, isBuy=bool(b), dt=market.parse_iso(d))
              for i, d, t, q, p, b in con.execute(
                  "select transaction_id, date, type_id, quantity, unit_price, is_buy from wallet_transactions "
                  "where character_id=? order by date desc", (character,))]
        return seen, tx
    finally:
        con.close()


def build(orders, data, tx, first_seen, assets, a4e_rows, names, wallet, now, previous=None, hv_floor=7.5, ignore=frozenset()):
    """(markdown report, snapshot) from already loaded inputs. Pure: no files, no network."""
    unlisted, elsewhere = portfolio.unlisted_stock(assets) if assets is not None else ({}, {})
    unlisted = {t: q for t, q in unlisted.items() if t not in ignore}
    elsewhere = {t: v for t, v in elsewhere.items() if t not in ignore}
    mine = {o["order_id"] for o in orders["buys"]}
    buys = buy_rows(orders["buys"], data, tx, first_seen, names, a4e_rows, hv_floor, now, mine)
    sells = dict(orders=len(orders["sells"]), rows=sell_rows(orders["sells"], unlisted, data, tx, names, now))
    current = snapshot(orders, wallet, now)
    text = render(buys, sells, wallet, now, since_line(previous, current, tx, names), size_positions.load_params(),
                  sum(s["price"] * s["remain"] for s in orders["sells"]), elsewhere,
                  portfolio.recently_listed(orders["sells"], now), names)
    if assets is None:
        text += "\n\n**No --assets:** unlisted stock is missing from Workflows 3 and 4; the review is incomplete without it."
    return text, current


def run(args, names_for) -> int:
    if args.wallet is None:
        print("Input error: report needs --wallet (get_wallet_balance)", file=sys.stderr)
        return 2
    orders = portfolio.load_orders(args.orders)
    ids = {o["order_id"] for o in orders["buys"] + orders["sells"]}
    first_seen, ledger_tx = read_ledger(args.ledger, ids)
    tx = portfolio.load_tx(*args.tx) if args.tx else ledger_tx
    if not tx:
        print("Input error: no transactions: run sync_wallet_ledger, or pass --tx", file=sys.stderr)
        return 2
    assets = portfolio.load_assets(args.assets) if args.assets else None
    ignore = portfolio.parse_id_list(args.ignore)
    at_station = set(portfolio.unlisted_stock(assets)[0]) - ignore if assets is not None else set()
    types = {o["type_id"] for o in orders["buys"] + orders["sells"]} | at_station
    names = names_for(sorted(types | set(assets or {})))
    a4e_rows = a4e.load_dir(args.a4e_dir, a4e.sde_resolver()) if args.a4e_dir else {}
    previous = None
    if args.since:
        with open(args.since) as f:
            previous = json.load(f)
    text, current = build(orders, market.fetch_many(types), tx, first_seen, assets, a4e_rows, names, args.wallet,
                          market.now_utc(), previous, None if args.no_hv else args.hv_floor, ignore)
    newest = max(t["dt"] for t in tx)
    print(text)
    print(f"\nTransactions run to {newest:%m-%d %H:%M}Z; later fills are not counted.")
    if not first_seen:
        print("No ledger order history: ages come from `issued`, which a reprice resets.")
    if not a4e_rows:
        print("No --a4e-dir: no high-velocity floor, A4E trades/day or sold-into-bids figures.")
    if args.save:
        with open(args.save, "w") as f:
            json.dump(current, f)
    return 0
