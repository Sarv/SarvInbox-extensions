import { describe, expect, it, vi } from 'vitest';

import type { ReceiptRecord } from '../../src/extract';
import {
  type ReceiptTable,
  createReceiptStore,
  mergeTables,
  pruneTable,
  sameRecord,
  sanitizeRecord,
  sanitizeTable,
} from '../../src/receipt-store';
import { OCCURRED_MS, makeRecord } from '../helpers/record';

/** A store whose writes land in an array, and which never waits on a timer. */
function makeStore(stored: unknown = {}, options: { maxReceipts?: number } = {}) {
  const writes: ReceiptTable[] = [];
  const errors: unknown[] = [];

  const store = createReceiptStore({
    load: async () => stored,
    save: async (table) => {
      writes.push(structuredClone(table));
    },
    flushIntervalMs: 0,
    onError: (error) => errors.push(error),
    ...(options.maxReceipts === undefined ? {} : { maxReceipts: options.maxReceipts }),
  });

  return { store, writes, errors };
}

describe('sanitizeRecord', () => {
  it('rebuilds a well-formed record', () => {
    const record = makeRecord({ cadence: 'monthly', nextChargeAt: OCCURRED_MS + 1000 });
    expect(sanitizeRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  // The table is plain JSON in the user's data directory. A NaN amount read
  // back would propagate into every total the panel shows.
  it('drops a record whose amount is not a number', () => {
    expect(sanitizeRecord({ ...makeRecord(), amountMinor: 'lots' })).toBeNull();
    expect(sanitizeRecord({ ...makeRecord(), amountMinor: Number.NaN })).toBeNull();
    expect(sanitizeRecord({ ...makeRecord(), amountMinor: -5 })).toBeNull();
  });

  it('drops a record with no identity', () => {
    expect(sanitizeRecord({ ...makeRecord(), emailId: undefined })).toBeNull();
    expect(sanitizeRecord({ ...makeRecord(), merchantKey: 42 })).toBeNull();
  });

  // A timestamp of zero would put the receipt in 1970, outside every month
  // window, where it counts towards nothing and can never be found.
  it('drops a record with no usable timestamp', () => {
    expect(sanitizeRecord({ ...makeRecord(), occurredAt: 0 })).toBeNull();
  });

  it('drops a record whose kind is not one of ours', () => {
    expect(sanitizeRecord({ ...makeRecord(), kind: 'chargeback' })).toBeNull();
  });

  // An unrecognised cadence must not reach `cadenceInMonths`, which would
  // divide by undefined and make the monthly equivalent NaN.
  it('forgets a cadence it does not know', () => {
    expect(sanitizeRecord({ ...makeRecord(), cadence: 'fortnightly' })).not.toHaveProperty(
      'cadence'
    );
  });

  it('refuses anything that is not an object', () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord('receipt')).toBeNull();
    expect(sanitizeRecord([makeRecord()])).toBeNull();
  });

  it('falls back to the key when the display name is missing', () => {
    expect(sanitizeRecord({ ...makeRecord(), merchant: '' })?.merchant).toBe('acme.com');
  });
});

describe('sanitizeTable', () => {
  it('keeps the good rows and drops the bad ones', () => {
    const table = sanitizeTable({
      a: makeRecord({ emailId: 'a' }),
      b: { emailId: 'b', merchantKey: 'x' },
      c: makeRecord({ emailId: 'c' }),
    });

    expect(Object.keys(table).sort()).toEqual(['a', 'c']);
  });

  // A truncated file parses to something that is not an object; the panel
  // must open empty rather than not at all.
  it('reads a ruined file as an empty table', () => {
    expect(sanitizeTable('{"a":')).toEqual({});
    expect(sanitizeTable(undefined)).toEqual({});
  });

  // Re-keying by the record's own id means a hand-edited file with a
  // mismatched key still looks up correctly.
  it('keys rows by the id inside them', () => {
    expect(Object.keys(sanitizeTable({ wrong: makeRecord({ emailId: 'right' }) }))).toEqual([
      'right',
    ]);
  });
});

describe('pruneTable', () => {
  it('keeps the newest and drops the oldest', () => {
    const table: ReceiptTable = {};
    for (let index = 0; index < 5; index += 1) {
      table[`e${index}`] = makeRecord({ emailId: `e${index}`, occurredAt: OCCURRED_MS + index });
    }

    expect(Object.keys(pruneTable(table, 2)).sort()).toEqual(['e3', 'e4']);
  });

  it('leaves a table under the cap alone', () => {
    const table = { a: makeRecord({ emailId: 'a' }) };
    expect(pruneTable(table, 10)).toBe(table);
  });
});

describe('mergeTables', () => {
  // Mail synced during activation is recorded before the stored table has
  // finished loading. Assigning the stored copy over the top would discard
  // those receipts silently.
  it('lets the live record win over the stored one', () => {
    const stored = { a: makeRecord({ emailId: 'a', amountMinor: 100 }) };
    const live = { a: makeRecord({ emailId: 'a', amountMinor: 200 }) };

    expect(mergeTables(stored, live).a?.amountMinor).toBe(200);
  });

  it('keeps rows that exist on only one side', () => {
    const merged = mergeTables(
      { a: makeRecord({ emailId: 'a' }) },
      { b: makeRecord({ emailId: 'b' }) }
    );
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });
});

describe('sameRecord', () => {
  it('ignores fields that cannot change between two readings', () => {
    const left = makeRecord({ subject: 'Receipt', confidence: 0.7 });
    const right = makeRecord({ subject: 'Receipt (copy)', confidence: 0.9 });
    expect(sameRecord(left, right)).toBe(true);
  });

  it('notices a changed amount', () => {
    expect(sameRecord(makeRecord(), makeRecord({ amountMinor: 1 }))).toBe(false);
  });

  it('notices a renewal date that moved', () => {
    expect(sameRecord(makeRecord(), makeRecord({ nextChargeAt: OCCURRED_MS }))).toBe(false);
  });
});

describe('createReceiptStore', () => {
  it('reads what was on disk', async () => {
    const { store } = makeStore({ a: makeRecord({ emailId: 'a' }) });
    await store.ready;
    expect(store.get('a')?.merchant).toBe('Acme');
  });

  // An unreadable table must never stop the extension activating: the next
  // sync rebuilds it from the same mail.
  it('activates with an empty table when loading throws', async () => {
    const errors: unknown[] = [];
    const store = createReceiptStore({
      load: async () => {
        throw new Error('disk on fire');
      },
      save: async () => undefined,
      onError: (error) => errors.push(error),
    });

    await expect(store.ready).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('lists newest first', async () => {
    const { store } = makeStore();
    await store.ready;
    store.put(makeRecord({ emailId: 'old', occurredAt: OCCURRED_MS - 1000 }));
    store.put(makeRecord({ emailId: 'new', occurredAt: OCCURRED_MS + 1000 }));

    expect(store.list().map((record) => record.emailId)).toEqual(['new', 'old']);
  });

  // The workflow runs twice per message — arrival, then body-ready — so the
  // second reading must replace the first rather than add to it.
  it('replaces an earlier reading of the same message', async () => {
    const { store } = makeStore();
    await store.ready;
    store.put(makeRecord({ amountMinor: 100 }));
    store.put(makeRecord({ amountMinor: 999 }));

    expect(store.list()).toHaveLength(1);
    expect(store.get('email-1')?.amountMinor).toBe(999);
  });

  // An idempotent re-run must not dirty the table: the backend rewrites the
  // whole file on every save, so a needless flush is a needless whole-file
  // write on every sync.
  it('does not schedule a write when nothing changed', async () => {
    const { store, writes } = makeStore();
    await store.ready;
    store.put(makeRecord());
    await store.flush();
    expect(writes).toHaveLength(1);

    store.put(makeRecord({ subject: 'same receipt, fuller body' }));
    await store.flush();
    expect(writes).toHaveLength(1);
  });

  // A sync burst of four hundred receipts must become one write, not four
  // hundred whole-file rewrites.
  it('folds many puts into one write', async () => {
    const { store, writes } = makeStore();
    await store.ready;
    for (let index = 0; index < 50; index += 1) {
      store.put(makeRecord({ emailId: `e${index}` }));
    }
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0] as ReceiptTable)).toHaveLength(50);
  });

  it('prunes to the cap as it writes', async () => {
    const { store, writes } = makeStore({}, { maxReceipts: 3 });
    await store.ready;
    for (let index = 0; index < 6; index += 1) {
      store.put(makeRecord({ emailId: `e${index}`, occurredAt: OCCURRED_MS + index }));
    }
    await store.flush();

    expect(Object.keys(writes[0] as ReceiptTable).sort()).toEqual(['e3', 'e4', 'e5']);
  });

  // Whatever has been recorded must reach disk when the app closes.
  it('writes pending changes on dispose', async () => {
    const { store, writes } = makeStore();
    await store.ready;
    store.put(makeRecord());
    await store.dispose();

    expect(writes).toHaveLength(1);
  });

  it('reports a failed write instead of throwing', async () => {
    const errors: unknown[] = [];
    const store = createReceiptStore({
      load: async () => ({}),
      save: async () => {
        throw new Error('no space left');
      },
      flushIntervalMs: 0,
      onError: (error) => errors.push(error),
    });

    await store.ready;
    store.put(makeRecord());
    await expect(store.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  // Receipts recorded while the stored table was still loading must survive
  // it arriving.
  it('keeps receipts recorded before the load finished', async () => {
    let release: (value: ReceiptTable) => void = () => undefined;
    const store = createReceiptStore({
      load: () =>
        new Promise<ReceiptTable>((resolve) => {
          release = resolve;
        }),
      save: async () => undefined,
      flushIntervalMs: 0,
    });

    store.put(makeRecord({ emailId: 'during-load' }));
    release({ stored: makeRecord({ emailId: 'stored' }) } as ReceiptTable);
    await store.ready;

    expect(store.list().map((record: ReceiptRecord) => record.emailId).sort()).toEqual([
      'during-load',
      'stored',
    ]);
  });
});

describe('the flush timer', () => {
  // The whole point of the scheduler is that a put costs no I/O until the
  // interval elapses; a write on every put would be the bug it exists for.
  it('writes on its own once the interval passes', async () => {
    vi.useFakeTimers();
    try {
      const writes: ReceiptTable[] = [];
      const store = createReceiptStore({
        load: async () => ({}),
        save: async (table) => {
          writes.push(table);
        },
        flushIntervalMs: 1000,
      });
      await store.ready;

      store.put(makeRecord());
      expect(writes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
