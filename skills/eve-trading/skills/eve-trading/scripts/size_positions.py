#!/usr/bin/env python3
"""
size_positions.py — shared sizing helper for the eve-trading skill.

Takes a ranked list of candidates (kills, increases, or new positions) plus
the available capital and a buffer target, and prints the table in the
skill's required format: Item | Unit price | Units | Cost | Margin |
Trades/day | Running.

This exists because the same sizing/running-total/buffer-check logic has
been hand-rewritten inline many times across trading sessions — pulling it
into one script removes that repetition and the chance of an arithmetic
slip landing in front of the user.

Usage as a library (typical case, called from a Python one-liner or short
snippet inside the session rather than as a standalone CLI):

    from size_positions import size_positions

    candidates = [
        # name, unit_price, units, margin_pct, trades_per_day, note
        ("Corpum C-Type Explosive Energized Membrane", 9062000, 5, 83.0, 24, "verified twice, deep book"),
        ("Limited Neural Boost - Beta",                3512000, 5, 73.4, 31, "31 trades/day"),
    ]
    size_positions(candidates, wallet=633239762, buffer_target_pct=10)

Each candidate is (name: str, unit_price: int, units: int, margin_pct: float,
trades_per_day: float, note: str). Pass candidates pre-sorted in the priority
order you want them filled (usually margin descending, adjusted for liquidity
confidence per the skill's rules) — this script does NOT re-sort them; sizing
and liquidity-cap judgment stays with the model, not the script.

**Units are rounded to the nearest multiple of 5 (minimum 5)** before costing
— the skill's position-sizing rule is "increments of 5 or 10, never an odd
one-off count like 3," specifically so a position is worth the broker-fee
overhead of opening and relisting it. Pass whatever unit count your liquidity
judgment lands on; the script corrects it to the nearest clean increment
rather than silently trusting an off-increment number through to the table.
There's essentially always enough capital to round up rather than down when
in doubt — don't shrink a position to an awkward count just to fit a budget
when the next multiple of 5 would still clear the buffer target.

If greedily filling in the given order would blow past the buffer target,
this script will stop adding rows once the target is hit and report what
was left out — it does not silently shrink unit counts to make things fit.
Trim candidates yourself and re-run if the leftovers matter.
"""

from __future__ import annotations


def _round_to_increment(units: int, increment: int = 5) -> int:
    """Round to the nearest multiple of `increment`, with a floor of `increment`."""
    if units <= 0:
        return increment
    rounded = round(units / increment) * increment
    return max(rounded, increment)


def size_positions(
    candidates: list[tuple[str, int, int, float, float, str]],
    wallet: float,
    buffer_target_pct: float = 10.0,
    stop_at_buffer: bool = True,
    unit_increment: int = 5,
) -> dict:
    """
    Print the required sizing table and return a summary dict.

    candidates: list of (name, unit_price, units, margin_pct, trades_per_day,
        note), already in the priority order to fill. `units` is rounded to
        the nearest multiple of `unit_increment` (min `unit_increment`)
        before costing — see module docstring.
    wallet: total available capital (ISK) to size against.
    buffer_target_pct: minimum buffer to preserve, as a percent of wallet.
        Default 10 (matches the skill's default combined-allocation target;
        pass a different value if the user has specified one, e.g. a flat
        300M on a ~3B portfolio works out to a different pct at other scales).
    stop_at_buffer: if True (default), stop adding rows once including the
        next one would breach the buffer target, and report the rest as
        excluded. If False, size everything regardless of buffer (useful
        for full-deployment mode where the caller has already decided the
        list is meant to all go in).
    unit_increment: the rounding increment for unit counts. Default 5 (also
        covers 10, 15, ... — pass 10 if the user asks for strictly-10s only).

    Returns a dict with: rows (list of dicts actually included), total,
    buffer, buffer_pct, excluded (list of names not included).
    """
    buffer_floor = wallet * (buffer_target_pct / 100.0)
    running = 0.0
    included = []
    excluded = []

    header = (
        f"{'Item':50s} {'Unit price':>13s} {'Units':>6s} {'Cost':>14s} "
        f"{'Margin':>7s} {'Trades/d':>9s}  Running"
    )
    print(header)
    print("-" * len(header))

    for name, unit_price, raw_units, margin_pct, trades_per_day, note in candidates:
        units = _round_to_increment(raw_units, unit_increment)
        cost = unit_price * units
        if stop_at_buffer and (wallet - (running + cost)) < buffer_floor:
            excluded.append(name)
            continue
        running += cost
        included.append(
            {
                "name": name,
                "unit_price": unit_price,
                "units": units,
                "cost": cost,
                "margin_pct": margin_pct,
                "trades_per_day": trades_per_day,
                "note": note,
                "running_total": running,
            }
        )
        print(
            f"{name:50s} {unit_price:>13,.0f} {units:>6d} {cost:>14,.0f} "
            f"{margin_pct:6.1f}% {trades_per_day:>9.0f}  {running:>14,.0f}   ({note})"
        )

    buffer = wallet - running
    buffer_pct_actual = (buffer / wallet * 100) if wallet else 0.0

    print()
    print(f"Wallet:          {wallet:>16,.0f}")
    print(f"Total deployed:  {running:>16,.0f}")
    print(f"Buffer:          {buffer:>16,.0f}  ({buffer_pct_actual:.1f}%)")

    if excluded:
        print()
        print(f"Excluded to hold the buffer target ({buffer_target_pct:.0f}%):")
        for name in excluded:
            print(f"  - {name}")

    return {
        "rows": included,
        "total": running,
        "buffer": buffer,
        "buffer_pct": buffer_pct_actual,
        "excluded": excluded,
    }


if __name__ == "__main__":
    # Small smoke-test / usage example when run directly.
    example_candidates = [
        ("Corpum C-Type Explosive Energized Membrane", 9062000, 5, 83.0, 24, "verified twice, deep book"),
        ("Limited Neural Boost - Beta", 3512000, 5, 73.4, 31, "31 trades/day"),
        ("Centum A-Type Thermal Energized Membrane", 47850000, 3, 64.1, 18, "18 trades/day, deep (rounds 3 -> 5)"),
    ]
    size_positions(example_candidates, wallet=633239762, buffer_target_pct=10)
