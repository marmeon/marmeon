import { CompiledQuery, type DatabaseConnection } from 'kysely';
import { describe, expect, it } from 'vitest';
import { controlOf, transactionControls } from './mysql-transaction-control.ts';

/** A connection that keeps what it was sent. */
function recording() {
  const sent: CompiledQuery[] = [];
  const connection = { executeQuery: async (query: CompiledQuery) => (sent.push(query), { rows: [] }), streamQuery: async function* () {}, other: () => 'bound' } as unknown as DatabaseConnection;
  return { sent, connection: transactionControls(connection) };
}

describe('transactionControls()', () => {
  it('marks the begin, commit and rollback of the driver, and no other statement', async () => {
    const { sent, connection } = recording();
    for (const text of ['begin', 'commit', 'rollback']) await connection.executeQuery(CompiledQuery.raw(text));
    await connection.executeQuery(CompiledQuery.raw('set transaction isolation level serializable'));
    expect(sent.map((query) => controlOf(query.parameters))).toEqual(['begin', 'commit', 'rollback', undefined]);
    expect(sent.map((query) => query.sql)).toEqual(['begin', 'commit', 'rollback', 'set transaction isolation level serializable']);
  });

  it('fails at once for any other statement, instead of quietly leaving it out of the tracking', async () => {
    const { sent, connection } = recording();
    for (const text of ['select 1', 'start transaction', 'BEGIN', 'rollback to savepoint s', 'commit and chain']) {
      await expect(connection.executeQuery(CompiledQuery.raw(text)), text).rejects.toThrow(`sent ${JSON.stringify(text)}, which Marmeon does not track`);
    }
    // A begin with parameters is not the driver's.
    await expect(connection.executeQuery(CompiledQuery.raw('begin', [1]))).rejects.toThrow('does not track');
    expect(sent).toEqual([]);
  });

  it('cannot be forged: the mark is a symbol of this module, which no parameter list of SQL, a plugin or a caller can carry', () => {
    expect(controlOf(Object.assign([], { [Symbol.for('marmeon.mysql.transaction-control')]: 'commit' }))).toBeUndefined();
    expect(controlOf(Object.assign([], { control: 'commit' }))).toBeUndefined();
    expect(controlOf(undefined)).toBeUndefined();
    expect(controlOf([])).toBeUndefined();
  });

  it('is the connection for everything else', () => {
    expect((recording().connection as unknown as { other(): string }).other()).toBe('bound');
  });
});
