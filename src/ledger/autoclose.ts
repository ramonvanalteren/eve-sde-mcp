// Autonomous daily close: a heartbeat inside the MCP server process.
//
// While the server is running (i.e. while its MCP client is running), it
// syncs the wallet ledger daily and closes every completed UTC day after
// EVE downtime — without anyone asking. All actions are condition-based and
// idempotent, so missed ticks self-heal: a sleeping machine or a client
// that wasn't running just means the next tick catches up, closing any gaps
// within ESI's ~30-day journal window (bounded by `lookbackDays`).
//
// Why 11:30 UTC by default: a date's market history (the historical mark
// source for past-day closes) publishes at the next EVE downtime (~11:05
// UTC), so closing earlier would mark held inventory at cost. Realized
// figures don't care about the hour — only marks do.
//
// Design constraints honored here:
//  - never crash the server: every action is try/caught and recorded in
//    autoclose_runs; a dead MCP server is worse than a missed close
//  - never write to stdout: that's the MCP JSON-RPC channel — logs go to
//    stderr only
//  - retries capped per close_date AND per-day sync attempts capped per
//    character (default 3 each), and failed actions never accelerate the
//    next tick — a dead refresh token or ESI outage backs off to the normal
//    interval instead of hammering the API
//  - one process, one synchronous SQLite connection: autoclose and tool
//    calls serialize naturally; no locking needed

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSdeDir } from "../database.js";
import { listCharacters } from "../auth/tokens.js";
import { syncWalletLedger } from "./sync.js";
import { runDailyClose } from "./close.js";
import { getLedgerDb } from "./db.js";

// ===========================================================================
// Pure planning logic — no I/O, unit-tested directly (tests/ledger-autoclose).
// ===========================================================================

export interface AutoCloseConfig {
  /** Master switch; config.json {"autoClose": {"enabled": false}} turns the heartbeat off. */
  enabled: boolean;
  /** How often conditions are re-checked. */
  tickMinutes: number;
  /** Closes wait until this UTC hour (11.5 = 11:30) so yesterday's market history is published. */
  minUtcHour: number;
  /** Sync when the last successful sync is older than this many hours (data preservation for ESI's ~30-day windows; also bounds how stale "recent" data can be). */
  syncMaxAgeHours: number;
  /** Max sync attempts per character per UTC day — a dead refresh token or an ESI outage must not become a retry hammer. */
  maxSyncAttemptsPerDay: number;
  /** How many days back to close gaps (kept below ESI's ~30-day journal window). */
  lookbackDays: number;
  /** Max close attempts per (character, close_date) before giving up on that date. */
  maxAttemptsPerDate: number;
  /** Max backfill closes per character per tick — spreads ESI load. */
  maxBackfillsPerTick: number;
}

export const DEFAULT_AUTOCLOSE_CONFIG: AutoCloseConfig = {
  enabled: true,
  tickMinutes: 30,
  minUtcHour: 11.5,
  syncMaxAgeHours: 4,
  lookbackDays: 25,
  maxAttemptsPerDate: 3,
  maxBackfillsPerTick: 5,
  maxSyncAttemptsPerDay: 3,
};

/** Merge a (possibly partial, possibly invalid) config.json autoClose section over the defaults. */
export function mergeAutoCloseConfig(overrides: unknown): AutoCloseConfig {
  const o = (typeof overrides === "object" && overrides !== null ? overrides : {}) as Record<string, unknown>;
  const num = (key: keyof AutoCloseConfig, min: number, max: number): number | null => {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) return v;
    return null;
  };
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AUTOCLOSE_CONFIG.enabled,
    tickMinutes: num("tickMinutes", 1, 24 * 60) ?? DEFAULT_AUTOCLOSE_CONFIG.tickMinutes,
    minUtcHour: num("minUtcHour", 0, 24) ?? DEFAULT_AUTOCLOSE_CONFIG.minUtcHour,
    syncMaxAgeHours: num("syncMaxAgeHours", 1, 24 * 7) ?? DEFAULT_AUTOCLOSE_CONFIG.syncMaxAgeHours,
    lookbackDays: num("lookbackDays", 1, 27) ?? DEFAULT_AUTOCLOSE_CONFIG.lookbackDays,
    maxAttemptsPerDate: num("maxAttemptsPerDate", 1, 50) ?? DEFAULT_AUTOCLOSE_CONFIG.maxAttemptsPerDate,
    maxBackfillsPerTick: num("maxBackfillsPerTick", 1, 30) ?? DEFAULT_AUTOCLOSE_CONFIG.maxBackfillsPerTick,
    maxSyncAttemptsPerDay: num("maxSyncAttemptsPerDay", 1, 100) ?? DEFAULT_AUTOCLOSE_CONFIG.maxSyncAttemptsPerDay,
  };
}

