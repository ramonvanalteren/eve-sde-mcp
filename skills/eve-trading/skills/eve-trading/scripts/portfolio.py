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
             or one row per stack: {"assets": [{typeId, quantity, locationId}, ...]}

The assets feed holds only units that are NOT in an open sell order: listing a stack moves it out of
the hangar. So the quantity at a station is the unlisted stock there; do not subtract listed units
from it. The feed is cached for up to an hour, so units listed in the last hour can still show up in
it (see `recently_listed`).
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path

from market import JITA, parse_iso

# ESI caches assets for an hour and orders for 20 minutes; a little slack on top.
ASSET_FEED_LAG = datetime.timedelta(minutes=70)


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
    """{type_id: {location_id: quantity}} from a group_by_type listing or from one row per stack.

    Quantities add up per type and location, so several rows (or several location entries) for the
    same place are summed, never overwritten.
    """
    raw = _load(path)
    out = {}
    for a in raw["assets"] if isinstance(raw, dict) else raw:
        locs = a.get("locations") or [{"locationId": a.get("locationId"), "quantity": a.get("quantity", 0)}]
        by_loc = out.setdefault(a["typeId"], {})
        for l in locs:
            loc = int(l["locationId"])
            by_loc[loc] = by_loc.get(loc, 0) + l["quantity"]
    return out


def unlisted_stock(assets: dict, station: int = JITA):
    """Stock sitting in a hangar with no sell order behind it.

    The assets feed leaves out units that are in open sell orders, so what it shows at `station` is
    the unlisted stock; nothing is subtracted. Returns (at_station, elsewhere): {type_id: units} for
    stock at `station`, and {type_id: {location: units}} for stock anywhere else (it cannot be listed
    at Jita 4-4 until it is moved; containers show up here too). The feed is cached for up to an hour,
    so units listed in that time may still be counted: see `recently_listed`.
    """
    at_station, elsewhere = {}, {}
    for t, locs in assets.items():
        if locs.get(station, 0) > 0:
            at_station[t] = locs[station]
        rest = {l: q for l, q in locs.items() if l != station and q > 0}
        if rest:
            elsewhere[t] = rest
    return at_station, elsewhere


def recently_listed(sells: list, now, window=ASSET_FEED_LAG) -> set:
    """Type ids with a sell order issued (or repriced, which resets `issued`) inside the feed's lag.

    For these the assets feed may still show units that have just been listed, so their unlisted
    count is an upper bound until the feed catches up.
    """
    return {s["type_id"] for s in sells if s.get("issued") and now - parse_iso(s["issued"]) <= window}


def held_stock(sells: list, unlisted: dict):
    """{type_id: units held for sale}: units in open sell orders plus unlisted stock at the station."""
    held = {}
    for s in sells:
        held[s["type_id"]] = held.get(s["type_id"], 0) + s["remain"]
    for t, q in unlisted.items():
        held[t] = held.get(t, 0) + q
    return held


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


# The user's standing exclusions. It lives outside the repository, and an entry is written only when the
# user explicitly asks for a standing exclusion; a Kill or a cancelled order is not such a request.
EXCLUSIONS_DEFAULT = "~/.eve-sde/trading-exclusions.json"
_EXCLUSION_HELP = ('expected {"exclusions": [{"type_id": 123 or "name_prefix": "...", "added": "YYYY-MM-DD", '
                   '"request": "the user\'s words"}]}')


def load_exclusions(path=None):
    """(type ids, name prefixes, status line) from the user's exclusions file.

    A missing default file means there are no exclusions. A file named explicitly must exist, and any
    unreadable file or incomplete entry raises ValueError: an exclusion list is never silently ignored,
    and an entry without the date and the user's words has no provenance.
    """
    explicit = path is not None
    file = Path(path or EXCLUSIONS_DEFAULT).expanduser()
    if not file.exists():
        if explicit:
            raise ValueError(f"exclusions file not found: {file}")
        return set(), (), f"exclusions: none (no file at {file})"
    try:
        entries = _load(file)["exclusions"]
        if not isinstance(entries, list):
            raise TypeError("`exclusions` is not a list")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"exclusions file {file} is unreadable ({exc}); {_EXCLUSION_HELP}") from exc
    types, prefixes, shown = set(), [], []
    for i, e in enumerate(entries, start=1):
        e = e if isinstance(e, dict) else {}
        tid, prefix = e.get("type_id"), e.get("name_prefix")
        has_target = (isinstance(tid, int)) != (isinstance(prefix, str) and bool(prefix.strip()))
        if not has_target or not e.get("added") or not e.get("request"):
            raise ValueError(f"exclusions file {file}, entry {i} is incomplete; {_EXCLUSION_HELP}")
        if isinstance(tid, int):
            types.add(tid)
            label = e.get("name") or str(tid)
        else:
            prefixes.append(prefix.strip())
            label = f"prefix '{prefix.strip()}'"
        shown.append(f"{label} ({e['added']}: \"{e['request']}\")")
    if not shown:
        return set(), (), f"exclusions: none ({file} is empty)"
    return types, tuple(prefixes), f"exclusions: {len(shown)} from {file}: " + "; ".join(shown)
