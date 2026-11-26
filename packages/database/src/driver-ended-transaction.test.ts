import { TransactionError } from '@marmeon/core';
import { runTransaction, type TransactionFrame } from '@marmeon/core/internal';
import { AbortedTransactionError, isAbortedTransactionError, type CompiledQuery, type DatabaseConnection, type Driver } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATE_FAILURE, MarmeonDriver, releasedOpen } from './driver.ts';

interface Stub {
  readonly marmeon: MarmeonDriver;
  readonly sent: string[];
  readonly released: DatabaseConnection[];
  /** What a statement of this text answers with instead of succeeding. */
  readonly fail: Map<string, unknown>;
  readonly discarded: DatabaseConnection[];
  rollbackFails: boolean;
  commitAborts: boolean;
}

/** An inner driver that sends nothing anywhere: it records what a Postgres driver would have sent, and fails on demand. */
function stub(): Stub {
  const sent: string[] = [];
  const fail = new Map<string, unknown>();
  const released: DatabaseConnection[] = [];
  const discarded: DatabaseConnection[] = [];
  const state = { rollbackFails: false, commitAborts: false };
  const connection: DatabaseConnection = {
    executeQuery: async (query: CompiledQuery) => {
      sent.push(query.sql);
      if (fail.has(query.sql)) throw fail.get(query.sql);
      return { rows: [] };
    },
    streamQuery: async function* () {},
  } as unknown as DatabaseConnection;
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async (each) => void (await each.executeQuery({ sql: 'begin', parameters: [] } as unknown as CompiledQuery)),
    commitTransaction: async () => {
      sent.push('commit');
      if (state.commitAborts) throw new AbortedTransactionError();
    },
    rollbackTransaction: async (each) => {
      sent.push('rollback');
      if (state.rollbackFails) {
        // What the dialect's own driver does when its rollback fails.
        discarded.push(each);
        throw new Error('the connection is gone');
      }
    },
    releaseConnection: async (each) => void released.push(each),
    destroy: async () => {},
  };
  const marmeon = new MarmeonDriver(driver, { name: 'default', driver: 'pgsql', target: 'stub' });
  return {
    marmeon,
    sent,
    released,
    fail,
    discarded,
    get rollbackFails() {
      return state.rollbackFails;
    },
    set rollbackFails(value: boolean) {
      state.rollbackFails = value;
    },
    get commitAborts() {
      return state.commitAborts;
    },
    set commitAborts(value: boolean) {
      state.commitAborts = value;
    },
  };
}

const warnings = () => vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

const server = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'ERROR' });

describe('a commit that Postgres answers with a rollback, at the driver', () => {
  it('rejects with D24 and the aborted error as cause, a rollback after it sends nothing, and the next begin sends begin', async () => {
    const inner = stub();
    inner.commitAborts = true;
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    const error = await inner.marmeon.commitTransaction(connection).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as Error).message).toContain(LATE_FAILURE);
    expect((error as Error).message).toContain('D24');
    expect(isAbortedTransactionError((error as Error).cause)).toBe(true);
    // The error that escapes is never the one that makes Kysely skip its rollback.
    expect(isAbortedTransactionError(error)).toBe(false);
    await inner.marmeon.rollbackTransaction(connection);
    expect(inner.sent).toEqual(['begin', 'commit']);
    inner.commitAborts = false;
    await inner.marmeon.beginTransaction(connection, {});
    expect(inner.sent).toEqual(['begin', 'commit', 'begin']);
    await inner.marmeon.commitTransaction(connection);
    await inner.marmeon.releaseConnection(connection);
    expect(inner.sent).toEqual(['begin', 'commit', 'begin', 'commit']);
  });

  it('a rollback that is not owed is not remembered: the next transaction on the connection rolls back for real', async () => {
    const inner = stub();
    inner.commitAborts = true;
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.commitTransaction(connection).catch(() => undefined);
    // Nobody rolled back; the connection goes back to the pool and is handed out again.
    await inner.marmeon.releaseConnection(connection);
    const again = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(again, {});
    await inner.marmeon.rollbackTransaction(again);
    expect(inner.sent).toEqual(['begin', 'commit', 'begin', 'rollback']);
  });
});

describe('the note that a transaction ended by a rollback answer is not owed a rollback', () => {
  it('goes at the release: a rollback with no begin after it is refused again, not answered silently', async () => {
    const inner = stub();
    inner.commitAborts = true;
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.commitTransaction(connection).catch(() => undefined);
    await inner.marmeon.releaseConnection(connection);
    await expect(inner.marmeon.rollbackTransaction(connection)).rejects.toThrow('No transaction is open');
  });

  it('goes at the next begin too: a transaction begun on the connection without a release in between rolls back for real', async () => {
    const inner = stub();
    inner.commitAborts = true;
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.commitTransaction(connection).catch(() => undefined);
    inner.commitAborts = false;
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.rollbackTransaction(connection);
    expect(inner.sent).toEqual(['begin', 'commit', 'begin', 'rollback']);
  });
});