export interface CharacterCloseState {
  characterId: number;
  characterName: string;
  /** Millis since epoch of the last successful sync, null if never. */
  lastSyncedAtMs: number | null;
  /** close_date values already stored in daily_closes. */
  closedDates: Set<string>;
  /** Failed close attempts per close_date (kind='close', outcome='failed'). */
  failedAttempts: Record<string, number>;
  /** Failed sync attempts for this character today (UTC) — caps retry hammering on dead tokens/ESI outages. */
  failedSyncAttemptsToday: number;
  /** Any wallet journal/transaction rows exist for this character. */
  hasActivity: boolean;
  /** UTC date (YYYY-MM-DD) of the earliest synced activity, null if none. */
  firstActivityDate: string | null;
}

export type AutoCloseAction =
  | { type: "sync"; characterId: number; characterName: string; reason: string }
  | { type: "close"; characterId: number; characterName: string; closeDate: string; reason: string };

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The most recently completed UTC day's date, as of `now`. */
export function previousUtcDayOf(now: Date): string {
  return utcDateString(new Date(now.getTime() - 86_400_000));
}

function utcHourFloat(now: Date): number {
  return now.getUTCHours() + now.getUTCMinutes() / 60;
}

function datesBetween(fromInclusive: string, toInclusive: string): string[] {
  const out: string[] = [];
  const start = new Date(`${fromInclusive}T00:00:00Z`).getTime();
  const end = new Date(`${toInclusive}T00:00:00Z`).getTime();
  for (let t = start; t <= end && out.length < 366; t += 86_400_000) {
    out.push(utcDateString(new Date(t)));
  }
  return out;
}

function subtractDays(dateStr: string, days: number): string {
  return utcDateString(new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - days * 86_400_000));
}

/**
 * Decide what this tick should do, per character, from pre-gathered state.
 * Pure: same inputs always produce the same plan. Rules:
 *  - sync when the last sync is older than syncMaxAgeHours (or never) —
 *    but not when a close is already planned for that character, since
 *    runDailyClose syncs first
 *  - close every day in [max(today - lookbackDays, firstActivityDate),
 *    yesterday] that isn't closed yet and hasn't exhausted its attempts;
 *    yesterday additionally waits until minUtcHour (market history), while
 *    older backfills can proceed any time — their marks have long been
 *    published
 *  - backfills are planned oldest-first (each close's opening NAV reads
 *    the prior close) and capped per tick to spread ESI load; the next
 *    tick continues the chain
 *  - characters with no ledger activity get no closes (nothing to close —
 *    but a stale sync is still planned, since it may discover activity)
 */
