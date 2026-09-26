// Pure filter/sort/limit logic for search_public_contracts (src/tools/industry-esi.ts).
// Not industry-specific — public contracts (courier/item_exchange/auction) are
// a general market concept — so this lives at the top level alongside
// database.ts/utils.ts, not under src/industry/.
//
// ESI's /contracts/public/{region_id}/ returns one flat schema for all three
// contract types (verified live 2026-09-26): type-irrelevant fields just
// zero out (an item_exchange has reward: 0, collateral: 0) rather than being
// absent, so there's no type-conditional parsing needed here — only
// filtering on whichever fields the caller cares about.

export interface PublicContract {
  contract_id: number;
  type: string;
  title: string;
  price: number;
  reward: number;
  collateral: number;
  volume: number;
  days_to_complete: number;
  start_location_id: number;
  end_location_id: number;
  date_issued: string;
  date_expired: string;
  issuer_id: number;
  issuer_corporation_id: number;
  buyout?: number;
}

export interface ContractSearchFilters {
  type?: string;
  startLocationId?: number;
  endLocationId?: number;
  minReward?: number;
  maxReward?: number;
  minVolume?: number;
  maxVolume?: number;
  limit?: number;
}

export interface ContractSearchResult {
  /** Total contracts matching the filters, before limit is applied. */
  matchingCount: number;
  /** matchingCount capped to limit. */
  contracts: PublicContract[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Filter a region's full public-contract list down to what the caller
 * asked for, sorted by reward/price descending (highest-value first — a
 * reasonable default for browsing; courier reward and item_exchange/auction
 * price are mutually exclusive per contract, so summing them for sort
 * purposes is safe), then capped to `limit`.
 */
export function searchContracts(
  contracts: PublicContract[],
  filters: ContractSearchFilters
): ContractSearchResult {
  let matched = contracts;

  if (filters.type) matched = matched.filter((c) => c.type === filters.type);
  if (filters.startLocationId != null) matched = matched.filter((c) => c.start_location_id === filters.startLocationId);
  if (filters.endLocationId != null) matched = matched.filter((c) => c.end_location_id === filters.endLocationId);
  if (filters.minReward != null) matched = matched.filter((c) => c.reward + c.price >= filters.minReward!);
  if (filters.maxReward != null) matched = matched.filter((c) => c.reward + c.price <= filters.maxReward!);
  if (filters.minVolume != null) matched = matched.filter((c) => c.volume >= filters.minVolume!);
  if (filters.maxVolume != null) matched = matched.filter((c) => c.volume <= filters.maxVolume!);

  const matchingCount = matched.length;

  const limit = Math.max(1, Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sorted = [...matched].sort((a, b) => b.reward + b.price - (a.reward + a.price));

  return { matchingCount, contracts: sorted.slice(0, limit) };
}
