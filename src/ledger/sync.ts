import { esiGet, esiGetAll, getActiveCharacter } from "../auth/esi-client.js";
import { getLedgerDb } from "./db.js";

interface EsiWalletJournalEntry {
  id: number;
  date: string;
  ref_type: string;
  amount?: number;
  balance?: number;
  description: string;
  first_party_id?: number;
  second_party_id?: number;
  reason?: string;
  context_id?: number;
  context_id_type?: string;
}

interface EsiTransaction {
  transaction_id: number;
  date: string;
  type_id: number;
  quantity: number;
  unit_price: number;
  client_id: number;
  location_id: number;
  is_buy: boolean;
  is_personal: boolean;
  journal_ref_id: number;
}

interface EsiOpenOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  region_id?: number;
  volume_total: number;
  volume_remain: number;
  price: number;
  is_buy_order: boolean;
  issued: string;
  duration: number;
  escrow?: number;
}

interface EsiHistoricalOrder extends EsiOpenOrder {
  state: "cancelled" | "expired" | "fulfilled";
}

// ESI's wallet history is bounded to ~30 days regardless of how far back we
// walk, so this is a safety valve against a runaway loop, not the real limit.
const MAX_TRANSACTION_PAGES = 20;

/**
 * Walk /wallet/transactions/ backward via from_id until a page yields no
 * transactions we don't already have. Fixes the previous single-page-only
 * fetch (see get_wallet_transactions in market.ts) — that endpoint uses
 * from_id cursor pagination, not the page= param esiGetAll expects.
 */
async function fetchAllTransactions(characterId: number): Promise<EsiTransaction[]> {
  const seen = new Map<number, EsiTransaction>();
  let fromId: number | undefined;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
    const esiPath = `/characters/${characterId}/wallet/transactions/${fromId ? `?from_id=${fromId}` : ""}`;
    const batch = await esiGet<EsiTransaction[]>(esiPath, { characterId });
    if (batch.length === 0) break;

    let newCount = 0;
    let oldestId = fromId;
    for (const tx of batch) {
      if (!seen.has(tx.transaction_id)) {
        seen.set(tx.transaction_id, tx);
        newCount++;
      }
      if (oldestId === undefined || tx.transaction_id < oldestId) oldestId = tx.transaction_id;
    }

    if (newCount === 0) break;
    if (oldestId === fromId) break;
    fromId = oldestId;
  }

  return [...seen.values()];
}

export interface SyncResult {
  characterId: number;
  characterName: string;
  journalInserted: number;
  transactionsInserted: number;
  journalSeen: number;
  transactionsSeen: number;
  ordersUpserted: number;
}

/**
 * Pull everything ESI currently has for journal + transactions + orders and
 * upsert into the local ledger. Safe to call repeatedly — already-seen rows
 * are no-ops (journal/transactions) or cheap overwrites (orders, since an
 * open order's volume_remain and eventual state change over time). This is
 * the only way to retain history past ESI's rolling windows (~30 days for
 * wallet data, ~90 for order history) — anything not synced before it ages
 * out is gone for good.
 */
