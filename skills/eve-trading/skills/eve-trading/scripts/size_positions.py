#!/usr/bin/env python3
"""
size_positions.py — shared sizing helper for the eve-trading skill.

Takes a list of candidates (kills, increases, or new positions) plus the
available capital and a buffer target, ranks them by **absolute profit**
(not margin %), and prints the table in the skill's required format:
Item | Unit price | Units | Cost | Margin | Trades/day | Total profit |
Yield/day | Running.

This exists because the same sizing/running-total/buffer-check logic has
been hand-rewritten inline many times across trading sessions — pulling it
into one script removes that repetition and the chance of an arithmetic
slip landing in front of the user.

Usage as a library (typical case, called from a Python one-liner or short
snippet inside the session rather than as a standalone CLI):

    from size_positions import size_positions

    candidates = [
        # name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, note
        ("Corpum C-Type Explosive Energized Membrane", 9062000, 5, 83.0, 24, 4013600, "verified twice, deep book"),
        ("Limited Neural Boost - Beta",                3512000, 5, 73.4, 31, 1375479, "31 trades/day"),
    ]
    size_positions(candidates, wallet=633239762, buffer_target_pct=10)

Each candidate is (name: str, unit_price: int, units: int, margin_pct: float,
trades_per_day: float, profit_per_unit: float, note: str). `profit_per_unit`
is the per-unit ISK profit at the verified margin (the `profitPerUnit` field
`get_portfolio_margins` already returns, or `sell*0.951 - buy*1.005` by
hand) — it's what total profit is computed from, so pass the real verified
figure, not a derived guess.

**Ranking is by total position profit (profit_per_unit × rounded units),
descending — not by margin %.** A thinner margin on a higher-value or
larger position routinely beats a flashy margin on a small one; margin
alone has repeatedly led to proposing the wrong item first (a 97% margin
on a small position can trail a 73% margin on a position with a higher
per-unit payout). The script re-sorts candidates into profit order itself
— you no longer need to pre-sort by hand — though liquidity/thin-book
caution still belongs in the unit counts you pass in, not in manually
reordering the list to work around the sort. Pass `rank_by_profit=False`
only if you have a specific reason to preserve your own input order (rare
— e.g. presenting Kills in the order positions were opened).

**Units are rounded to the nearest multiple of 5 (minimum 5)** before
costing — the skill's position-sizing rule is "increments of 5 or 10,
never an odd one-off count like 3," specifically so a position is worth
the broker-fee overhead of opening and relisting it. Pass whatever unit
count your liquidity judgment lands on; the script corrects it to the
nearest clean increment rather than silently trusting an off-increment
number through to the table. There's essentially always enough capital to
round up rather than down when in doubt — don't shrink a position to an
awkward count just to fit a budget when the next multiple of 5 would
still clear the buffer target. Total profit is computed from the
*rounded* unit count, and ranking happens after rounding, since that's
the actual position being proposed.

If greedily filling in profit order would blow past the buffer target,
this script stops adding rows once the target is hit and reports what was
left out — it does not silently shrink unit counts to make things fit.
Trim candidates yourself and re-run if the leftovers matter.

**Yield/day is a velocity-adjusted capital-efficiency score, not margin
restated.** Plain profit ÷ capital invested is almost the same number as
margin % (margin's denominator just adds the buy-side broker fee) — it
tells you nothing margin doesn't already say. Yield/day instead folds in
how often the trade can realistically repeat: `(profit_per_unit /
unit_price) * trades_per_day * 100`, expressed as a percent. It is
deliberately scale-independent (the same value regardless of how many
units you size) because it's meant to rank *opportunities* before a size
is chosen, not to restate the sized position's profit. A high-margin item
that only trades a handful of times a day can score lower here than a
thinner-margin item that cycles constantly — that's the point: it's the
numeric backing for the Workflow 5 observation that a slow-cycling margin
can be worse than a fast-cycling thinner one. Treat it as a comparative
ranking aid, not a literal forecast of daily return — it assumes the
position keeps capturing a representative share of daily volume, which a
single static buy order won't literally do order-by-order.
"""

from __future__ import annotations


def _round_to_increment(units: int, increment: int = 5) -> int:
    """Round to the nearest multiple of `increment`, with a floor of `increment`."""
    if units <= 0:
        return increment
    rounded = round(units / increment) * increment
    return max(rounded, increment)