describe('a connection released with a transaction still recorded', () => {
  it('is rolled back before it goes back to the pool, and says so in a warning with the name and the code only', async () => {
    const warn = warnings();
    const inner = stub();
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    // Whoever thought it committed did not: the release says so with D24, after the rollback and the release itself.
    const refused = await inner.marmeon.releaseConnection(connection).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refused).toBeInstanceOf(TransactionError);
    expect((refused as Error).message).toContain(releasedOpen('default'));
    expect(inner.sent).toEqual(['begin', 'rollback']);
    expect(inner.released).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith('A transaction on "default" was still open when its connection was released; Marmeon rolled it back', {
      type: 'MarmeonDatabaseWarning',
      code: 'MARMEON_TRANSACTION_LEFT_OPEN',
    });
    const again = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(again, {});
    expect(inner.sent).toEqual(['begin', 'rollback', 'begin']);
  });

  it('is released anyway when the rollback fails, after the dialect discarded it, and its depth is gone (the release still refuses with D24)', async () => {
    const warn = warnings();
    const inner = stub();
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    inner.rollbackFails = true;
    await expect(inner.marmeon.releaseConnection(connection)).rejects.toBeInstanceOf(TransactionError);
    expect(inner.discarded).toHaveLength(1);
    expect(inner.released).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'A transaction on "default" was still open when its connection was released; Marmeon rolled it back — the rollback failed; the driver discards or resets the connection',
      { type: 'MarmeonDatabaseWarning', code: 'MARMEON_TRANSACTION_LEFT_OPEN' },
    );
    inner.rollbackFails = false;
    await inner.marmeon.beginTransaction(connection, {});
    expect(inner.sent.at(-1)).toBe('begin');
  });

  it('a connection without a transaction sends nothing at its release and warns of nothing', async () => {
    const warn = warnings();
    const inner = stub();
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.releaseConnection(connection);
    expect(inner.sent).toEqual([]);
    expect(inner.released).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a transaction that ended through commit and rollback releases without a warning', async () => {
    const warn = warnings();
    const inner = stub();
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.commitTransaction(connection);
    await inner.marmeon.releaseConnection(connection);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the release of a savepoint that fails', () => {
  const nested = async (inner: Stub) => {
    const connection = await inner.marmeon.acquireConnection();
    await inner.marmeon.beginTransaction(connection, {});
    await inner.marmeon.beginTransaction(connection, {});
    return connection;
  };

  it('with the answer for an aborted transaction (25P02) throws D24 with that answer as cause', async () => {
    const inner = stub();
    const connection = await nested(inner);
    const answer = server('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    inner.fail.set('release savepoint marmeon_savepoint_1', answer);
    const error = await inner.marmeon.commitTransaction(connection).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as Error).message).toContain(LATE_FAILURE);
    expect((error as Error).cause).toBe(answer);
  });

  it('with any other error comes through as it is', async () => {
    const inner = stub();
    const connection = await nested(inner);
    const answer = server('58000', 'system error');
    inner.fail.set('release savepoint marmeon_savepoint_1', answer);
    await expect(inner.marmeon.commitTransaction(connection)).rejects.toBe(answer);
  });
});

describe('closed(): the outermost transaction while a holder keeps the connection', () => {
  /** Two frames on one connection object, as on SQLite: frame B began first, frame A holds the connection now. */
  async function twoFrames(inner: Stub, then: (frames: { a: TransactionFrame; b: TransactionFrame }) => Promise<void>) {
    const { marmeon } = inner;
    const gate = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let frameB!: TransactionFrame;
    const b = runTransaction(marmeon, 'default', async (frame) => {
      frameB = frame;
      await marmeon.acquireConnection();
      ready.resolve();
      await gate.promise;
      return 'b';
    });
    await ready.promise;
    try {
      await runTransaction(marmeon, 'default', async (frame) => {
        const connection = await marmeon.acquireConnection();
        await marmeon.beginTransaction(connection, {});
        await then({ a: frame, b: frameB });
        return 'a';
      });
    } finally {
      gate.resolve();
      await b;
    }
  }

  it('does not roll back for a frame whose holders are not the connection\'s, and does for the frame that owns them', async () => {
    const inner = stub();
    await twoFrames(inner, async ({ a, b }) => {
      await expect(inner.marmeon.closed(b, true)).resolves.toBeUndefined();
      expect(inner.sent).toEqual(['begin']);
      await expect(inner.marmeon.closed(a, true)).rejects.toBeInstanceOf(TransactionError);
      expect(inner.sent).toEqual(['begin', 'rollback']);
    });
  });

  it('tells a failed rollback in a warning and still throws D24 (or leaves the caller\'s error alone)', async () => {
    const warn = warnings();
    const inner = stub();
    inner.rollbackFails = true;
    await twoFrames(inner, async ({ a }) => {
      await expect(inner.marmeon.closed(a, true)).rejects.toThrow('D24');
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'A transaction on "default" was still open when its connection was released; Marmeon rolled it back — the rollback failed; the driver discards or resets the connection',
      { type: 'MarmeonDatabaseWarning', code: 'MARMEON_TRANSACTION_LEFT_OPEN' },
    );
    const second = stub();
    second.rollbackFails = true;
    await twoFrames(second, async ({ a }) => {
      await expect(second.marmeon.closed(a, false)).resolves.toBeUndefined();
    });
  });
});