export async function syncWalletLedger(characterId?: number): Promise<SyncResult> {
  const char = await getActiveCharacter(characterId);

  const [journal, transactions, openOrders, orderHistory] = await Promise.all([
    esiGetAll<EsiWalletJournalEntry>(`/characters/${char.characterId}/wallet/journal/`, {
      characterId: char.characterId,
    }),
    fetchAllTransactions(char.characterId),
    esiGetAll<EsiOpenOrder>(`/characters/${char.characterId}/orders/`, { characterId: char.characterId }),
    esiGetAll<EsiHistoricalOrder>(`/characters/${char.characterId}/orders/history/`, {
      characterId: char.characterId,
    }),
  ]);

  const db = getLedgerDb();

  const insertJournal = db.prepare(`
    INSERT OR IGNORE INTO wallet_journal
      (id, character_id, date, ref_type, amount, balance, description, context_id, context_id_type, first_party_id, second_party_id, reason)
    VALUES (@id, @characterId, @date, @refType, @amount, @balance, @description, @contextId, @contextIdType, @firstPartyId, @secondPartyId, @reason)
  `);
  const insertTransaction = db.prepare(`
    INSERT OR IGNORE INTO wallet_transactions
      (transaction_id, character_id, date, type_id, quantity, unit_price, is_buy, location_id, client_id, journal_ref_id)
    VALUES (@transactionId, @characterId, @date, @typeId, @quantity, @unitPrice, @isBuy, @locationId, @clientId, @journalRefId)
  `);
  const upsertOrder = db.prepare(`
    INSERT INTO orders
      (order_id, character_id, type_id, is_buy_order, price, volume_total, volume_remain, location_id, region_id, issued, duration, state, escrow, synced_at)
    VALUES
      (@orderId, @characterId, @typeId, @isBuyOrder, @price, @volumeTotal, @volumeRemain, @locationId, @regionId, @issued, @duration, @state, @escrow, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      volume_remain = excluded.volume_remain,
      state = excluded.state,
      escrow = excluded.escrow,
      synced_at = datetime('now')
  `);
  const upsertSyncState = db.prepare(`
    INSERT INTO sync_state (character_id, last_synced_at, journal_entries, transactions)
    VALUES (@characterId, datetime('now'), @journalEntries, @transactions)
    ON CONFLICT(character_id) DO UPDATE SET
      last_synced_at = datetime('now'),
      journal_entries = journal_entries + @journalEntries,
      transactions = transactions + @transactions
  `);

  let journalInserted = 0;
  let transactionsInserted = 0;
  let ordersUpserted = 0;

  db.transaction(() => {
    for (const entry of journal) {
      const res = insertJournal.run({
        id: entry.id,
        characterId: char.characterId,
        date: entry.date,
        refType: entry.ref_type,
        amount: entry.amount ?? null,
        balance: entry.balance ?? null,
        description: entry.description ?? null,
        contextId: entry.context_id ?? null,
        contextIdType: entry.context_id_type ?? null,
        firstPartyId: entry.first_party_id ?? null,
        secondPartyId: entry.second_party_id ?? null,
        reason: entry.reason ?? null,
      });
      journalInserted += res.changes;
    }
    for (const tx of transactions) {
      const res = insertTransaction.run({
        transactionId: tx.transaction_id,
        characterId: char.characterId,
        date: tx.date,
        typeId: tx.type_id,
        quantity: tx.quantity,
        unitPrice: tx.unit_price,
        isBuy: tx.is_buy ? 1 : 0,
        locationId: tx.location_id ?? null,
        clientId: tx.client_id ?? null,
        journalRefId: tx.journal_ref_id ?? null,
      });
      transactionsInserted += res.changes;
    }
    for (const o of openOrders) {
      upsertOrder.run({
        orderId: o.order_id,
        characterId: char.characterId,
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order ? 1 : 0,
        price: o.price,
        volumeTotal: o.volume_total,
        volumeRemain: o.volume_remain,
        locationId: o.location_id ?? null,
        regionId: o.region_id ?? null,
        issued: o.issued,
        duration: o.duration ?? null,
        state: "open",
        escrow: o.escrow ?? null,
      });
      ordersUpserted++;
    }
    for (const o of orderHistory) {
      upsertOrder.run({
        orderId: o.order_id,
        characterId: char.characterId,
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order ? 1 : 0,
        price: o.price,
        volumeTotal: o.volume_total,
        volumeRemain: o.volume_remain,
        locationId: o.location_id ?? null,
        regionId: o.region_id ?? null,
        issued: o.issued,
        duration: o.duration ?? null,
        state: o.state,
        escrow: o.escrow ?? null,
      });
      ordersUpserted++;
    }
    upsertSyncState.run({
      characterId: char.characterId,
      journalEntries: journalInserted,
      transactions: transactionsInserted,
    });
  })();

  return {
    characterId: char.characterId,
    characterName: char.characterName,
    journalInserted,
    transactionsInserted,
    journalSeen: journal.length,
    transactionsSeen: transactions.length,
    ordersUpserted,
  };
}
