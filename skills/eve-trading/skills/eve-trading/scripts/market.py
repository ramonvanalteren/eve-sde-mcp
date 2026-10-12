#!/usr/bin/env python3
"""
market.py — shared live-market helpers for the eve-trading scripts.

Stdlib only (Python 3.9+). Public ESI, no authentication: region order books and
daily history for The Forge. Everything character-specific (open orders, wallet
transactions, assets) is read from JSON files the session saved from the eve-sde
tools — see `review_portfolio.py`.

What lives here, and why it matters:

* `nm(buy, sell)` — the net-margin formula from reference/margin-verification.md.
* `reaches_jita(order)` — whether a buy order can serve a seller at Jita 4-4
  (at the station, region-wide, or in Perimeter with range >= 1 jump).
* `analyse(...)` — one item's live picture: competitive bid, top and durable ask,
  margin at each, ask-ladder shape, 3-day history references, and the fill
  evidence in the live book (young, partly-filled bids near the top).

The fee profile below is the one in margin-verification.md. If the fee profile or
either location changes, change it there, in the A4E URLs (a4e.py) and here.

Fill evidence rule (reference/margin-verification.md, "Fill evidence"): the
ESI daily low versus a bid is NOT evidence about whether that bid fills — ESI
history is daily and 1-2 days stale. On 2026-10-09 two book snapshots 5.7 minutes
apart showed 20 units sold into the High-Tech Scanner's 550,900 bid, although the
daily lows were far above it. Use the A4E Sold2Buy columns plus the young
partly-filled bids that `analyse` counts (`fresh_fills`).
"""

from __future__ import annotations

import datetime
import json
import statistics
import time
import urllib.request
import concurrent.futures as cf

REGION = 10000002          # The Forge
JITA = 60003760            # Jita 4-4 Caldari Navy Assembly Plant (sell side)
PERIMETER = 1044752365771  # Perimeter HQ structure (buy side)
PERI_SYS = 30000144        # Perimeter system, 1 jump from Jita
BUY_FEE, SELL_FEE, SALES_TAX = 0.005, 0.015, 0.034
UA = {"User-Agent": "eve-trading-skill-scripts/1.0"}

# Fresh-fill window and "near the top" band used for the live-book fill evidence.
FRESH_HOURS = 24
NEAR_TOP = 0.98


def nm(buy: float, sell: float) -> float:
    """Net margin %, buy at Perimeter (0.5%), sell at Jita 4-4 (1.5% broker + 3.4% tax)."""
    cost = buy * (1 + BUY_FEE)
    return (sell * (1 - SELL_FEE - SALES_TAX) - cost) / cost * 100


def tick(price: float) -> float:
    """Smallest price step above `price` (four significant digits, 0.01 under 1,000)."""
    return 10 ** (max(len(str(int(price))) - 4, 0)) if price >= 1000 else 0.01


def reaches_jita(order: dict) -> bool:
    """Can this buy order serve a seller standing at Jita 4-4?"""
    if order["location_id"] == JITA:
        return True
    rng = order.get("range")
    if rng == "region":
        return True
    return order.get("system_id") == PERI_SYS and rng not in ("station", "solarsystem", None)


def get(url: str, tries: int = 4):
    """GET a JSON URL with retries; returns (data, pages) or (None, 1)."""
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r), int(r.headers.get("x-pages", "1"))
        except Exception:
            time.sleep(1 + i)
    return None, 1


def book(type_id: int):
    """All Forge orders for one type, every page; None if the fetch failed."""
    base = f"https://esi.evetech.net/latest/markets/{REGION}/orders/?type_id={type_id}&order_type=all&page="
    out, pages = get(base + "1")
    if out is None:
        return None
    for pg in range(2, pages + 1):
        more, _ = get(base + str(pg))
        if more:
            out += more
    return out


def hist(type_id: int):
    """Daily history for one type (ESI publishes ~11:05 UTC for the prior day); None on failure."""
    return get(f"https://esi.evetech.net/latest/markets/{REGION}/history/?type_id={type_id}")[0]


