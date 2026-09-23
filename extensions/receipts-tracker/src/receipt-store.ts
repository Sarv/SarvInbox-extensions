/**
 * Where receipts live, and how rarely they are written.
 *
 * The storage backend rewrites its whole JSON file on every `set`, so a first
 * sync that finds four hundred receipts must not become four hundred whole-
 * file writes. The table is held in memory, mutated per message at no I/O
 * cost, and flushed on the SDK's scheduler, which folds a sync burst into one
 * write. A crash loses at most one interval — and the next sync re-reads the
 * same mail and rebuilds it.
 */

import { DEFAULT_FLUSH_INTERVAL_MS, createFlushScheduler } from '@sarvinbox/extension-sdk';

import type { ReceiptRecord } from './extract';
import type { Cadence } from './billing-cycle';
import type { ReceiptKind } from './receipt-detect';

/** Key under which the whole table is stored. */
export const TABLE_KEY = 'receipts';

/**
 * How many receipts to keep.
 *
 * The file is read in full on every load, so this is a real ceiling rather
 * than a tidiness preference. Two thousand covers several years of ordinary
 * spending; past that the oldest go, because the panel's job is this year's
 * money and next month's renewals.
 */
export const MAX_RECEIPTS = 2_000;

/** How long changes may sit in memory before being written. */
export const FLUSH_INTERVAL_MS = DEFAULT_FLUSH_INTERVAL_MS;

export type ReceiptTable = Record<string, ReceiptRecord>;

const KINDS: readonly ReceiptKind[] = ['purchase', 'subscription', 'refund', 'trial'];
const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalTimestamp(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

/**
 * Rebuild one record from whatever was on disk.
 *
 * The file is plain JSON in the user's data directory: a crash can truncate
 * it and a curious user can edit it. A NaN amount would propagate into every
 * total the panel shows, so fields are checked rather than trusted, and a
 * record that fails is dropped rather than repaired into something plausible.
 */
export function sanitizeRecord(raw: unknown): ReceiptRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const emailId = typeof entry.emailId === 'string' ? entry.emailId : null;
  const merchantKeyValue = typeof entry.merchantKey === 'string' ? entry.merchantKey : null;
  if (!emailId || !merchantKeyValue) return null;

  if (!isFiniteNumber(entry.amountMinor) || entry.amountMinor < 0) return null;
  if (!isFiniteNumber(entry.occurredAt) || entry.occurredAt <= 0) return null;

  const kind = KINDS.includes(entry.kind as ReceiptKind) ? (entry.kind as ReceiptKind) : null;
  if (!kind) return null;

  const cadence = CADENCES.includes(entry.cadence as Cadence) ? (entry.cadence as Cadence) : undefined;

  return {
    emailId,
    ...(typeof entry.accountId === 'string' ? { accountId: entry.accountId } : {}),
    merchantKey: merchantKeyValue,
    merchant: typeof entry.merchant === 'string' && entry.merchant ? entry.merchant : merchantKeyValue,
    kind,
    amountMinor: Math.round(entry.amountMinor),
    currency: typeof entry.currency === 'string' && entry.currency ? entry.currency : 'UNKNOWN',
    occurredAt: entry.occurredAt,
    subject: typeof entry.subject === 'string' ? entry.subject : '',
    confidence: isFiniteNumber(entry.confidence) ? entry.confidence : 0,
    ...(cadence ? { cadence } : {}),
    ...(optionalTimestamp(entry.nextChargeAt) ? { nextChargeAt: entry.nextChargeAt as number } : {}),
    ...(optionalTimestamp(entry.trialEndsAt) ? { trialEndsAt: entry.trialEndsAt as number } : {}),
    ...(typeof entry.orderRef === 'string' ? { orderRef: entry.orderRef } : {}),
  };
}

/** Rebuild a table, dropping anything malformed. */
export function sanitizeTable(raw: unknown): ReceiptTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const table: ReceiptTable = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const record = sanitizeRecord(value);
    if (record) table[record.emailId] = record;
  }
  return table;
}

/** Keep the `maxReceipts` most recent receipts. */
export function pruneTable(table: ReceiptTable, maxReceipts: number): ReceiptTable {
  const entries = Object.entries(table);
  if (entries.length <= maxReceipts) return table;

  entries.sort((left, right) => right[1].occurredAt - left[1].occurredAt);
  return Object.fromEntries(entries.slice(0, maxReceipts));
}

/**
 * Merge a table read from disk into one already holding live records.
 *
 * Loading is asynchronous while processing a message is not, so mail synced
 * during activation is recorded before the stored table arrives. Assigning
 * the stored table over the top would discard those silently. Records are
 * keyed by message id and each is a complete re-derivation of the same
 * message, so the live copy simply wins.
 */
export function mergeTables(stored: ReceiptTable, live: ReceiptTable): ReceiptTable {
  return { ...stored, ...live };
}

export interface ReceiptStoreOptions {
  load: () => Promise<unknown>;
  save: (table: ReceiptTable) => Promise<void>;
  flushIntervalMs?: number;
  maxReceipts?: number;
  onError?: (error: unknown) => void;
}

export interface ReceiptStore {
  /** Resolves once the table on disk has been read. */
  ready: Promise<void>;
  /** Record a receipt, replacing any earlier reading of the same message. */
  put(record: ReceiptRecord): void;
  get(emailId: string): ReceiptRecord | undefined;
  /** Every record, newest first. */
  list(): ReceiptRecord[];
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export function createReceiptStore(options: ReceiptStoreOptions): ReceiptStore {
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxReceipts = options.maxReceipts ?? MAX_RECEIPTS;
  const onError = options.onError ?? ((): void => undefined);

  let table: ReceiptTable = {};

  const ready = (async (): Promise<void> => {
    try {
      table = mergeTables(sanitizeTable(await options.load()), table);
    } catch (error) {
      // An unreadable table is an empty one: the next sync rebuilds it from
      // the same mail. It must never stop the extension activating.
      onError(error);
    }
  })();

  const scheduler = createFlushScheduler({
    intervalMs: flushIntervalMs,
    onError,
    write: async (): Promise<void> => {
      table = pruneTable(table, maxReceipts);
      await options.save(table);
    },
  });

  return {
    ready,

    put(record: ReceiptRecord): void {
      const existing = table[record.emailId];
      // The body-ready pass re-reads the same message with more text, so the
      // second reading is the better one and replaces the first. Writing only
      // when something actually changed keeps an idempotent re-run from
      // dirtying the table and forcing a pointless whole-file write.
      if (existing && sameRecord(existing, record)) return;

      table[record.emailId] = record;
      scheduler.markDirty();
    },

    get(emailId: string): ReceiptRecord | undefined {
      return table[emailId];
    },

    list(): ReceiptRecord[] {
      return Object.values(table).sort((left, right) => right.occurredAt - left.occurredAt);
    },

    flush(): Promise<void> {
      return scheduler.flush();
    },

    dispose(): Promise<void> {
      return scheduler.dispose();
    },
  };
}

/** Whether two readings of the same message say the same thing. */
export function sameRecord(left: ReceiptRecord, right: ReceiptRecord): boolean {
  return (
    left.amountMinor === right.amountMinor &&
    left.currency === right.currency &&
    left.kind === right.kind &&
    left.merchantKey === right.merchantKey &&
    left.nextChargeAt === right.nextChargeAt &&
    left.trialEndsAt === right.trialEndsAt &&
    left.cadence === right.cadence &&
    left.orderRef === right.orderRef
  );
}
