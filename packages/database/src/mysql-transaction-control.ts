import type { CompiledQuery, DatabaseConnection } from 'kysely';

/** What a statement of the driver's own transaction is, as the guarded pool of MySQL reads it. */
export type Control = 'begin' | 'commit' | 'rollback';

/** The mark on the parameters of such a statement. Private to this module: SQL, a plugin or a caller cannot write it, only {@link transactionControls} does. */
const CONTROL = Symbol('marmeon.mysql.transaction-control');
const CONTROLS: ReadonlySet<string> = new Set<Control>(['begin', 'commit', 'rollback']);

/** The control a query was marked with, from the parameters it was sent with. */
export function controlOf(parameters: unknown): Control | undefined {
  return (parameters as { [CONTROL]?: Control } | undefined)?.[CONTROL];
}

/**
 * The connection with the statements `begin`, `commit` and `rollback` that Kysely's driver sends marked as the driver's own: the lease of the guarded
 * pool opens and closes its record of the transaction by them, never by what the app's SQL says. Used for the calls of the driver only. Anything
 * else sent through it, but `set transaction …` (the isolation level and access mode, which Kysely sends first), throws: if Kysely ever sends another
 * statement, the tracking would be off, and that must show at once.
 */
export function transactionControls(connection: DatabaseConnection): DatabaseConnection {
  const marked = (query: CompiledQuery): CompiledQuery => {
    if (query.query.kind === 'RawNode' && query.parameters.length === 0) {
      if (CONTROLS.has(query.sql)) return { ...query, parameters: Object.assign([], { [CONTROL]: query.sql as Control }) };
      if (query.sql.startsWith('set transaction ')) return query;
    }
    throw new Error(`The transaction of a MySQL connection sent ${JSON.stringify(query.sql)}, which Marmeon does not track: it expects begin, commit, rollback and set transaction.`);
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'executeQuery') return async (query: CompiledQuery) => target.executeQuery(marked(query));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
