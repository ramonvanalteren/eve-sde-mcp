#!/usr/bin/env python3
"""
portfolio.py — read the character files a session saves from the eve-sde tools.

The scripts never call the eve-sde MCP tools themselves (they are not reachable from a
subprocess). The session saves each tool result to a JSON file, then passes the path:

    get_character_orders            -> orders.json     (the whole result, verbatim)
    get_wallet_transactions         -> tx.json         (verbatim; pass several files to merge them)
    get_character_assets            -> assets.json     (verbatim; group_by_type=true is easiest)

Large tool results are already written to a file by the harness — pass that path.
Formats accepted:

    orders:  {"orders": [{orderId, typeId, typeName, price, volumeRemain, volumeTotal,
              locationId, issued, isBuyOrder, escrow?, range}, ...]}  or a bare list
    tx:      {"transactions": [{transactionId, date, typeId, quantity, unitPrice, total, isBuy}, ...]}
             or a bare list; several files are merged and de-duplicated by transactionId
    assets:  {"assets": [{typeId, quantity, locations: [{locationId, quantity}]}]}  (group_by_type)
"""

from __future__ import annotations

import json
from pathlib import Path

from market import JITA, parse_iso


def _load(path):
    with open(path) as f:
        return json.load(f)


def load_orders(path) -> dict:
    """{'buys': [...], 'sells': [...]} with normalised keys."""
    raw = _load(path)
    rows = raw["orders"] if isinstance(raw, dict) else raw
    out = {"buys": [], "sells": []}
    for o in rows:
        is_buy = o.get("isBuyOrder")
        if is_buy is None:                      # older shape: only buys carry an escrow field
            is_buy = "escrow" in o
        d = dict(
            order_id=o["orderId"], type_id=o["typeId"], name=o.get("typeName", str(o["typeId"])),
            price=o["price"], remain=o["volumeRemain"], total=o["volumeTotal"],
            location=o.get("locationId"), issued=o.get("issued"), range=o.get("range"),
        )
        out["buys" if is_buy else "sells"].append(d)
    return out


def load_tx(*paths) -> list:
    """Wallet transactions merged across files, newest first, each with a parsed 'dt'."""
    seen, rows = set(), []
    for p in paths:
        raw = _load(p)
        for t in (raw["transactions"] if isinstance(raw, dict) else raw):
            if t["transactionId"] in seen:
                continue
            seen.add(t["transactionId"])
            rows.append(dict(t, dt=parse_iso(t["date"])))
    return sorted(rows, key=lambda t: t["dt"], reverse=True)


def load_assets(path) -> dict:
    """{type_id: {location_id: quantity}} from a group_by_type asset listing."""
    raw = _load(path)
    out = {}
    for a in raw["assets"] if isinstance(raw, dict) else raw:
        locs = a.get("locations") or [{"locationId": a.get("locationId"), "quantity": a.get("quantity", 0)}]
        out[a["typeId"]] = {int(l["locationId"]): l["quantity"] for l in locs}
    return out


def unlisted_stock(assets: dict, sells: list, station: int = JITA):
    """Units held but not covered by an open sell order.

    Returns (at_station, elsewhere): {type_id: units} for stock at `station` with no sell order
    behind it, and {type_id: {location: units}} for stock sitting anywhere else (it cannot be
    listed at Jita 4-4 until it is moved; containers show up here too). The assets feed lags
    newly listed orders, so treat small gaps as provisional.
    """
    listed = {}
    for s in sells:
        listed[s["type_id"]] = listed.get(s["type_id"], 0) + s["remain"]
    at_station, elsewhere = {}, {}
    for t, locs in assets.items():
        gap = locs.get(station, 0) - listed.get(t, 0)
        if gap > 0:
            at_station[t] = gap
        rest = {l: q for l, q in locs.items() if l != station}
        if rest:
            elsewhere[t] = rest
    return at_station, elsewhere


def bounded_cost(buy_txs: list, held: int):
    """Bounded weighted-average cost of the `held` newest units bought.

    `buy_txs` must be buy transactions for one type, newest first. Returns
    (average cost or None, units covered, lots used as (date, units, price)). Held units
    beyond the buy history are left uncosted (units covered < held) — say so, don't guess.
    """
    need, cost, got, lots = held, 0.0, 0, []
    for r in buy_txs:
        if need <= 0:
            break
        take = min(need, r["quantity"])
        cost += take * r["unitPrice"]
        got += take
        need -= take
        lots.append((r["date"], take, r["unitPrice"]))
    return (cost / got if got else None), got, lots


def parse_id_list(text) -> set:
    """'18869, 19111' -> {18869, 19111}; empty/None -> set()."""
    return {int(x) for x in str(text or "").replace(" ", "").split(",") if x}


def default_ledger() -> Path:
    return Path.home() / ".eve-sde" / "ledger.db"
