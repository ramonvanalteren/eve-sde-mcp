// Station fee configuration and resolution for fee/order matching.
//
// Broker fees are station-specific and have TWO additive components: a
// percentage (NPC station tax shaped by Broker Relations skill/standings;
// plus the universal SCC surcharge everywhere) and/or a flat ISK amount per
// order (player structures). Jita 4-4 is effectively pure percentage
// (~1.49% observed, station tax + SCC combined); Perimeter-style structures
// charge a flat structure fee (e.g. 100 ISK) PLUS the 0.5% SCC surcharge.
// A character can legitimately buy at one station and sell at another,
// paying two different fee structures. ESI exposes none of this — which is
// why config is the source of truth.
//
// Resolution is CONFIG-FIRST (the user's preferred source of truth): pin
// fee models per station in ~/.eve-sde/config.json. Stations not in config
// fall back to derivation from the character's own unambiguous fee/order
// history (percentage form only — flat-fee stations are not derivable as
// rates), and stations with neither use the generic default and are flagged.
//
// Config shape (fee components are ADDITIVE: expected fee = value × pct/100 + flat):
// {
//   "clientId": "...",
//   "salesTaxPct": 3.4,
//   "stationFees": {
//     "60003760":      { "brokerFeePct": 1.491, "label": "Jita 4-4 CNAP" },
//     "1044752365771": { "brokerFeePct": 0.5, "brokerFeeFlat": 100, "label": "Perimeter 0.0% Neutral States Market HQ" }
//   }
// }
// (Perimeter's 0.5% is the universal SCC surcharge; its structure fee is the
// flat 100 ISK. Both are charged on placement AND on relisting.)
//
// Sales tax is character-level (skill/standings-based, station-independent
// for NPC stations); per-station salesTaxPct entries exist for structures
// that tax differently and are recorded for completeness — matching uses
// journal amounts for tax regardless, so tax config only matters where a
// rate estimate is needed (e.g. net-of-tax marks, which use the character
// level since sales happen at the sell station).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSdeDir } from "../database.js";
import { estimateBrokerFeePctByLocation, type BrokerFeeEntry, type OrderRecord } from "./fees.js";

export const DEFAULT_BROKER_FEE_PCT = 1.0;

export interface StationFeeConfigEntry {
  /** Percentage of order value per placement — NPC station tax and/or the universal SCC surcharge. */
  brokerFeePct?: number;
  /** Flat ISK per placement (player-structure fee). ADDITIVE with brokerFeePct. */
  brokerFeeFlat?: number;
  /** Structure/station tax rate at this location, if it differs from the character's rate. */
  salesTaxPct?: number;
  /** Human-readable name for reports (structure names aren't in the SDE). */
  label?: string;
}

/** A station's broker-fee model. Components are additive: expected fee =
 *  value × pct/100 + flat. Either side may be zero — NPC stations are pure
 *  percentage, Perimeter-style structures are flat + SCC surcharge. */
export interface FeeModel {
  pct: number;
  flat: number;
}

export type FeeProvenance = "config" | "derived" | "default";

export interface StationFeeModel {
  /** Station/structure location id as a string key; "unknown" for orders without a synced location. */
  key: string;
  locationId: number | null;
  model: FeeModel;
  provenance: FeeProvenance;
  label?: string;
  /** Unambiguous fee/order pairs behind a derived model. */
  sampleCount?: number;
}

export interface StationFeeSettings {
  /** Parsed + validated stationFees section; invalid entries are dropped. */
  stationFees: Record<string, StationFeeConfigEntry>;
  /** Character-level sales tax percentage from config, null if unset. */
  salesTaxPct: number | null;
}

/** Parse + validate the stationFees/salesTaxPct section of a config object.
 *  Pure — exported so the validation rules are testable without touching the
 *  machine-global config file. Invalid entries are dropped, never fatal. */
export function parseStationFeeSettings(raw: unknown): StationFeeSettings {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const stationFees: Record<string, StationFeeConfigEntry> = {};
  const rawStations = (typeof o.stationFees === "object" && o.stationFees !== null ? o.stationFees : {}) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(rawStations)) {
    if (typeof value !== "object" || value === null) continue;
    const e = value as Record<string, unknown>;
    const pct = typeof e.brokerFeePct === "number" && Number.isFinite(e.brokerFeePct) && e.brokerFeePct >= 0 ? e.brokerFeePct : undefined;
    const flat =
      typeof e.brokerFeeFlat === "number" && Number.isFinite(e.brokerFeeFlat) && e.brokerFeeFlat >= 0 ? e.brokerFeeFlat : undefined;
    if (pct === undefined && flat === undefined) continue; // no usable fee model — drop the entry
    stationFees[key] = {
      brokerFeePct: pct,
      brokerFeeFlat: flat,
      salesTaxPct: typeof e.salesTaxPct === "number" && e.salesTaxPct >= 0 ? e.salesTaxPct : undefined,
      label: typeof e.label === "string" ? e.label : undefined,
    };
  }
  return {
    stationFees,
    salesTaxPct:
      typeof o.salesTaxPct === "number" && Number.isFinite(o.salesTaxPct) && o.salesTaxPct >= 0 ? o.salesTaxPct : null,
  };
}

