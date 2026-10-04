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
(sizing band, slot floor, order cap, T3 share flag) are defined in
reference/strategy.md; the defaults below mirror that table.

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
cycle, which cuts against "fewer, larger positions" — so the slot floor
(`min_profit_per_slot`, default 10M) flags rows whose total profit per full
cycle is below the floor — flagged, never dropped.

**Units are rounded to the nearest multiple of 5 (minimum 5)** before
costing. Total profit is computed from the rounded unit count and ranking
happens after rounding. The script never silently shrinks a unit count to fit
a budget.

**Sizing band.** Each row shows its units as a share of the item's daily
trade count. Rows above `trade_share_band[1]` (default 50%) are flagged
OVER-BAND. A row whose *minimum* size (one increment, 5 units) already
exceeds the band ceiling is a thin item and is excluded outright (reported
in `excluded_reasons`) — that is the thin-T3 exclusion. Trades/day <= 0 means
"unknown" and skips the share check.

**Capital.** `wallet` is cash now; `freed` is the escrow the Kill list would
return (redeploy mode — see reference/capital-allocation.md); the pool sized
against is wallet + freed. The buffer is `buffer_target_isk` if given
(users state buffers in ISK), else `buffer_target_pct` of the pool. If
`stop_at_buffer` is True (default) rows that would breach the buffer are
excluded and reported.

**Slot discipline.** There is no cap on open buy orders (the user said 40-60
is fine; `max_open_orders` exists but defaults to None). Pass
`current_open_orders` (the count after any assumed Kills) to print the order
count after the adds; a note appears only if it lands above `order_range[1]`
(60). Pass `current_tier_escrow` ({"T1":..,"T2":..,"T3":..} in ISK, after
assumed Kills) to print the T1/T2/T3 escrow shares before and after; tiers
are by unit price (T1 0.5-5M, T2 5-20M, T3 20-50M). The tier mix is
report-only — `t3_share_flag_pct` defaults to None (no flag). The summary
also prints the fewer-orders variant: the shortest prefix of the ranked list
that holds `variant_profit_share` (default two thirds) of the total profit.
"""

from __future__ import annotations

TIER_BOUNDS = [
    (0, 500_000, "micro"),
    (500_000, 5_000_000, "T1"),
    (5_000_000, 20_000_000, "T2"),
    (20_000_000, 50_000_000, "T3"),
    (50_000_000, float("inf"), "T4+"),
]


def tier_of(unit_price: float) -> str:
    """Tier by unit price: T1 0.5-5M, T2 5-20M, T3 20-50M (micro below, T4+ above)."""
    for low, high, name in TIER_BOUNDS:
        if low <= unit_price < high:
            return name
    return "T4+"


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


def size_positions(
    candidates: list[tuple[str, int, int, float, float, float, str]],
    wallet: float,
    buffer_target_pct: float = 10.0,
    stop_at_buffer: bool = True,
    unit_increment: int = 5,
    rank_by: str = "yield",
    rank_by_profit: bool | None = None,
    freed: float = 0.0,
    buffer_target_isk: float | None = None,
    trade_share_band: tuple[float, float] = (25.0, 50.0),
    min_profit_per_slot: float | None = 10_000_000,
    current_open_orders: int | None = None,
    max_open_orders: int | None = None,
    order_range: tuple[int, int] = (40, 60),
    current_tier_escrow: dict | None = None,
    t3_share_flag_pct: float | None = None,
    variant_profit_share: float = 2 / 3,
) -> dict:
    """
    Print the required sizing table plus the slot-discipline summary and
    return a summary dict.

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
        the count after the adds, with a note only if it exceeds
        order_range[1]. max_open_orders is an optional hard-ish cap (default
        None = no cap).
    current_tier_escrow: escrow by tier after assumed Kills, for the
        before/after mix (report-only). t3_share_flag_pct, if set, flags a
        T3 share above that percent; default None = no flag.
    variant_profit_share: fraction of total profit the fewer-orders variant
        must retain.

    Returns a dict with: rows, total, total_profit, buffer, buffer_pct, pool,
    excluded (names), excluded_reasons (name -> reason), small_slot (names),
    over_band (names), order_count_after, tier_mix_after, variant.
    """
    if rank_by_profit is not None:
        rank_by = "profit" if rank_by_profit else "input"
    if rank_by not in ("yield", "profit", "input"):
        raise ValueError(f"rank_by must be 'yield', 'profit' or 'input', got {rank_by!r}")

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


if __name__ == "__main__":
    # Smoke test / usage example (illustrative figures). The thin row is
    # excluded outright (5 units = 63% of 8 trades/day), the cheap filler row
    # is flagged SMALL-SLOT (about 1M per cycle against the 10M floor, as is the
    # cheap fast row at 8.4M), and the tier mix / order count lines print.
    example_candidates = [
        ("Corpum C-Type Medium Energy Nosferatu", 8428000, 10, 49.2, 22, 4167000, "deep book"),
        ("Moa", 8239000, 15, 24.2, 39, 2004000, "thin top asks"),
        ("Signal Amplifier II", 614400, 80, 17.1, 159, 105600, "cheap, fast"),
        ("Cheap filler example", 1000000, 10, 12.0, 60, 110000, "about 1M per cycle"),
        ("Thin T3 example", 31000000, 5, 14.0, 8, 4300000, "5 units = 63% of a day"),
    ]
    size_positions(
        example_candidates,
        wallet=1_415_400_000,
        freed=1_095_100_000,
        buffer_target_isk=400_000_000,
        current_open_orders=25,
        current_tier_escrow={"T1": 407e6, "T2": 685e6, "T3": 1395e6},
    )
