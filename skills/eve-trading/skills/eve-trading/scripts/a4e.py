#!/usr/bin/env python3
"""
a4e.py — fetch and parse the Adam4EVE margin-finder pages for Workflow 1.

Why raw HTML and not WebFetch: the fill-evidence gate needs columns a summarised
page drops (Sold2Buy volume and trades, the 7-day buy/sell price deltas). This
script saves the pages as-is and parses the results table itself.

    python scripts/a4e.py fetch OUTDIR      # saved tier pages T1/T2/T3 (3 pages each) + high-velocity pull
    python scripts/a4e.py show OUTDIR       # how many rows parsed, first rows

The three tier URLs are the saved filters in reference/workflow-new-candidates.md
(a test keeps them identical). The high-velocity pull is the supplement added on
2026-10-09: buy 500K-50M, >=100 trades/day, >=100M ISK/day, and no volatility
bands, because the bands drop the fast, thin-margin items the 7.5% high-velocity
floor exists for. If the fee profile ever changes, update `buyFee`/`sellFee`/
`salesTax` here, in the markdown, and in market.py together.

The table cell order is `COLUMNS` below (verified against the live page on 2026-10-10).
A4E reports Sold2Buy/BuyfSell as confirmed 7-day averages per day: `S2B_vol`/`S2B_trd`
are units and trades per day sold INTO buy orders, which is what fills a bid.
"""

from __future__ import annotations

import html
import re
import sqlite3
import sys
import urllib.request
import concurrent.futures as cf
from pathlib import Path

COLUMNS = [
    "name", "_", "spread", "spread%", "buy", "sell", "avgTrades", "avgISK", "days", "7dBuy", "7dSell",
    "7dBuyVol", "7dSellVol", "sell3h", "sell24h", "buy3h", "buy24h", "B4S_vol", "S2B_vol", "ratio_vol", "_2",
    "S2B_trd", "B4S_trd", "ratio_trd", "myBuy", "mySell", "T2B", "T2S", "age",
]

_BASE = (
    "https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station="
    "&buyGT={gt}&buyLT={lt}&tradesGT={tr}&tradesLT=&tradeIskGT={isk}&tradeIskLT=&supplyGT=&supplyLT="
    "&trackVolGT={a}&trackVolLT={b}&trackNumGT={a}&trackNumLT={b}"
    "&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage={p}"
)
TIERS = {
    "t1": dict(gt="500000%2C0", lt="5.000.000%2C0", tr=30, isk="50.000.000", a="0.5", b="2.5"),
    "t2": dict(gt="5.000.000%2C0", lt="20000000%2C0", tr=20, isk="100.000.000", a="0.3", b="4.0"),
    "t3": dict(gt="20.000.000%2C0", lt="50000000%2C0", tr=10, isk="200.000.000", a="0.2", b="5.0"),
}
_HV = (
    "https://dev.adam4eve.eu/margin_finder.php?category=&group=&mgroup=&hub=1&region=&station="
    "&buyGT=500000%2C0&buyLT=50000000%2C0&tradesGT=100&tradesLT=&tradeIskGT=100.000.000&tradeIskLT="
    "&supplyGT=&supplyLT=&trackVolGT=&trackVolLT=&trackNumGT=&trackNumLT="
    "&buyFee=0.5&sellFee=1.5&salesTax=3.4&rows=50&cpage={p}"
)
PAGES = {"t1": 3, "t2": 3, "t3": 3, "hv": 4}


def tier_url(tier: str, page: int = 1) -> str:
    return _BASE.format(p=page, **TIERS[tier])


def hv_url(page: int = 1) -> str:
    return _HV.format(p=page)


def jobs() -> list:
    out = [(f"{t}_p{p}.html", tier_url(t, p)) for t in TIERS for p in range(1, PAGES[t] + 1)]
    return out + [(f"hv_p{p}.html", hv_url(p)) for p in range(1, PAGES["hv"] + 1)]


def _download(job, outdir: Path):
    name, url = job
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        (outdir / name).write_bytes(data)
        return name, len(data)
    except Exception as exc:  # report, don't abort the other pages
        return name, f"FAILED: {exc}"


def fetch(outdir) -> list:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(4) as ex:
        return list(ex.map(lambda j: _download(j, outdir), jobs()))


def to_number(text):
    """A4E prints numbers European-style ('1.234.567,5'); None when it is not a number."""
    try:
        return float(text.replace("%", "").replace(".", "").replace(",", ".").strip())
    except (ValueError, AttributeError):
        return None


def table_rows(page_html: str) -> list:
    """Cell-text lists for every table row with at least 8 cells."""
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page_html, re.S):
        cells = [
            html.unescape(re.sub(r"<[^>]+>", "", td)).replace("\xa0", " ").strip()
            for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        ]
        if len(cells) >= 8:
            out.append(cells)
    return out


def parse_row(cells: list):
    """One data row as a dict, or None for the header or a malformed row."""
    d = dict(zip(COLUMNS, cells))
    buy, sell = to_number(d.get("buy")), to_number(d.get("sell"))
    if buy is None or sell is None:
        return None
    return dict(
        name=d["name"], buy=buy, sell=sell, spread_pct=to_number(d.get("spread%")),
        tr=to_number(d.get("avgTrades")), isk=to_number(d.get("avgISK")),
        d7buy=to_number(d.get("7dBuy")), d7sell=to_number(d.get("7dSell")),
        s2b_vol=to_number(d.get("S2B_vol")), s2b_trd=to_number(d.get("S2B_trd")),
        b4s_vol=to_number(d.get("B4S_vol")), b4s_trd=to_number(d.get("B4S_trd")),
    )


def sde_resolver(db_path=None):
    """name -> type_id using the local SDE (~/.eve-sde/eve.db, table invTypes)."""
    path = Path(db_path) if db_path else Path.home() / ".eve-sde" / "eve.db"
    con = sqlite3.connect(str(path))

    def resolve(name: str):
        row = con.execute("select typeID from invTypes where typeName=?", (name,)).fetchone()
        return row[0] if row else None

    return resolve


def load_dir(outdir, resolve) -> dict:
    """{type_id: row} from every saved page; the first page that lists a type wins (tier pages first)."""
    outdir = Path(outdir)
    files = sorted(outdir.glob("t*_p*.html")) + sorted(outdir.glob("hv_p*.html"))
    rows = {}
    for f in files:
        for cells in table_rows(f.read_text(errors="replace")):
            row = parse_row(cells)
            if row is None:
                continue
            tid = resolve(row["name"])
            if tid is not None and tid not in rows:
                rows[tid] = dict(row, type_id=tid, source=f.name)
    return rows


def main(argv) -> int:
    if len(argv) != 3 or argv[1] not in ("fetch", "show"):
        print(__doc__.split("The table cell order")[0])
        return 2
    if argv[1] == "fetch":
        for name, res in fetch(argv[2]):
            print(f"{name}: {res}")
        return 0
    rows = load_dir(argv[2], sde_resolver())
    print(f"{len(rows)} rows parsed from {argv[2]}")
    for r in list(rows.values())[:5]:
        print({k: r[k] for k in ("name", "buy", "sell", "tr", "s2b_vol", "s2b_trd", "d7buy", "d7sell")})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