def size_positions(
    candidates: list[tuple[str, int, int, float, float, float, str]],
    wallet: float,
    buffer_target_pct: float = 10.0,
    stop_at_buffer: bool = True,
    unit_increment: int = 5,
    rank_by_profit: bool = True,
) -> dict:
    """
    Print the required sizing table and return a summary dict.

    candidates: list of (name, unit_price, units, margin_pct, trades_per_day,
        profit_per_unit, note). `units` is rounded to the nearest multiple of
        `unit_increment` (min `unit_increment`) before costing, and the
        resulting total profit (profit_per_unit * rounded units) is what
        ranking and the printed "Total profit" column use — see module
        docstring.
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
    rank_by_profit: if True (default), re-sort candidates by total profit
        descending before sizing. Set False to preserve the input order
        (e.g. presenting Kills in the order the positions were opened).

    Returns a dict with: rows (list of dicts actually included), total,
    total_profit, buffer, buffer_pct, excluded (list of names not included).
    """
    buffer_floor = wallet * (buffer_target_pct / 100.0)
    running = 0.0
    running_profit = 0.0
    included = []
    excluded = []

    # Round units first, then rank by the resulting total profit — ranking
    # must reflect the position actually being sized, not the raw input.
    prepared = []
    for name, unit_price, raw_units, margin_pct, trades_per_day, profit_per_unit, note in candidates:
        units = _round_to_increment(raw_units, unit_increment)
        total_profit = profit_per_unit * units
        yield_per_day_pct = (profit_per_unit / unit_price) * trades_per_day * 100 if unit_price else 0.0
        prepared.append(
            (name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, total_profit, yield_per_day_pct, note)
        )

    if rank_by_profit:
        prepared.sort(key=lambda row: row[6], reverse=True)

    header = (
        f"{'Item':50s} {'Unit price':>13s} {'Units':>6s} {'Cost':>14s} "
        f"{'Margin':>7s} {'Trades/d':>9s} {'Total profit':>14s} {'Yield/day':>10s}  Running"
    )
    print(header)
    print("-" * len(header))

    for name, unit_price, units, margin_pct, trades_per_day, profit_per_unit, total_profit, yield_per_day_pct, note in prepared:
        cost = unit_price * units
        if stop_at_buffer and (wallet - (running + cost)) < buffer_floor:
            excluded.append(name)
            continue
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
                "yield_per_day_pct": yield_per_day_pct,
                "note": note,
                "running_total": running,
            }
        )
        print(
            f"{name:50s} {unit_price:>13,.0f} {units:>6d} {cost:>14,.0f} "
            f"{margin_pct:6.1f}% {trades_per_day:>9.0f} {total_profit:>14,.0f} {yield_per_day_pct:>9.1f}%  {running:>14,.0f}   ({note})"
        )

    buffer = wallet - running
    buffer_pct_actual = (buffer / wallet * 100) if wallet else 0.0

    print()
    print(f"Wallet:          {wallet:>16,.0f}")
    print(f"Total deployed:  {running:>16,.0f}")
    print(f"Total profit:    {running_profit:>16,.0f}")
    print(f"Buffer:          {buffer:>16,.0f}  ({buffer_pct_actual:.1f}%)")

    if excluded:
        print()
        print(f"Excluded to hold the buffer target ({buffer_target_pct:.0f}%):")
        for name in excluded:
            print(f"  - {name}")

    return {
        "rows": included,
        "total": running,
        "total_profit": running_profit,
        "buffer": buffer,
        "buffer_pct": buffer_pct_actual,
        "excluded": excluded,
    }


if __name__ == "__main__":
    # Small smoke-test / usage example when run directly.
    # Second row has lower margin than the first but higher total profit
    # once sized — the sort should put it first.
    example_candidates = [
        ("Polarized Neutron Blaster Cannon", 11320000, 5, 97.6, 23, 11210570, "verified clean, deep book"),
        ("Corpum B-Type Explosive Energized Membrane", 20840000, 5, 73.4, 11, 15535700, "thinnest book of the batch"),
        ("Centum A-Type Thermal Energized Membrane", 47850000, 3, 64.1, 18, 9742300, "18 trades/day, deep (rounds 3 -> 5)"),
    ]
    size_positions(example_candidates, wallet=633239762, buffer_target_pct=10)