def fetch_many(type_ids, workers: int = 8):
    """{type_id: (book, history)} fetched concurrently."""
    ids = sorted(set(type_ids))
    with cf.ThreadPoolExecutor(workers) as ex:
        return {t: (b, h) for t, b, h in ex.map(lambda t: (t, book(t), hist(t)), ids)}


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def parse_iso(s: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def asks_of(bk) -> list:
    """Sell orders at Jita 4-4, cheapest first."""
    return sorted((o for o in bk if not o["is_buy_order"] and o["location_id"] == JITA), key=lambda o: o["price"])


def bids_of(bk, mine=frozenset()) -> list:
    """Buy orders that reach Jita 4-4, excluding the character's own, best first."""
    return sorted(
        (o for o in bk if o["is_buy_order"] and reaches_jita(o) and o["order_id"] not in mine),
        key=lambda o: -o["price"],
    )


def durable_ask(asks, min_units: int = 3):
    """Price at which the cumulative ask volume first reaches `min_units` (skips a lone outlier)."""
    cum = 0
    for o in asks:
        cum += o["volume_remain"]
        if cum >= min_units:
            return o["price"]
    return asks[0]["price"] if asks else None


def history_stats(h, bid: float, ask: float) -> dict:
    """3-day references from ESI history (trend and ceiling checks only — never fill evidence)."""
    h = sorted(h, key=lambda r: r["date"])[-14:]
    last3, prior = h[-3:], h[-10:-3]
    avg3 = statistics.mean(r["average"] for r in last3)
    avgp = statistics.mean(r["average"] for r in prior) if prior else avg3
    ask_days = sum(1 for r in last3 if r["highest"] >= ask * 0.98)
    med_hi = statistics.median(r["highest"] for r in last3)
    last8 = h[-8:]
    rng = (max(r["average"] for r in last8) / min(r["average"] for r in last8) - 1) * 100
    avgs = [r["average"] for r in last8]
    step = 0.0   # biggest jump of the last one or two days' average over the days before it, %
    if len(avgs) >= 4:
        step = max((statistics.mean(avgs[-n:]) / statistics.mean(avgs[:-n]) - 1) * 100 for n in (1, 2))
    return dict(
        ask_days=ask_days,
        med_hi=med_hi,
        ceil3=max(r["highest"] for r in last3),
        floor3=min(r["lowest"] for r in last3),
        trend=(avg3 / avgp - 1) * 100,
        vol3=statistics.mean(r["volume"] for r in last3),
        range8=rng,          # spread of the 8-day average price, %
        step2=step,          # largest one- or two-day jump of the average price, %
        hist_days=len(h),
    )


def analyse(type_id: int, bk, h, mine=frozenset(), now=None) -> dict:
    """One item's live picture. Returns {'err': ...} when it cannot be judged."""
    now = now or now_utc()
    if bk is None or h is None:
        return dict(t=type_id, err="fetch")
    bids, asks = bids_of(bk, mine), asks_of(bk)
    if not bids or not asks:
        return dict(t=type_id, err="one-sided", nb=len(bids), ns=len(asks))
    if len(h) < 3:
        return dict(t=type_id, err="short-history")
    comp = bids[0]["price"]
    bid = comp + tick(comp)                      # what a new order would pay to lead the queue
    ask = asks[0]["price"]
    ask_d = durable_ask(asks)
    age = lambda o: (now - parse_iso(o["issued"])).total_seconds() / 86400
    top_units = sum(o["volume_remain"] for o in asks if o["price"] <= ask * 1.001)
    nxt = next((o["price"] for o in asks if o["price"] > ask * 1.001), None)
    near = [o for o in bids if o["price"] >= comp * NEAR_TOP]
    young = [o for o in near if age(o) <= FRESH_HOURS / 24]
    hs = history_stats(h, bid, ask)
    sell_ref = ask if hs["ask_days"] >= 2 else min(ask, hs["med_hi"])
    return dict(
        t=type_id, comp=comp, bid=bid, ask=ask, ask_d=ask_d, nb=len(bids), ns=len(asks),
        top_units=top_units, gap=((nxt / ask - 1) * 100 if nxt else None),
        stale_days=statistics.median(age(o) for o in asks[:5]),
        nm_ask=nm(bid, ask), nm_d=nm(bid, ask_d), nm_sup=nm(bid, sell_ref), sell_ref=sell_ref,
        fresh_fills=sum(1 for o in young if o["volume_remain"] < o["volume_total"]),
        fresh_units=sum(o["volume_total"] - o["volume_remain"] for o in young),
        near=len(near), **hs,
    )


def verify(type_id: int, mine=frozenset()) -> dict:
    return analyse(type_id, book(type_id), hist(type_id), mine)


def tier_of(price: float, tiers: dict) -> str:
    """T1/T2/T3 by unit price using the strategy.md boundaries ({'T1': [lo, hi], ...})."""
    for name in ("T1", "T2", "T3"):
        lo, hi = tiers[name]
        if lo <= price < hi:
            return name
    return "micro" if price < tiers["T1"][0] else "T4+"
