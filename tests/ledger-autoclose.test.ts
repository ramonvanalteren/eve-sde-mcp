import { describe, it, expect } from "vitest";
import {
  planAutoCloseTick,
  mergeAutoCloseConfig,
  DEFAULT_AUTOCLOSE_CONFIG,
  previousUtcDayOf,
  type AutoCloseConfig,
  type CharacterCloseState,
} from "../src/ledger/autoclose.js";

const CFG: AutoCloseConfig = { ...DEFAULT_AUTOCLOSE_CONFIG };

/** 12:00 UTC on an arbitrary date — after the default 11:30 cutoff. */
const NOON = new Date("2026-09-12T12:00:00Z");
const YESTERDAY = previousUtcDayOf(NOON); // 2026-09-11

function char(overrides: Partial<CharacterCloseState>): CharacterCloseState {
  return {
    characterId: 1,
    characterName: "Test Char",
    // 3h before the tick time — fresh by default, deterministic against NOON
    lastSyncedAtMs: NOON.getTime() - 3 * 3_600_000,
    closedDates: new Set<string>(),
    failedAttempts: {},
    failedSyncAttemptsToday: 0,
    hasActivity: true,
    firstActivityDate: "2020-01-01",
    ...overrides,
  };
}

describe("mergeAutoCloseConfig", () => {
  it("keeps defaults for missing/invalid values", () => {
    expect(mergeAutoCloseConfig({})).toEqual(DEFAULT_AUTOCLOSE_CONFIG);
    expect(mergeAutoCloseConfig(null)).toEqual(DEFAULT_AUTOCLOSE_CONFIG);
    expect(mergeAutoCloseConfig({ tickMinutes: "soon" }).tickMinutes).toBe(
      DEFAULT_AUTOCLOSE_CONFIG.tickMinutes
    );
    expect(mergeAutoCloseConfig({ minUtcHour: -3 }).minUtcHour).toBe(DEFAULT_AUTOCLOSE_CONFIG.minUtcHour);
  });

  it("accepts valid overrides only", () => {
    const merged = mergeAutoCloseConfig({ enabled: false, minUtcHour: 13, lookbackDays: 10 });
    expect(merged.enabled).toBe(false);
    expect(merged.minUtcHour).toBe(13);
    expect(merged.lookbackDays).toBe(10);
    // above ESI's ~30-day journal window — clamped back to the default
    expect(mergeAutoCloseConfig({ lookbackDays: 60 }).lookbackDays).toBe(DEFAULT_AUTOCLOSE_CONFIG.lookbackDays);
  });
});

