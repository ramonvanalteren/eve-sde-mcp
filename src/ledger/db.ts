import path from "path";
import Database from "better-sqlite3";
import { getSdeDir } from "../database.js";

let ledgerDb: Database.Database | null = null;

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function getLedgerDb(): Database.Database {
  if (ledgerDb) return ledgerDb;

  // Test seam: point the singleton at a throwaway file.
  const dbPath = process.env.EVE_SDE_LEDGER_PATH
    ? path.resolve(process.env.EVE_SDE_LEDGER_PATH)
    : path.join(getSdeDir(), "ledger.db");
  ledgerDb = new Database(dbPath);
  ledgerDb.pragma("journal_mode = WAL");

  ledgerDb.exec(`
    CREATE TABLE IF NOT EXISTS wallet_journal (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      amount REAL,
      balance REAL,
      description TEXT,
      context_id INTEGER,
      context_id_type TEXT,
      first_party_id INTEGER,
      second_party_id INTEGER,
      reason TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_character_date ON wallet_journal(character_id, date);
    CREATE INDEX IF NOT EXISTS idx_journal_ref_type ON wallet_journal(character_id, ref_type, date);

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      transaction_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      is_buy INTEGER NOT NULL,
      location_id INTEGER,
      client_id INTEGER,
      journal_ref_id INTEGER,
      -- Set once this transaction has been run through the FIFO engine
      -- (see src/ledger/close.ts), so a re-run of the close never double-counts it.
      fifo_applied INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tx_character_date ON wallet_transactions(character_id, date);
    CREATE INDEX IF NOT EXISTS idx_tx_fifo_pending ON wallet_transactions(character_id, fifo_applied);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON wallet_transactions(character_id, type_id, date);

    -- Open FIFO cost-basis lots. One row per buy transaction; remaining_qty is
    -- drawn down as sells consume it oldest-first. A lot with remaining_qty = 0
    -- is fully consumed but kept for audit trail (see lot_consumptions).
    CREATE TABLE IF NOT EXISTS lots (
      buy_transaction_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      original_qty INTEGER NOT NULL,
      remaining_qty INTEGER NOT NULL,
      unit_cost REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lots_type_date ON lots(character_id, type_id, date);

    -- One row per (sell, lot) match produced by the FIFO engine. A sell that
    -- outruns available lots (cost basis predates the ledger, or the units
    -- arrived via loot/reward/contract rather than a market buy) gets a row
    -- with buy_transaction_id/unit_cost NULL and unmatched = 1, so it shows up
    -- explicitly in a close's report instead of silently being priced at 0.
    CREATE TABLE IF NOT EXISTS lot_consumptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      sell_transaction_id INTEGER NOT NULL,
      buy_transaction_id INTEGER,
      type_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost REAL,
      unit_sell_price REAL NOT NULL,
      unmatched INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_consumptions_date ON lot_consumptions(character_id, date);
    CREATE INDEX IF NOT EXISTS idx_consumptions_sell ON lot_consumptions(sell_transaction_id);

    -- One immutable row per day, once closed. Never overwritten by a later
    -- sync -- re-running run_daily_close for a past date replaces that day's
    -- row explicitly, it doesn't happen as a side effect of syncing.
    CREATE TABLE IF NOT EXISTS daily_closes (
      character_id INTEGER NOT NULL,
      close_date TEXT NOT NULL,
      opening_wallet_balance REAL,
      closing_wallet_balance REAL,
      realized_revenue REAL NOT NULL,
      realized_cogs REAL NOT NULL,
      realized_pnl_gross REAL NOT NULL,
      sales_tax_paid REAL NOT NULL,
      broker_fees_paid REAL NOT NULL,
      realized_pnl_net REAL NOT NULL,
      unmatched_sell_revenue REAL NOT NULL DEFAULT 0,
      unmatched_sell_qty INTEGER NOT NULL DEFAULT 0,
      unrealized_pnl REAL,
      inventory_market_value REAL,
      escrow_committed REAL,
      opening_nav REAL,
      closing_nav REAL,
      non_trading_cashflow REAL,
      reconciliation_gap REAL,
      flags TEXT NOT NULL DEFAULT '[]',
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (character_id, close_date)
    );

    -- Orders, both currently open and historical (cancelled/expired/fulfilled).
    -- Kept locally because /orders/history/ is itself capped at ~90 days on
    -- ESI's end, and this is the data relist/new-listing fee correlation
    -- depends on (see src/ledger/fees.ts) -- without a permanent local copy,
    -- the correlation would only ever work within that live window.
    CREATE TABLE IF NOT EXISTS orders (
      order_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      is_buy_order INTEGER NOT NULL,
      price REAL NOT NULL,
      volume_total INTEGER NOT NULL,
      volume_remain INTEGER,
      location_id INTEGER,
      region_id INTEGER,
      issued TEXT NOT NULL,
      duration INTEGER,
      state TEXT NOT NULL,
      escrow REAL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_character_type ON orders(character_id, type_id, issued);
    CREATE INDEX IF NOT EXISTS idx_orders_character_issued ON orders(character_id, issued);

    CREATE TABLE IF NOT EXISTS sync_state (
      character_id INTEGER PRIMARY KEY,
      last_synced_at TEXT,
      journal_entries INTEGER NOT NULL DEFAULT 0,
      transactions INTEGER NOT NULL DEFAULT 0
    );

    -- Audit log of the autonomous daily-close heartbeat (see
    -- src/ledger/autoclose.ts): one row per sync/close attempt, successful
    -- or failed, so get_autoclose_status can show exactly what the server
    -- did without anyone having watched stderr.
    CREATE TABLE IF NOT EXISTS autoclose_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      close_date TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_autoclose_character_date ON autoclose_runs(character_id, close_date);
    CREATE INDEX IF NOT EXISTS idx_autoclose_started ON autoclose_runs(started_at);

    -- Synced industry jobs (see src/ledger/sync.ts). Manufacturing jobs
    -- (activity 1) that have been DELIVERED get their materials consumed
    -- from FIFO buy lots and a synthetic product lot at all-in basis
    -- (src/ledger/bom-close.ts) — bill-of-materials linkage, so product
    -- sells carry real cost basis instead of booking as zero-basis
    -- unmatched revenue.
    CREATE TABLE IF NOT EXISTS industry_jobs (
      job_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      activity_id INTEGER NOT NULL,
      blueprint_type_id INTEGER NOT NULL,
      product_type_id INTEGER,
      runs INTEGER NOT NULL,
      successful_runs INTEGER,
      cost REAL,
      start_date TEXT,
      end_date TEXT,
      completed_date TEXT,
      status TEXT NOT NULL,
      facility_id INTEGER,
      bom_applied INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_bom_pending ON industry_jobs(character_id, activity_id, bom_applied);

    -- Synced character blueprints (ESI /characters/{id}/blueprints/ —
    -- requires esi-characters.read_blueprints.v1, granted on the next
    -- login after the scope was added to the default set). The BOM pass
    -- resolves each delivered job's exact BPO ME from here via the job's
    -- blueprint item id — config blueprintME (type-keyed) is the fallback.
    CREATE TABLE IF NOT EXISTS character_blueprints (
      item_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      location_id INTEGER,
      location_flag TEXT,
      quantity INTEGER,
      material_efficiency INTEGER NOT NULL DEFAULT 0,
      time_efficiency INTEGER NOT NULL DEFAULT 0,
      runs INTEGER,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_blueprints_character_type ON character_blueprints(character_id, type_id);
  `);

  // Migrations for columns added after the table already existed on disk.
  ensureColumn(ledgerDb, "daily_closes", "escrow_movement", "REAL NOT NULL DEFAULT 0");
  ensureColumn(ledgerDb, "daily_closes", "broker_fees_new_listings", "REAL NOT NULL DEFAULT 0");
  ensureColumn(ledgerDb, "daily_closes", "broker_fees_relisting", "REAL NOT NULL DEFAULT 0");
  ensureColumn(ledgerDb, "daily_closes", "broker_fees_unmatched", "REAL NOT NULL DEFAULT 0");
  ensureColumn(ledgerDb, "daily_closes", "broker_fee_pct_used", "REAL");
  // How unrealized P&L was marked for this close: live Jita best-sell or
  // The Forge daily-average market history (past dates).
  ensureColumn(ledgerDb, "daily_closes", "marks_method", "TEXT");
  // Production section of the close (bill-of-materials linkage): JSON
  // summary of jobs delivered in the day — units produced, material cost,
  // installation, unit basis, missing-basis flags.
  ensureColumn(ledgerDb, "daily_closes", "production_json", "TEXT");
  // BOM material-consumption rows in lot_consumptions: inventory
  // transformation, not sales — realized-P&L queries exclude them.
  ensureColumn(ledgerDb, "lot_consumptions", "is_production", "INTEGER NOT NULL DEFAULT 0");
  // The specific blueprint item a job ran with (ESI job blueprint_id) —
  // joins to character_blueprints for exact per-BPO ME resolution.
  ensureColumn(ledgerDb, "industry_jobs", "blueprint_id", "INTEGER");

  return ledgerDb;
}

export function closeLedgerDb(): void {
  if (ledgerDb) {
    ledgerDb.close();
    ledgerDb = null;
  }
}