export function planAutoCloseTick(
  now: Date,
  chars: CharacterCloseState[],
  cfg: AutoCloseConfig
): AutoCloseAction[] {
  const actions: AutoCloseAction[] = [];
  const today = utcDateString(now);
  const yesterday = previousUtcDayOf(now);
  const nowHour = utcHourFloat(now);

  for (const c of chars) {
    const closes: AutoCloseAction[] = [];

    if (c.hasActivity && c.firstActivityDate) {
      const windowStart = [subtractDays(today, cfg.lookbackDays), c.firstActivityDate]
        .sort()
        .pop() as string; // max of the two
      if (windowStart <= yesterday) {
        for (const date of datesBetween(windowStart, yesterday)) {
          if (c.closedDates.has(date)) continue;
          if ((c.failedAttempts[date] ?? 0) >= cfg.maxAttemptsPerDate) continue;
          // Yesterday waits for market-history publication; older gaps don't.
          if (date === yesterday && nowHour < cfg.minUtcHour) continue;
          closes.push({
            type: "close",
            characterId: c.characterId,
            characterName: c.characterName,
            closeDate: date,
            reason: date === yesterday ? "yesterday_unclosed" : "backfill_gap",
          });
        }
      }
    }

    const planned = closes.slice(0, cfg.maxBackfillsPerTick); // oldest-first, capped
    actions.push(...planned);

    const syncStale =
      c.lastSyncedAtMs === null || now.getTime() - c.lastSyncedAtMs > cfg.syncMaxAgeHours * 3_600_000;
    if (syncStale && planned.length === 0 && c.failedSyncAttemptsToday < cfg.maxSyncAttemptsPerDay) {
      actions.push({
        type: "sync",
        characterId: c.characterId,
        characterName: c.characterName,
        reason:
          c.failedSyncAttemptsToday > 0
            ? "retry_after_failure"
            : c.lastSyncedAtMs === null
              ? "never_synced"
              : "stale",
      });
    }
  }

  return actions;
}

// ===========================================================================
// Executor — all I/O and failure containment lives below this line.
// ===========================================================================

function stderr(msg: string): void {
  process.stderr.write(`[autoclose ${new Date().toISOString()}] ${msg}\n`);
}

function readConfigFile(): unknown {
  try {
    return JSON.parse(readFileSync(join(getSdeDir(), "config.json"), "utf8"));
  } catch {
    return {}; // no config file / invalid JSON — defaults apply
  }
}

export function loadAutoCloseConfig(): AutoCloseConfig {
  const raw = readConfigFile() as { autoClose?: unknown };
  return mergeAutoCloseConfig(raw.autoClose);
}

