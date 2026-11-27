import type { Application } from '@marmeon/core';
import { printable } from '@marmeon/core/internal';

/** Tables and columns a framework package makes with raw SQL, by name; on SQLite a declared FTS5 table covers its shadow tables. */
export interface DerivedSchemaEntry {
  /** The connection the package makes them on; `default` when left out. Only there does `migrate` leave them out. */
  readonly connection?: string;
  readonly tables?: readonly string[];
  /** Table → the columns of that table the package adds. */
  readonly columns?: Readonly<Record<string, readonly string[]>>;
}

/** Every declaration of an app for one connection, merged. */
export interface DerivedSchema {
  readonly tables: ReadonlySet<string>;
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const declared = new WeakMap<Application, Map<string, { connection: string; tables: string[]; columns: [string, string[]][] }>>();

function identifier(owner: string, what: string, name: unknown): string {
  if (typeof name === 'string' && IDENTIFIER.test(name)) return name;
  const shown = typeof name === 'string' ? `"${printable(name)}"` : `of type ${typeof name}`;
  throw new TypeError(`declareDerivedSchema: ${printable(owner)} declares a ${what} ${shown}, which is not a plain identifier (a letter or _, then letters, digits and _, at most 63 in all).`);
}

/** The names of `list`, each a plain identifier; refuses anything but an array. */
function identifiers(owner: string, what: string, list: unknown): string[] {
  if (!Array.isArray(list)) throw new TypeError(`declareDerivedSchema: ${printable(owner)} declares its ${what}s as ${typeof list}, not as an array of names.`);
  return list.map((name) => identifier(owner, what, name));
}

/**
 * For framework packages: marks the tables and columns `owner` makes with raw SQL, so that `migrate` does not name them as unknown;
 * on SQLite that covers the FTS5 shadow tables of a declared virtual table too. The entry counts on its `connection` only (`default`
 * when left out). It changes nothing else — `db:query` and the database MCP still treat them as undescribed and withhold them. A
 * second call of the same `owner` replaces its entry. Throws a `TypeError` for an unknown key, a connection that is no name, or a name
 * that is not a plain identifier, and then declares nothing. See docs/migrations.md#what-migrate-checks-after-each-migration.
 */
export function declareDerivedSchema(app: Application, owner: string, entry: DerivedSchemaEntry): void {
  const unknown = Object.keys(entry).find((key) => key !== 'connection' && key !== 'tables' && key !== 'columns');
  if (unknown !== undefined) throw new TypeError(`declareDerivedSchema: ${printable(owner)} declares "${printable(unknown)}", which is none of connection, tables and columns.`);
  const connection = entry.connection ?? 'default';
  if (typeof connection !== 'string' || connection === '') throw new TypeError(`declareDerivedSchema: ${printable(owner)} names its connection as ${typeof connection === 'string' ? 'an empty string' : typeof connection}, not by name.`);
  const tables = identifiers(owner, 'table', entry.tables ?? []);
  const columns = Object.entries(entry.columns ?? {}).map(([table, names]): [string, string[]] => [identifier(owner, 'table', table), identifiers(owner, 'column', names)]);
  const entries = declared.get(app) ?? new Map();
  entries.set(owner, { connection, tables, columns });
  declared.set(app, entries);
}

/** What every owner declared for `app` on `connection` with {@link declareDerivedSchema}, merged. */
export function derivedSchemaOf(app: Application, connection: string): DerivedSchema {
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  for (const entry of declared.get(app)?.values() ?? []) {
    if (entry.connection !== connection) continue;
    for (const table of entry.tables) tables.add(table);
    for (const [table, names] of entry.columns) {
      const known = columns.get(table) ?? new Set();
      for (const name of names) known.add(name);
      columns.set(table, known);
    }
  }
  return { tables, columns };
}