describe("planAutoCloseTick", () => {
  it("closes yesterday when it's the only missing day, after the downtime cutoff", () => {
    const actions = planAutoCloseTick(
      NOON,
      [char({ firstActivityDate: "2026-09-10", closedDates: new Set(["2026-09-10"]) })],
      CFG
    );
    expect(actions).toEqual([
      { type: "close", characterId: 1, characterName: "Test Char", closeDate: YESTERDAY, reason: "yesterday_unclosed" },
    ]);
    // a close was planned -> no separate sync even if it were stale
  });

  it("waits before the cutoff: yesterday is not planned", () => {
    const early = new Date("2026-09-12T08:00:00Z"); // before 11:30 UTC
    const c = char({ firstActivityDate: "2026-09-10", closedDates: new Set(["2026-09-10"]) });
    const closes = planAutoCloseTick(early, [c], CFG).filter((a) => a.type === "close");
    expect(closes).toHaveLength(0);
  });

  it("backfills older gaps even before the cutoff — their marks are long published", () => {
    const early = new Date("2026-09-12T08:00:00Z");
    // yesterday already closed; 09-10 missing; ledger started 09-09 (also closed)
    const c = char({ firstActivityDate: "2026-09-09", closedDates: new Set([YESTERDAY, "2026-09-09"]) });
    const closes = planAutoCloseTick(early, [c], CFG).filter(
      (a) => a.type === "close"
    ) as Array<{ closeDate: string; reason: string }>;
    expect(closes).toEqual([{ type: "close", characterId: 1, characterName: "Test Char", closeDate: "2026-09-10", reason: "backfill_gap" }]);
  });

  it("plans nothing for a character whose days are all closed and sync is fresh", () => {
    const c = char({ firstActivityDate: "2026-09-11", closedDates: new Set([YESTERDAY]) });
    expect(planAutoCloseTick(NOON, [c], CFG)).toEqual([]);
  });

  it("syncs when stale and no close is due", () => {
    const c = char({
      firstActivityDate: "2026-09-11",
      closedDates: new Set([YESTERDAY]),
      lastSyncedAtMs: NOON.getTime() - 5 * 3_600_000, // 5h ago, over the 4h max age
    });
    expect(planAutoCloseTick(NOON, [c], CFG)).toEqual([
      { type: "sync", characterId: 1, characterName: "Test Char", reason: "stale" },
    ]);
  });

  it("stops syncing a character that exhausted its daily sync attempts — the retry-hammer guard", () => {
    const capped = char({
      lastSyncedAtMs: null,
      failedSyncAttemptsToday: DEFAULT_AUTOCLOSE_CONFIG.maxSyncAttemptsPerDay,
      hasActivity: false,
      firstActivityDate: null,
    });
    expect(planAutoCloseTick(NOON, [capped], CFG)).toEqual([]);
    // between cap and zero: still retries, with a distinct reason
    const retrying = char({ lastSyncedAtMs: null, failedSyncAttemptsToday: 1, hasActivity: false, firstActivityDate: null });
    expect(planAutoCloseTick(NOON, [retrying], CFG)).toEqual([
      { type: "sync", characterId: 1, characterName: "Test Char", reason: "retry_after_failure" },
    ]);
  });

  it("syncs when never synced — even for a character with no ledger activity (sync may discover it)", () => {
    const c = char({ lastSyncedAtMs: null, hasActivity: false, firstActivityDate: null });
    expect(planAutoCloseTick(NOON, [c], CFG)).toEqual([
      { type: "sync", characterId: 1, characterName: "Test Char", reason: "never_synced" },
    ]);
  });

  it("never closes for a character with no activity", () => {
    const c = char({ hasActivity: false, firstActivityDate: null });
    const closes = planAutoCloseTick(NOON, [c], CFG).filter((a) => a.type === "close");
    expect(closes).toHaveLength(0);
  });

  it("clamps the backfill window to the lookback bound and caps the batch, oldest-first", () => {
    // Activity since 2020: window must start 25 days back, not 6 years.
    const actions = planAutoCloseTick(NOON, [char({})], CFG);
    const closes = actions.filter((a) => a.type === "close") as Array<{ closeDate: string }>;
    // 25 unclosed days capped to maxBackfillsPerTick=5, the 5 oldest
    expect(closes).toHaveLength(5);
    const dates = closes.map((x) => x.closeDate);
    expect(dates).toEqual([...dates].sort());
    const expectedStart = new Date("2026-09-12T00:00:00Z").getTime() - 25 * 86_400_000;
    expect(dates[0]).toBe(new Date(expectedStart).toISOString().slice(0, 10));
    // yesterday (the newest date in the window) is not in this batch — it
    // arrives on a later tick once the backfill chain catches up
    expect(dates).not.toContain(YESTERDAY);
  });

  it("clamps the backfill window to the first activity date", () => {
    // Character started trading 2026-09-09: only days since then are closeable
    const c = char({ firstActivityDate: "2026-09-09", closedDates: new Set([YESTERDAY]) });
    const closes = planAutoCloseTick(NOON, [c], CFG).filter((a) => a.type === "close") as Array<{
      closeDate: string;
    }>;
    expect(closes.map((x) => x.closeDate).sort()).toEqual(["2026-09-09", "2026-09-10"]);
  });

  it("skips dates that exhausted their retry budget, but never gives up on syncing", () => {
    const exhausted = char({
      firstActivityDate: "2026-09-11",
      closedDates: new Set(),
      failedAttempts: { [YESTERDAY]: DEFAULT_AUTOCLOSE_CONFIG.maxAttemptsPerDate },
    });
    expect(planAutoCloseTick(NOON, [exhausted], CFG).filter((a) => a.type === "close")).toHaveLength(0);
    const staleAndExhausted = { ...exhausted, lastSyncedAtMs: null };
    expect(planAutoCloseTick(NOON, [staleAndExhausted], CFG)).toEqual([
      { type: "sync", characterId: 1, characterName: "Test Char", reason: "never_synced" },
    ]);
  });

  it("treats each character independently", () => {
    const c1 = char({ characterId: 1, firstActivityDate: "2026-09-11", closedDates: new Set([YESTERDAY]) });
    const c2 = char({
      characterId: 2,
      characterName: "Second",
      firstActivityDate: "2026-09-11",
      closedDates: new Set(),
      lastSyncedAtMs: null,
    });
    const actions = planAutoCloseTick(NOON, [c1, c2], CFG);
    expect(actions.every((a) => a.characterId === 2)).toBe(true);
    expect(actions.find((a) => a.type === "close")).toMatchObject({
      characterId: 2,
      closeDate: YESTERDAY,
    });
  });

  it("rolls the target date at midnight UTC (a 00:15 tick targets the day that just ended)", () => {
    expect(previousUtcDayOf(new Date("2026-09-12T00:15:00Z"))).toBe("2026-09-11");
    expect(previousUtcDayOf(new Date("2026-09-11T23:45:00Z"))).toBe("2026-09-10");
  });

  it("validates maxSyncAttemptsPerDay like every other threshold", () => {
    expect(mergeAutoCloseConfig({ maxSyncAttemptsPerDay: 10 }).maxSyncAttemptsPerDay).toBe(10);
    expect(mergeAutoCloseConfig({ maxSyncAttemptsPerDay: -1 }).maxSyncAttemptsPerDay).toBe(
      DEFAULT_AUTOCLOSE_CONFIG.maxSyncAttemptsPerDay
    );
  });
});