/** SQLite `datetime('now')` stamps are "YYYY-MM-DD HH:MM:SS" UTC, not ISO. */
function parseDbTimestamp(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function gatherCharacterStates(): CharacterCloseState[] {
  const chars = listCharacters();
  if (chars.length === 0) return [];
  const db = getLedgerDb();

  return chars.map((c) => {
    const syncRow = db
      .prepare(`SELECT last_synced_at FROM sync_state WHERE character_id = ?`)
      .get(c.characterId) as { last_synced_at: string | null } | undefined;
    const closedRows = db
      .prepare(`SELECT close_date FROM daily_closes WHERE character_id = ?`)
      .all(c.characterId) as Array<{ close_date: string }>;
    const failRows = db
      .prepare(
        `SELECT close_date, COUNT(*) AS n FROM autoclose_runs
         WHERE character_id = ? AND kind = 'close' AND outcome = 'failed'
         GROUP BY close_date`
      )
      .all(c.characterId) as Array<{ close_date: string | null; n: number }>;
    const todayStartIso = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
    const syncFailRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM autoclose_runs
         WHERE character_id = ? AND kind = 'sync' AND outcome = 'failed' AND started_at >= ?`
      )
      .get(c.characterId, todayStartIso) as { n: number };
    const actRow = db
      .prepare(
        `SELECT MIN(d) AS first FROM (
           SELECT MIN(date) AS d FROM wallet_journal WHERE character_id = @id
           UNION ALL
           SELECT MIN(date) AS d FROM wallet_transactions WHERE character_id = @id
         )`
      )
      .get({ id: c.characterId }) as { first: string | null } | undefined;

    const failedAttempts: Record<string, number> = {};
    for (const r of failRows) if (r.close_date) failedAttempts[r.close_date] = r.n;

    return {
      characterId: c.characterId,
      characterName: c.characterName,
      lastSyncedAtMs: parseDbTimestamp(syncRow?.last_synced_at ?? null),
      closedDates: new Set(closedRows.map((r) => r.close_date)),
      failedAttempts,
      failedSyncAttemptsToday: syncFailRow?.n ?? 0,
      hasActivity: !!actRow?.first,
      firstActivityDate: actRow?.first ? actRow.first.slice(0, 10) : null,
    };
  });
}

function recordRun(
  characterId: number,
  kind: "sync" | "close",
  closeDate: string | null,
  startedAtMs: number,
  outcome: "ok" | "failed",
  error?: string
): void {
  const db = getLedgerDb();
  db.prepare(
    `INSERT INTO autoclose_runs (character_id, kind, close_date, started_at, finished_at, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    characterId,
    kind,
    closeDate,
    new Date(startedAtMs).toISOString(),
    new Date().toISOString(),
    outcome,
    error ?? null
  );
}

async function executeAction(action: AutoCloseAction): Promise<boolean> {
  const startedAtMs = Date.now();
  if (action.type === "sync") {
    try {
      const r = await syncWalletLedger(action.characterId);
      recordRun(action.characterId, "sync", null, startedAtMs, "ok");
      stderr(
        `sync ${action.characterName}: +${r.journalInserted} journal, +${r.transactionsInserted} tx (${action.reason})`
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordRun(action.characterId, "sync", null, startedAtMs, "failed", msg);
      stderr(`sync ${action.characterName} FAILED: ${msg}`);
      return false;
    }
  }
  try {
    const r = await runDailyClose(action.characterId, action.closeDate);
    recordRun(action.characterId, "close", action.closeDate, startedAtMs, "ok");
    stderr(
      `close ${action.characterName} ${action.closeDate} (${action.reason}): ` +
        `net ${Math.round(r.realizedPnlNet).toLocaleString()} ISK` +
        (r.flags.length > 0 ? ` [${r.flags.length} flag(s)]` : "")
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordRun(action.characterId, "close", action.closeDate, startedAtMs, "failed", msg);
    stderr(`close ${action.characterName} ${action.closeDate} FAILED: ${msg}`);
    return false;
  }
}

let tickTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let stopped = true;
let lastTickAt: Date | null = null;
let lastTickActions = 0;

async function tick(): Promise<void> {
  if (stopped || tickInFlight) return;
  tickInFlight = true;
  lastTickAt = new Date();
  const cfg = loadAutoCloseConfig();
  let nextDelayMs = cfg.tickMinutes * 60_000;
  try {
    if (!cfg.enabled) {
      lastTickActions = 0;
    } else {
      const states = gatherCharacterStates();
      const actions = planAutoCloseTick(new Date(), states, cfg);
      lastTickActions = actions.length;
      let successes = 0;
      for (const action of actions) {
        if (stopped) break;
        if (await executeAction(action)) successes++;
      }
      if (successes > 0) {
        // At least one action SUCCEEDED — check again soon to finish backfill
        // chains quickly. Failed actions deliberately do NOT accelerate the
        // tick: a dead token or ESI outage must back off to the normal
        // interval (plus the per-day attempt caps), not hammer the API.
        nextDelayMs = Math.min(nextDelayMs, 60_000);
      }
    }
  } catch (err) {
    // Never let a tick error escape — the heartbeat must survive anything.
    stderr(`tick error: ${err instanceof Error ? err.message : String(err)}`);
    lastTickActions = 0;
  } finally {
    tickInFlight = false;
    if (!stopped) scheduleNext(nextDelayMs);
  }
}

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    void tick();
  }, delayMs);
  // Critical: an unref'd timer does not keep the event loop alive. The
  // heartbeat runs only while the MCP transport is connected — when the
  // client closes the transport (app quit/restart) the loop empties and the
  // process exits instead of lingering as a zombie with a live heartbeat.
  tickTimer.unref?.();
}

/** Starts the heartbeat: a catch-up tick shortly after server start, then condition checks on an interval. */
export function startAutoClose(): void {
  if (!stopped) return;
  stopped = false;
  stderr(`heartbeat starting (config: ${JSON.stringify(loadAutoCloseConfig())})`);
  scheduleNext(15_000);
}

export function stopAutoClose(): void {
  stopped = true;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
}

/** Introspection for the get_autoclose_status tool. */
export function autoCloseHeartbeatInfo(): {
  active: boolean;
  tickInFlight: boolean;
  lastTickAt: string | null;
  lastTickActions: number;
  config: AutoCloseConfig;
} {
  return {
    active: !stopped,
    tickInFlight,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    lastTickActions,
    config: loadAutoCloseConfig(),
  };
}
