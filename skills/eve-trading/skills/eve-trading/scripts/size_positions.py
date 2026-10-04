#!/usr/bin/env python3
"""
size_positions.py — shared sizing helper for the eve-trading skill.

Takes a list of candidates (kills' replacements, increases, or new positions)
plus the available capital and a buffer target, ranks them by **M/1M/day**
(velocity-adjusted yield), and prints the table in the skill's required
format: Item | Unit price | Units | Cost | Margin | Trades/day | Total profit |
M/1M/day | Running — followed by the slot-discipline summary (order count,
tier mix, small slots, fewer-orders variant).

This exists because the same sizing/running-total/buffer-check logic has
been hand-rewritten inline many times across trading sessions — pulling it
into one script removes that repetition and the chance of an arithmetic
slip landing in front of the user. The strategy parameters it enforces
(sizing band, profit-per-slot floor, comfortable order range, tier
boundaries, ...) are read from the JSON block in reference/strategy.md — the
single source of truth — and printed at the top of every run. Pass a keyword
argument to override one for a single run.

Command line (the usual way — run it, don't read it; stdlib only, Python 3.9+):

    python scripts/size_positions.py plan.json     # table + slot-discipline summary
    python scripts/size_positions.py --example     # print a sample plan.json
    python scripts/size_positions.py --params      # print the strategy parameters in force
    python scripts/size_positions.py plan.json --json   # structured result instead of the table

plan.json holds `wallet`, `candidates` (objects with name, unit_price, units,
margin_pct, trades_per_day, profit_per_unit and an optional note), and
optionally `freed`, `buffer_target_isk`, `current_open_orders`,
`current_tier_escrow` and an `options` object. The script validates the plan
and exits with status 2 and a message listing every problem found; margin /
profit mismatches and repeated names are printed as WARNING lines instead.

Usage as a library (called from a short Python snippet inside the session):

    from size_positions import size_positions

    candidates = [
        # name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, note
        ("Corpum C-Type Medium Energy Nosferatu", 8428000, 10, 49.2, 22, 4150000, "deep book"),
        ("Moa",                                   8239000, 15, 24.2, 39, 2000000, "thin top asks"),
    ]
    size_positions(candidates, wallet=1_415_400_000, freed=1_095_100_000,
                   buffer_target_isk=400_000_000,
                   current_open_orders=25,
                   current_tier_escrow={"T1": 407e6, "T2": 685e6, "T3": 1395e6})

Each candidate is (name: str, unit_price: int, units: int, margin_pct: float,
trades_per_day: float, profit_per_unit: float, note: str). `profit_per_unit`
is the per-unit ISK profit at the verified margin (the `profitPerUnit` field
`get_portfolio_margins` already returns, or `sell*0.951 - buy*1.005` by
hand) — total profit is computed from it, so pass the real verified figure.

**Ranking is by M/1M/day, descending** (`rank_by="yield"`, the default):
`(profit_per_unit / unit_price) * trades_per_day`, read as "M ISK of profit
per day, per 1M ISK committed" — e.g. 8.2 means 8.2M ISK/day of
profit-earning-potential for every 1M tied up. Same unit base on both sides
(millions) on purpose: "820%/day" reads like a literal compounding return
and invites the wrong conclusion. It is a comparative ranking aid, not a
forecast, and it is scale-independent (the same value however many units you
size). It is not margin restated — plain profit ÷ capital is margin % in
disguise; this folds in how often the trade can repeat. Other keys:
`rank_by="profit"` (total profit of the sized position) and `rank_by="input"`
(keep the caller's order). The old `rank_by_profit` flag still works
(True -> "profit", False -> "input") but is superseded by `rank_by`.

Yield-ranking alone favours cheap, fast items whose slots earn little per
cycle, so the profit-per-slot floor (`min_profit_per_slot`) flags rows whose
total profit per full cycle is below it — flagged, never dropped.

**Units are rounded to the nearest multiple of the unit increment (minimum
one increment; 5 at the time of writing)** before costing. Total profit is computed from the rounded unit count and ranking
happens after rounding. The script never silently shrinks a unit count to fit
a budget.

**Sizing band.** Each row shows its units as a share of the item's daily
trade count. Rows above the band ceiling (`trade_share_band[1]`) are flagged
OVER-BAND. A row whose *minimum* size (one increment) already exceeds the
band ceiling is a thin item and is excluded outright (reported in
`excluded_reasons`) — that is the thin-T3 exclusion. Trades/day <= 0 means
"unknown" and skips the share check.

**Capital.** `wallet` is cash now; `freed` is the escrow the Kill list would
return (redeploy mode — see reference/capital-allocation.md); the pool sized
against is wallet + freed. The buffer is `buffer_target_isk` if given
(users state buffers in ISK), else `buffer_target_pct` of the pool. If
`stop_at_buffer` is True (default) rows that would breach the buffer are
excluded and reported.

**Slot discipline.** There is no cap on open buy orders (`max_open_orders`
exists but is null in strategy.md). Pass `current_open_orders` (the count
after any assumed Kills) to print the order count after the adds; a note
appears only if it lands above the top of the comfortable order range
(`order_range[1]`). Pass `current_tier_escrow` ({"T1":..,"T2":..,"T3":..} in
ISK, after assumed Kills) to print the T1/T2/T3 escrow shares before and
after; tiers are by unit price (boundaries in strategy.md). The tier mix is
report-only unless `t3_share_flag_pct` is set. The summary also prints the
fewer-orders variant: the shortest prefix of the ranked list that holds
`variant_profit_share` of the total profit.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import re
import sys
from pathlib import Path

PARAMS_FILE = Path(__file__).resolve().parent.parent / "reference" / "strategy.md"
_PARAMS_BLOCK = re.compile(
    r"<!--\s*strategy-params:begin\s*-->\s*```json\s*(.*?)\s*```\s*<!--\s*strategy-params:end\s*-->", re.S
)
_REQUIRED_PARAMS = {
    "sizing_band_pct_of_daily_trades",
    "unit_increment",
    "rank_by",
    "min_profit_per_slot_isk",
    "comfortable_order_range",
    "max_open_orders",
    "t3_share_flag_pct",
    "fewer_orders_variant_profit_share",
    "tiers_isk_per_unit",
}


def load_params(path: Path = PARAMS_FILE) -> dict:
    """Read the strategy parameter block from reference/strategy.md (the single source of truth)."""
    restore = "The skill is version-controlled in eve-sde-mcp — restore reference/strategy.md from git history."
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"Cannot read the strategy parameters at {path}: {exc}. {restore}") from exc
    match = _PARAMS_BLOCK.search(text)
    if not match:
        raise RuntimeError(f"No <!-- strategy-params:begin --> JSON block found in {path}. {restore}")
    try:
        params = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"The strategy-params block in {path} is not valid JSON: {exc}") from exc
    missing = sorted(_REQUIRED_PARAMS - params.keys())
    if missing:
        raise RuntimeError(f"The strategy-params block in {path} is missing: {', '.join(missing)}")
    tiers = params["tiers_isk_per_unit"]
    if not (tiers["T1"][1] == tiers["T2"][0] and tiers["T2"][1] == tiers["T3"][0]):
        raise RuntimeError("tiers_isk_per_unit must be contiguous (T1 ceiling = T2 floor, T2 ceiling = T3 floor)")
    return params


PARAMS = load_params()


def _tier_bounds(params: dict) -> list:
    t = params["tiers_isk_per_unit"]
    bounds = [(0, t["T1"][0], "micro")]
    bounds += [(t[name][0], t[name][1], name) for name in ("T1", "T2", "T3")]
    bounds.append((t["T3"][1], float("inf"), "T4+"))
    return bounds


TIER_BOUNDS = _tier_bounds(PARAMS)


def tier_of(unit_price: float) -> str:
    """Tier by unit price per the strategy.md boundaries ("micro" below T1, "T4+" above T3)."""
    for low, high, name in TIER_BOUNDS:
        if low <= unit_price < high:
            return name
    return "T4+"


_UNSET = object()  # "use the strategy.md value" — distinct from an explicit None (= disabled)


def _round_to_increment(units: int, increment: int = 5) -> int:
    """Round to the nearest multiple of `increment`, with a floor of `increment`."""
    if units <= 0:
        return increment
    rounded = round(units / increment) * increment
    return max(rounded, increment)


def _mix(escrow_by_tier: dict) -> dict:
    total = sum(escrow_by_tier.values())
    return {t: (v / total * 100 if total else 0.0) for t, v in escrow_by_tier.items()}


def _fmt_mix(escrow_by_tier: dict) -> str:
    shares = _mix(escrow_by_tier)
    order = ["micro", "T1", "T2", "T3", "T4+"]
    parts = [f"{t} {shares[t]:.0f}%" for t in order if escrow_by_tier.get(t)]
    return " / ".join(parts) if parts else "n/a"


class InputError(ValueError):
    """The plan handed to size_positions is unusable; the message lists every problem found."""


_CANDIDATE_FIELDS = ("name", "unit_price", "units", "margin_pct", "trades_per_day", "profit_per_unit", "note")
_TIER_KEYS = ("micro", "T1", "T2", "T3", "T4+")
# Perimeter buy fee (0.5%) — only used for the soft margin/profit consistency warning, never for sizing.
_IMPLIED_MARGIN_BUY_FACTOR = 1.005


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _validate_inputs(
    candidates,
    wallet,
    freed,
    buffer_target_pct,
    buffer_target_isk,
    current_open_orders,
    current_tier_escrow,
    min_profit_per_slot,
    trade_share_band,
):
    """Return (normalized candidates, warnings); raise InputError listing every problem found.

    Errors are things that make the arithmetic meaningless (missing or non-numeric
    fields, non-positive prices or profits). Warnings are things that are probably
    a slip but computable: a margin that does not match its profit, a repeated name.
    """
    problems: list[str] = []
    warnings: list[str] = []
    rows = []

    if not isinstance(candidates, (list, tuple)) or not candidates:
        problems.append(f"candidates must be a non-empty list of {_CANDIDATE_FIELDS}")
    else:
        first_seen: dict[str, int] = {}
        for i, row in enumerate(candidates, start=1):
            if not isinstance(row, (list, tuple)) or len(row) != len(_CANDIDATE_FIELDS):
                problems.append(f"row {i}: expected {len(_CANDIDATE_FIELDS)} values {_CANDIDATE_FIELDS}, got {row!r}")
                continue
            name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, note = row
            tag = f"row {i} ({name!r})"
            row_ok = True
            if not isinstance(name, str) or not name.strip():
                problems.append(f"row {i}: name must be a non-empty string, got {name!r}")
                row_ok = False
            for field, value, rule, valid in (
                ("unit_price", unit_price, "a positive number of ISK", lambda v: v > 0),
                ("units", units, "a number, at least 1", lambda v: v >= 1),
                ("margin_pct", margin_pct, "a positive percentage (the verified two-call margin)", lambda v: v > 0),
                ("trades_per_day", trades_per_day, "a number, 0 or more (0 = unknown)", lambda v: v >= 0),
                ("profit_per_unit", profit_per_unit, "a positive ISK amount (the verified profit per unit)", lambda v: v > 0),
            ):
                if not _is_number(value) or not valid(value):
                    problems.append(f"{tag}: {field} must be {rule}, got {value!r}")
                    row_ok = False
            if note is not None and not isinstance(note, str):
                problems.append(f"{tag}: note must be text, got {note!r}")
                row_ok = False
            if not row_ok:
                continue
            implied = profit_per_unit / (unit_price * _IMPLIED_MARGIN_BUY_FACTOR) * 100
            if abs(implied - margin_pct) > max(1.0, 0.05 * margin_pct):
                warnings.append(
                    f"{name}: margin_pct {margin_pct:g}% but profit_per_unit / unit_price implies about {implied:.1f}% — "
                    "check that profit_per_unit is the per-unit profit at the verified (two-call) margin"
                )
            if name in first_seen:
                warnings.append(
                    f"{name!r} appears in rows {first_seen[name]} and {i} — fine for a second order on the same item, a mistake otherwise"
                )
            first_seen.setdefault(name, i)
            rows.append((name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, note or ""))

    for label, value in (("wallet", wallet), ("freed", freed)):
        if not _is_number(value) or value < 0:
            problems.append(f"{label} must be a number of ISK, 0 or more, got {value!r}")
    if buffer_target_isk is not None and (not _is_number(buffer_target_isk) or buffer_target_isk < 0):
        problems.append(f"buffer_target_isk must be a number of ISK, 0 or more, got {buffer_target_isk!r}")
    if not _is_number(buffer_target_pct) or not 0 <= buffer_target_pct <= 100:
        problems.append(f"buffer_target_pct must be between 0 and 100, got {buffer_target_pct!r}")
    if current_open_orders is not None and (
        isinstance(current_open_orders, bool) or not isinstance(current_open_orders, int) or current_open_orders < 0
    ):
        problems.append(f"current_open_orders must be a whole number, 0 or more, got {current_open_orders!r}")
    if current_tier_escrow is not None:
        if not isinstance(current_tier_escrow, dict):
            problems.append(f"current_tier_escrow must be a mapping of tier -> ISK, got {current_tier_escrow!r}")
        else:
            for tier, value in current_tier_escrow.items():
                if tier not in _TIER_KEYS:
                    problems.append(f"current_tier_escrow has unknown tier {tier!r}; use {_TIER_KEYS}")
                elif not _is_number(value) or value < 0:
                    problems.append(f"current_tier_escrow[{tier!r}] must be a number of ISK, 0 or more, got {value!r}")
    if min_profit_per_slot is not None and (not _is_number(min_profit_per_slot) or min_profit_per_slot < 0):
        problems.append(f"min_profit_per_slot must be a number of ISK, 0 or more, or None, got {min_profit_per_slot!r}")
    if (
        not isinstance(trade_share_band, (list, tuple))
        or len(trade_share_band) != 2
        or not all(_is_number(v) for v in trade_share_band)
        or not 0 < trade_share_band[0] < trade_share_band[1] <= 100
    ):
        problems.append(f"trade_share_band must be (low, high) percentages with 0 < low < high <= 100, got {trade_share_band!r}")

    if problems:
        raise InputError("size_positions input problems:\n  - " + "\n  - ".join(problems))
    return rows, warnings


def size_positions(
    candidates: list[tuple[str, int, int, float, float, float, str]],
    wallet: float,
    buffer_target_pct: float = 10.0,
    stop_at_buffer: bool = True,
    unit_increment=_UNSET,
    rank_by=_UNSET,
    rank_by_profit: bool | None = None,
    freed: float = 0.0,
    buffer_target_isk: float | None = None,
    trade_share_band=_UNSET,
    min_profit_per_slot=_UNSET,
    current_open_orders: int | None = None,
    max_open_orders=_UNSET,
    order_range=_UNSET,
    current_tier_escrow: dict | None = None,
    t3_share_flag_pct=_UNSET,
    variant_profit_share=_UNSET,
) -> dict:
    """
    Print the required sizing table plus the slot-discipline summary and
    return a summary dict. Every limit left at its default comes from the
    strategy.md parameter block; pass a keyword to override it for one run
    (an explicit None disables a limit that allows it).

    candidates: (name, unit_price, units, margin_pct, trades_per_day,
        profit_per_unit, note) tuples; `units` is rounded to the nearest
        multiple of `unit_increment` (min `unit_increment`) before costing.
    wallet: cash available now (ISK).
    freed: escrow returned by the Kills being assumed (ISK); pool = wallet + freed.
    buffer_target_pct / buffer_target_isk: buffer to preserve; the absolute
        ISK figure wins when given, else the percent of the pool.
    stop_at_buffer: stop adding rows that would breach the buffer (default);
        False sizes everything regardless.
    rank_by: "yield" (M/1M/day, default), "profit" (sized total profit), or
        "input" (caller's order). `rank_by_profit` is the legacy flag.
    trade_share_band: (low, high) percent of daily trades a position should
        occupy; rows above `high` are flagged OVER-BAND, and a row whose
        minimum size already exceeds `high` is excluded as thin.
    min_profit_per_slot: soft floor on total profit per full cycle; rows
        below it are flagged SMALL-SLOT (not excluded). None disables.
    current_open_orders: order count after assumed Kills; the summary prints
        the count after the adds, with a note only if it exceeds the top of
        `order_range` (the comfortable range). max_open_orders is an optional
        cap (null in strategy.md = no cap).
    current_tier_escrow: escrow by tier after assumed Kills, for the
        before/after mix (report-only). t3_share_flag_pct, if set, flags a
        T3 share above that percent; None = no flag.
    variant_profit_share: fraction of total profit the fewer-orders variant
        must retain.

    Returns a dict with: parameters (the resolved limits used), warnings, rows, total,
    total_profit, buffer, buffer_pct, pool, excluded (names),
    excluded_reasons (name -> reason), small_slot (names), over_band (names),
    order_count_after, tier_mix_after, variant.
    """
    unit_increment = PARAMS["unit_increment"] if unit_increment is _UNSET else unit_increment
    rank_by = PARAMS["rank_by"] if rank_by is _UNSET else rank_by
    trade_share_band = tuple(PARAMS["sizing_band_pct_of_daily_trades"]) if trade_share_band is _UNSET else trade_share_band
    min_profit_per_slot = PARAMS["min_profit_per_slot_isk"] if min_profit_per_slot is _UNSET else min_profit_per_slot
    max_open_orders = PARAMS["max_open_orders"] if max_open_orders is _UNSET else max_open_orders
    order_range = tuple(PARAMS["comfortable_order_range"]) if order_range is _UNSET else order_range
    t3_share_flag_pct = PARAMS["t3_share_flag_pct"] if t3_share_flag_pct is _UNSET else t3_share_flag_pct
    variant_profit_share = (
        PARAMS["fewer_orders_variant_profit_share"] if variant_profit_share is _UNSET else variant_profit_share
    )
    if rank_by_profit is not None:
        rank_by = "profit" if rank_by_profit else "input"
    if rank_by not in ("yield", "profit", "input"):
        raise ValueError(f"rank_by must be 'yield', 'profit' or 'input', got {rank_by!r}")

    candidates, warnings = _validate_inputs(
        candidates, wallet, freed, buffer_target_pct, buffer_target_isk,
        current_open_orders, current_tier_escrow, min_profit_per_slot, trade_share_band,
    )

    pool = wallet + freed
    buffer_floor = buffer_target_isk if buffer_target_isk is not None else pool * (buffer_target_pct / 100.0)
    band_low, band_high = trade_share_band

    running = 0.0
    running_profit = 0.0
    included = []
    excluded = []
    excluded_reasons: dict[str, str] = {}

    # Round units first, then rank — ranking must reflect the position
    # actually being sized, not the raw input.
    prepared = []
    for name, unit_price, raw_units, margin_pct, trades_per_day, profit_per_unit, note in candidates:
        units = _round_to_increment(raw_units, unit_increment)
        total_profit = profit_per_unit * units
        yield_m_per_1m_day = (profit_per_unit / unit_price) * trades_per_day if unit_price else 0.0
        prepared.append(
            (name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, total_profit, yield_m_per_1m_day, note)
        )

    if rank_by == "yield":
        prepared.sort(key=lambda row: (row[7], row[6]), reverse=True)
    elif rank_by == "profit":
        prepared.sort(key=lambda row: row[6], reverse=True)

    floor_txt = f"{min_profit_per_slot / 1e6:g}M" if min_profit_per_slot is not None else "off"
    print(
        f"Parameters (reference/strategy.md): band {band_low:g}-{band_high:g}% of daily trades | "
        f"increment {unit_increment} | rank by {rank_by} | profit-per-slot floor {floor_txt} | "
        f"comfortable orders {order_range[0]}-{order_range[1]}"
        + (f" | order cap {max_open_orders}" if max_open_orders is not None else "")
    )
    for warning in warnings:
        print(f"WARNING: {warning}")
    header = (
        f"{'Item':50s} {'Unit price':>13s} {'Units':>6s} {'Cost':>14s} "
        f"{'Margin':>7s} {'Trades/d':>9s} {'Total profit':>14s} {'M/1M/day':>10s}  Running"
    )
    print(header)
    print("-" * len(header))

    small_slot = []
    over_band = []

    for name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, total_profit, yield_m_per_1m_day, note in prepared:
        cost = unit_price * units

        # Thin-item exclusion: even the minimum size would be too big a share of the day.
        # (compared at whole-percent precision: 80 units on 159 trades/day is 50%, not over it)
        if trades_per_day > 0 and round(unit_increment / trades_per_day * 100) > band_high:
            excluded.append(name)
            excluded_reasons[name] = (
                f"thin: minimum {unit_increment} units = {unit_increment / trades_per_day * 100:.0f}% of "
                f"{trades_per_day:.1f} trades/day (band ceiling {band_high:.0f}%)"
            )
            continue

        if stop_at_buffer and (pool - (running + cost)) < buffer_floor:
            excluded.append(name)
            excluded_reasons[name] = "breaches the buffer target"
            continue

        share = (units / trades_per_day * 100) if trades_per_day > 0 else None
        flags = []
        if share is not None and round(share) > band_high:
            flags.append("OVER-BAND")
            over_band.append(name)
        if min_profit_per_slot is not None and total_profit < min_profit_per_slot:
            flags.append("SMALL-SLOT")
            small_slot.append(name)

        running += cost
        running_profit += total_profit
        included.append(
            {
                "name": name,
                "unit_price": unit_price,
                "units": units,
                "cost": cost,
                "margin_pct": margin_pct,
                "trades_per_day": trades_per_day,
                "profit_per_unit": profit_per_unit,
                "total_profit": total_profit,
                "yield_m_per_1m_day": yield_m_per_1m_day,
                "trade_share_pct": share,
                "tier": tier_of(unit_price),
                "flags": flags,
                "note": note,
                "running_total": running,
            }
        )
        share_txt = f" [{share:.0f}% of day]" if share is not None else ""
        flag_txt = f" {' '.join(flags)}" if flags else ""
        print(
            f"{name:50s} {unit_price:>13,.0f} {units:>6d} {cost:>14,.0f} "
            f"{margin_pct:6.1f}% {trades_per_day:>9.0f} {total_profit:>14,.0f} {yield_m_per_1m_day:>8.1f}M  {running:>14,.0f}   ({note}){share_txt}{flag_txt}"
        )

    buffer = pool - running
    buffer_pct_actual = (buffer / pool * 100) if pool else 0.0

    print()
    print(f"Wallet:          {wallet:>16,.0f}")
    if freed:
        print(f"Freed by kills:  {freed:>16,.0f}")
        print(f"Pool:            {pool:>16,.0f}")
    print(f"Total deployed:  {running:>16,.0f}")
    print(f"Total profit:    {running_profit:>16,.0f}   (if every position cycles once)")
    target_txt = f"{buffer_floor:,.0f} target" if buffer_target_isk is not None else f"{buffer_target_pct:.0f}% target"
    print(f"Buffer:          {buffer:>16,.0f}  ({buffer_pct_actual:.1f}% of pool; {target_txt})")

    # --- slot discipline -------------------------------------------------
    order_count_after = None
    if current_open_orders is not None:
        order_count_after = current_open_orders + len(included)
        note = ""
        if max_open_orders is not None and order_count_after > max_open_orders:
            note = f"; cap {max_open_orders} — OVER by {order_count_after - max_open_orders}"
        elif order_count_after > order_range[1]:
            note = f"; above the {order_range[0]}-{order_range[1]} range the user said is fine"
        print(f"Open buy orders: {current_open_orders} + {len(included)} new = {order_count_after}{note}")

    tier_mix_after = None
    added_by_tier: dict[str, float] = {}
    for row in included:
        added_by_tier[row["tier"]] = added_by_tier.get(row["tier"], 0.0) + row["cost"]
    if current_tier_escrow is not None:
        after = dict(current_tier_escrow)
        for t, v in added_by_tier.items():
            after[t] = after.get(t, 0.0) + v
        tier_mix_after = _mix(after)
        t3 = tier_mix_after.get("T3", 0.0)
        t3_flag = (
            f" — T3 ABOVE the {t3_share_flag_pct:.0f}% reference"
            if t3_share_flag_pct is not None and t3 > t3_share_flag_pct
            else ""
        )
        print(f"Tier mix (escrow): {_fmt_mix(current_tier_escrow)}  ->  {_fmt_mix(after)}{t3_flag}")
    elif added_by_tier:
        print(f"Tier mix of the adds (escrow): {_fmt_mix(added_by_tier)}")

    if small_slot:
        print(f"Below the {min_profit_per_slot / 1e6:g}M profit-per-slot floor: {', '.join(small_slot)}")
    if over_band:
        print(f"Above the {band_high:.0f}% of daily trades band: {', '.join(over_band)}")

    variant = None
    if len(included) >= 2 and running_profit > 0:
        cum = 0.0
        cum_cost = 0.0
        for i, row in enumerate(included, start=1):
            cum += row["total_profit"]
            cum_cost += row["cost"]
            if cum >= variant_profit_share * running_profit:
                variant = {
                    "rows": i,
                    "deployed": cum_cost,
                    "profit": cum,
                    "profit_share": cum / running_profit,
                    "buffer": pool - cum_cost,
                    "orders_after": (current_open_orders + i) if current_open_orders is not None else None,
                }
                break
        if variant:
            orders_txt = f", {variant['orders_after']} orders total" if variant["orders_after"] is not None else ""
            print(
                f"Fewer-orders variant: top {variant['rows']} rows ({variant['deployed'] / 1e6:,.0f}M) hold "
                f"{variant['profit_share'] * 100:.0f}% of the profit{orders_txt}, buffer {variant['buffer'] / 1e6:,.0f}M"
            )

    if excluded:
        print()
        print("Excluded:")
        for name in excluded:
            print(f"  - {name}: {excluded_reasons[name]}")

    return {
        "parameters": {
            "unit_increment": unit_increment,
            "rank_by": rank_by,
            "trade_share_band": tuple(trade_share_band),
            "min_profit_per_slot": min_profit_per_slot,
            "max_open_orders": max_open_orders,
            "order_range": tuple(order_range),
            "t3_share_flag_pct": t3_share_flag_pct,
            "variant_profit_share": variant_profit_share,
        },
        "warnings": warnings,
        "rows": included,
        "total": running,
        "total_profit": running_profit,
        "buffer": buffer,
        "buffer_pct": buffer_pct_actual,
        "pool": pool,
        "excluded": excluded,
        "excluded_reasons": excluded_reasons,
        "small_slot": small_slot,
        "over_band": over_band,
        "order_count_after": order_count_after,
        "tier_mix_after": tier_mix_after,
        "variant": variant,
    }


# ---------------------------------------------------------------------------
# Command line:  python scripts/size_positions.py plan.json
# ---------------------------------------------------------------------------

EXAMPLE_PLAN = {
    "wallet": 1_415_400_000,
    "freed": 1_095_100_000,
    "buffer_target_isk": 400_000_000,
    "current_open_orders": 25,
    "current_tier_escrow": {"T1": 407_000_000, "T2": 685_000_000, "T3": 1_395_000_000},
    "candidates": [
        {"name": "Corpum C-Type Medium Energy Nosferatu", "unit_price": 8_428_000, "units": 10,
         "margin_pct": 49.2, "trades_per_day": 22, "profit_per_unit": 4_167_000, "note": "deep book"},
        {"name": "Moa", "unit_price": 8_239_000, "units": 15,
         "margin_pct": 24.2, "trades_per_day": 39, "profit_per_unit": 2_004_000, "note": "thin top asks"},
        {"name": "Signal Amplifier II", "unit_price": 614_400, "units": 80,
         "margin_pct": 17.1, "trades_per_day": 159, "profit_per_unit": 105_600, "note": "cheap, fast: small slot"},
        {"name": "Thin T3 example", "unit_price": 31_000_000, "units": 5,
         "margin_pct": 14.0, "trades_per_day": 8, "profit_per_unit": 4_300_000, "note": "thin: gets excluded"},
    ],
}

_PLAN_KEYS = {
    "wallet", "freed", "buffer_target_isk", "buffer_target_pct", "current_open_orders",
    "current_tier_escrow", "candidates", "options",
}
_OPTION_KEYS = {
    "buffer_target_pct", "stop_at_buffer", "unit_increment", "rank_by", "trade_share_band",
    "min_profit_per_slot", "max_open_orders", "order_range", "t3_share_flag_pct", "variant_profit_share",
}


def _plan_to_kwargs(plan) -> dict:
    """Turn a decoded plan.json into size_positions keyword arguments, or raise InputError."""
    problems: list[str] = []
    if not isinstance(plan, dict):
        raise InputError("the plan must be a JSON object with at least `wallet` and `candidates`")
    for key in sorted(set(plan) - _PLAN_KEYS):
        problems.append(f"unknown plan field {key!r}; allowed: {sorted(_PLAN_KEYS)}")
    for key in ("wallet", "candidates"):
        if key not in plan:
            problems.append(f"missing required plan field {key!r}")

    candidates = []
    raw = plan.get("candidates")
    if isinstance(raw, list):
        for i, item in enumerate(raw, start=1):
            if isinstance(item, dict):
                missing = [f for f in _CANDIDATE_FIELDS[:-1] if f not in item]
                extra = sorted(set(item) - set(_CANDIDATE_FIELDS))
                if missing:
                    problems.append(f"row {i} ({item.get('name')!r}): missing {', '.join(missing)}")
                if extra:
                    problems.append(f"row {i} ({item.get('name')!r}): unknown field(s) {', '.join(extra)}")
                if not missing and not extra:
                    candidates.append(tuple(item.get(f) for f in _CANDIDATE_FIELDS))
            else:
                candidates.append(item)  # a 7-value list; _validate_inputs checks its shape
    elif "candidates" in plan:
        problems.append("`candidates` must be a list")

    options = plan.get("options", {})
    if not isinstance(options, dict):
        problems.append("`options` must be an object")
        options = {}
    for key in sorted(set(options) - _OPTION_KEYS):
        problems.append(f"unknown option {key!r}; allowed: {sorted(_OPTION_KEYS)}")
    if problems:
        raise InputError("plan problems:\n  - " + "\n  - ".join(problems))

    kwargs = {k: plan[k] for k in _PLAN_KEYS - {"candidates", "options"} if k in plan}
    kwargs["candidates"] = candidates if isinstance(raw, list) else raw
    kwargs.update({k: v for k, v in options.items() if k in _OPTION_KEYS})
    for key in ("trade_share_band", "order_range"):
        if isinstance(kwargs.get(key), list):
            kwargs[key] = tuple(kwargs[key])
    return kwargs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="size_positions.py",
        description="Size candidate buy positions: rank by M/1M/day, run the buffer walk, print the required table "
        "and the slot-discipline summary. Limits come from reference/strategy.md.",
    )
    parser.add_argument("plan", nargs="?", help="path to a plan JSON file, or - for stdin")
    parser.add_argument("--json", action="store_true", help="print the structured result as JSON instead of the table")
    parser.add_argument("--example", action="store_true", help="print a sample plan.json and exit")
    parser.add_argument("--params", action="store_true", help="print the strategy parameters in force and exit")
    args = parser.parse_args(argv)

    if args.params:
        print(json.dumps(PARAMS, indent=2))
        return 0
    if args.example:
        print(json.dumps(EXAMPLE_PLAN, indent=2))
        return 0
    if not args.plan:
        parser.error("give a plan file (or - for stdin), or use --example / --params")

    try:
        text = sys.stdin.read() if args.plan == "-" else Path(args.plan).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Input error: cannot read {args.plan}: {exc}", file=sys.stderr)
        return 2
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as exc:
        print(f"Input error: {args.plan} is not valid JSON: {exc}", file=sys.stderr)
        return 2

    try:
        kwargs = _plan_to_kwargs(plan)
        if args.json:
            with contextlib.redirect_stdout(io.StringIO()):
                result = size_positions(**kwargs)
            print(json.dumps(result, indent=2, default=str))
        else:
            size_positions(**kwargs)
    except InputError as exc:
        print(f"Input error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