/** Read ~/.eve-sde/config.json and parse its station-fee section. */
export function loadStationFeeSettings(): StationFeeSettings {
  try {
    return parseStationFeeSettings(JSON.parse(readFileSync(join(getSdeDir(), "config.json"), "utf8")));
  } catch {
    return { stationFees: {}, salesTaxPct: null };
  }
}

export interface StationFeeResolution {
  byStation: Map<string, StationFeeModel>;
  /** The model applied to orders at stations with no config entry and no derivable rate. */
  fallbackModel: StationFeeModel;
}

/**
 * Resolve the fee model per station: config first, then derivation from the
 * character's own unambiguous fee/order history (percentage form), then the
 * generic default. Stations observed in the order history but with neither a
 * config entry nor a derivable rate still get an entry (with default
 * provenance) so reports can show exactly which stations need configuring.
 */
export function resolveStationFeeModels(
  fees: BrokerFeeEntry[],
  orders: OrderRecord[],
  settings: StationFeeSettings,
  fallbackPct: number = DEFAULT_BROKER_FEE_PCT
): StationFeeResolution {
  const byStation = new Map<string, StationFeeModel>();

  // Every station seen in the order history gets an entry, so unknown/unconfigured
  // stations are visible for discovery (get_station_fees) instead of silently
  // falling back.
  const seen = new Map<string, { locationId: number | null }>();
  for (const o of orders) {
    const key = String(o.locationId ?? "unknown");
    if (!seen.has(key)) seen.set(key, { locationId: o.locationId ?? null });
  }

  const derived = estimateBrokerFeePctByLocation(fees, orders);

  for (const [key, { locationId }] of seen) {
    const configEntry = settings.stationFees[key];
    if (configEntry) {
      byStation.set(key, {
        key,
        locationId,
        model: { pct: configEntry.brokerFeePct ?? 0, flat: configEntry.brokerFeeFlat ?? 0 },
        provenance: "config",
        label: configEntry.label,
      });
      continue;
    }
    const est = derived.get(locationId);
    if (est && est.estimatedPct !== null) {
      byStation.set(key, {
        key,
        locationId,
        model: { pct: est.estimatedPct, flat: 0 },
        provenance: "derived",
        sampleCount: est.sampleCount,
      });
      continue;
    }
    byStation.set(key, {
      key,
      locationId,
      model: { pct: fallbackPct, flat: 0 },
      provenance: "default",
      sampleCount: est?.sampleCount,
    });
  }

  return {
    byStation,
    fallbackModel: {
      key: "default",
      locationId: null,
      model: { pct: fallbackPct, flat: 0 },
      provenance: "default",
    },
  };
}

/** Human-readable fee model: "1.49%", "100 ISK flat", "0.5% + 100 ISK flat". */
export function formatFeeModel(model: FeeModel): string {
  const parts: string[] = [];
  if (model.pct > 0) parts.push(`${model.pct.toFixed(2)}%`);
  if (model.flat > 0) parts.push(`${model.flat} ISK flat`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}

/** The expected placement fee for an order under a station's model:
 *  value × pct/100 + flat. */
export function expectedFeeForOrder(order: OrderRecord, model: FeeModel): number {
  return order.price * order.volumeTotal * (model.pct / 100) + model.flat;
}

/** Resolver over already-serialized models (e.g. taken from a close report's
 *  stationFeeModels) — used by surfaces that re-run matching from a stored
 *  aggregate rather than re-resolving config + history. */
export function expectedFeeFromModels(
  models: Record<string, StationFeeModel>,
  fallbackPct: number
): (order: OrderRecord) => number {
  return (order) => {
    const m = models[String(order.locationId ?? "unknown")];
    if (!m) return order.price * order.volumeTotal * (fallbackPct / 100);
    return expectedFeeForOrder(order, m.model);
  };
}

/** Build the expected-fee resolver matchBrokerFees consumes (per-order, station-aware). */
export function expectedFeeResolver(
  resolution: StationFeeResolution,
  uniformPctOverride?: number
): (order: OrderRecord) => number {
  if (uniformPctOverride !== undefined) {
    return (order) => order.price * order.volumeTotal * (uniformPctOverride / 100);
  }
  return (order) => {
    const m = resolution.byStation.get(String(order.locationId ?? "unknown")) ?? resolution.fallbackModel;
    return expectedFeeForOrder(order, m.model);
  };
}
