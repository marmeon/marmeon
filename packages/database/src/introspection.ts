import type { Driver } from './schema/blueprint.ts';

// What the schema says about relations — read from the database's catalog or taken from the projection of the migrations, and turned
// into relations by ONE function: the connection at runtime and `db:types` must agree on every name.

/** A single-column foreign key: `table.column` references `references.referenced`. */
export interface ForeignKey {
  readonly table: string;
  readonly column: string;
  readonly references: string;
  readonly referenced: string;
  /** Whether the column may be NULL. */
  readonly nullable: boolean;
}

/**
 * One mark of the migrations: a table's `timestamps()`/`softDeletes()` (column `''`), or a foreign key's `.inverse()`.
 * See `docs/migrations.md#timestamps-and-soft-deletes`.
 */
export interface SchemaMarker {
  readonly table: string;
  /** The foreign key column of an `inverse` marker; `''` for a table's marker. */
  readonly column: string;
  readonly marker: 'inverse' | 'soft_deletes' | 'timestamps';
  /** The relation name of an `inverse` marker; `null` otherwise. */
  readonly value: string | null;
}

export interface SchemaFacts {
  /** Ordered by table, then column. */
  readonly foreignKeys: readonly ForeignKey[];
  /** Table → its unique column sets: unique indexes and the primary key. */
  readonly uniques: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** Table → its columns, in their order. */
  readonly columns: ReadonlyMap<string, readonly string[]>;
  readonly markers: readonly SchemaMarker[];
}

/** A relation of a table, derived from a foreign key. */
export interface Relation {
  readonly kind: 'belongsTo' | 'hasMany' | 'hasOne' | 'belongsToMany';
  /** The related table. */
  readonly table: string;
  /** The foreign key column: on this table (belongsTo), on the related one (hasMany, hasOne), on the pivot towards this one (belongsToMany). */
  readonly foreignKey: string;
  /** The column of this table the relation matches on. */
  readonly localKey: string;
  /** The column of the related table it matches. */
  readonly targetKey: string;
  /** One-relations: whether no row may come back — the foreign key may be NULL, or the related row may be soft-deleted. */
  readonly nullable?: boolean;
  /** belongsToMany: the pivot table, and its foreign key towards the related table. */
  readonly pivot?: string;
  readonly relatedKey?: string;
}

export interface DerivedRelations {
  /** Table → relation name → relation; both ordered by code point. */
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
  /** What could not be derived, as messages for the developer (`db:types` stops on them). */
  readonly problems: readonly string[];
}

/** Runs one catalog query on the connection at hand (never through a pool a transaction may hold). */
export type CatalogQuery = <R>(sql: string) => Promise<R[]>;

/** Facts plus every column's declared (SQLite) or reported (Postgres) type. */
export interface Introspected extends SchemaFacts {
  /** Table → the columns of its primary key, in key order; a table without one is missing. */
  readonly primaryKeys: ReadonlyMap<string, readonly string[]>;
  readonly types: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The columns the migrations marked `.secret()`: the projection knows them, a catalog does not. */
  readonly secretColumns: readonly { readonly table: string; readonly column: string }[];
}

/** By code point — the same order on every machine (`localeCompare` follows the locale). */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reads the columns of tables (views are left out on both drivers), single-column foreign keys and unique column sets from the
 * catalog. It knows no markers and no secret columns: only the migrations say those. SQLite lists foreign keys in
 * reverse order and keeps an INTEGER PRIMARY KEY in `pragma_table_info` only; Postgres keeps the blueprint's unique indexes
 * in `pg_index` only (not in `pg_constraint`) — so both are read where they are, and everything is sorted.
 */
export async function introspect(run: CatalogQuery, driver: Driver): Promise<Introspected> {
  const { types, nullable } = await tableColumns(run, driver);
  const columns = new Map([...types].map(([table, map]) => [table, [...map.keys()]]));
  const uniques = await uniqueSets(run, driver);
  const foreignKeys = (await foreignKeyRows(run, driver))
    .map(({ table, column, references, referenced }) => ({
      table,
      column,
      references,
      referenced,
      nullable: nullable.has(`${table}\0${column}`),
    }))
    .sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column));
  return { foreignKeys, uniques, columns, markers: [], types, secretColumns: [], primaryKeys: await primaryKeyColumns(run, driver) };
}

/** Every table's columns with their types, in order, and the nullable ones (`table\0column`). Views are left out on both drivers. */
export async function tableColumns(run: CatalogQuery, driver: Driver): Promise<{ types: Map<string, Map<string, string>>; nullable: Set<string>; extension: Set<string> }> {
  const columnRows =
    driver === 'sqlite'
      ? await run<ColumnRow>(`select m.name as table_name, p.name as column_name, lower(p.type) as type, (p."notnull" = 0 and p.pk = 0) as nullable
          from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table' order by m.name, p.cid`)
      : // Every schema of the search path, not only the first that exists: with `"$user", public` and an empty schema named like the role,
        // `current_schema()` is that empty one while `public.users` is what an unqualified name finds. `to_regclass` picks the relation an unqualified name finds, so a table in an earlier schema hides the same name in a later one — also for an extension's.
        // pg_catalog, not information_schema: that shows a role only the tables it has privileges on, and a table it cannot see is a table
        // the check after a migration would take for missing. Here a table without privileges is seen, and the query on it is refused.
        await run<ColumnRow>(`select c.relname::text as table_name, a.attname::text as column_name,
          case when t.typname = 'numeric' then 'numeric(' || (case when a.atttypmod = -1 then 0 else ((a.atttypmod - 4) >> 16) & 65535 end) || ', ' || (case when a.atttypmod = -1 then 0 else (a.atttypmod - 4) & 65535 end) || ')' else t.typname::text end as type,
          not a.attnotnull as nullable,
          exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') as extension
          from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            join pg_catalog.pg_attribute a on a.attrelid = c.oid
            join pg_catalog.pg_type t on t.oid = a.atttypid
          where n.nspname = any(current_schemas(false)) and c.oid = pg_catalog.to_regclass(quote_ident(c.relname))
            and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
          order by c.relname, a.attnum`);
  const types = new Map<string, Map<string, string>>();
  const nullable = new Set<string>();
  const extension = new Set<string>();
  for (const row of columnRows) {
    if (row.extension === true) extension.add(row.table_name);
    let table = types.get(row.table_name);
    if (!table) types.set(row.table_name, (table = new Map()));
    table.set(row.column_name, row.type);
    if (row.nullable === true || row.nullable === 1) nullable.add(`${row.table_name}\0${row.column_name}`);
  }
  // `extension`: tables an extension created (PostGIS's `spatial_ref_sys`) belong to no app — not an unknown table of it.
  return { types, nullable, extension };
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  type: string;
  nullable: boolean | number;
  /** Postgres: the relation belongs to an extension. */
  extension?: boolean;
}

async function foreignKeyRows(run: CatalogQuery, driver: Driver): Promise<{ table: string; column: string; references: string; referenced: string }[]> {
  if (driver === 'sqlite') {
    const rows = await run<{ table_name: string; id: number; seq: number; references: string; from: string; to: string }>(
      // Without a column, a foreign key references the primary key.
      `select m.name as table_name, f.id, f.seq, f."table" as "references", f."from",
        coalesce(f."to", (select p.name from pragma_table_info(f."table") p where p.pk = 1)) as "to"
        from sqlite_master m join pragma_foreign_key_list(m.name) f where m.type = 'table'`,
    );
    const composite = new Set(rows.filter((row) => row.seq > 0).map((row) => `${row.table_name}\0${row.id}`));
    return rows
      .filter((row) => !composite.has(`${row.table_name}\0${row.id}`))
      .map((row) => ({ table: row.table_name, column: row.from, references: row.references, referenced: row.to }));
  }
  const rows = await run<{ table_name: string; foreign_table: string; columns: string[]; foreign_columns: string[] }>(`
    select c.conrelid::regclass::text as table_name, c.confrelid::regclass::text as foreign_table,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i) as columns,
      array(select a.attname::text from unnest(c.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i) as foreign_columns
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace join pg_class t on t.oid = c.conrelid
    where n.nspname = any(current_schemas(false)) and t.oid = to_regclass(quote_ident(t.relname)) and c.contype = 'f'`);
  return rows
    .filter((row) => row.columns.length === 1)
    .map((row) => ({ table: unquote(row.table_name), column: row.columns[0]!, references: unquote(row.foreign_table), referenced: row.foreign_columns[0]! }));
}

/** Table → its unique column sets (unique indexes without a condition, and the primary key), sorted. */
async function uniqueSets(run: CatalogQuery, driver: Driver): Promise<Map<string, string[][]>> {
  const sets = new Map<string, string[][]>();
  const add = (table: string, columns: string[]) => {
    let list = sets.get(table);
    if (!list) sets.set(table, (list = []));
    if (!list.some((other) => other.join('\0') === columns.join('\0'))) list.push(columns);
  };
  if (driver === 'sqlite') {
    const indexed = await run<{ table_name: string; index_name: string; column_name: string }>(
      `select m.name as table_name, i.name as index_name, c.name as column_name from sqlite_master m join pragma_index_list(m.name) i join pragma_index_info(i.name) c
        where m.type = 'table' and i."unique" = 1 and i.partial = 0 order by m.name, i.name, c.seqno`,
    );
    const byIndex = new Map<string, { table: string; columns: string[] }>();
    for (const row of indexed) {
      const key = `${row.table_name}\0${row.index_name}`;
      const entry = byIndex.get(key) ?? { table: row.table_name, columns: [] };
      entry.columns.push(row.column_name);
      byIndex.set(key, entry);
    }
    for (const { table, columns } of byIndex.values()) add(table, columns);
    // An INTEGER PRIMARY KEY is the rowid: it has no index of its own, only `pk` in table_info.
    const keys = await run<{ table_name: string; column_name: string }>(
      `select m.name as table_name, p.name as column_name from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table' and p.pk > 0 order by m.name, p.pk`,
    );
    const primary = new Map<string, string[]>();
    for (const row of keys) primary.set(row.table_name, [...(primary.get(row.table_name) ?? []), row.column_name]);
    for (const [table, columns] of primary) add(table, columns);
  } else {
    const rows = await run<{ table_name: string; columns: string[] }>(`
      select i.indrelid::regclass::text as table_name,
        array(select a.attname::text from unnest(i.indkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n order by k.o) as columns
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = any(current_schemas(false)) and t.oid = to_regclass(quote_ident(t.relname)) and (i.indisunique or i.indisprimary) and i.indpred is null and i.indexprs is null`);
    for (const row of rows) add(unquote(row.table_name), row.columns);
  }
  for (const list of sets.values()) list.sort((a, b) => byCodePoint(a.join('\0'), b.join('\0')));
  return new Map([...sets].sort(([a], [b]) => byCodePoint(a, b)));
}

/** Table → the columns of its primary key, in key order, sorted by table. */
async function primaryKeyColumns(run: CatalogQuery, driver: Driver): Promise<Map<string, string[]>> {
  const keys = new Map<string, string[]>();
  if (driver === 'sqlite') {
    const rows = await run<{ table_name: string; column_name: string }>(
      `select m.name as table_name, p.name as column_name from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table' and p.pk > 0 order by m.name, p.pk`,
    );
    for (const row of rows) keys.set(row.table_name, [...(keys.get(row.table_name) ?? []), row.column_name]);
  } else {
    const rows = await run<{ table_name: string; columns: string[] }>(`
      select i.indrelid::regclass::text as table_name,
        array(select a.attname::text from unnest(i.indkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n order by k.o) as columns
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = any(current_schemas(false)) and t.oid = to_regclass(quote_ident(t.relname)) and i.indisprimary`);
    for (const row of rows) keys.set(unquote(row.table_name), row.columns);
  }
  return new Map([...keys].sort(([a], [b]) => byCodePoint(a, b)));
}

/** `regclass::text` quotes a name that needs it (`"Users"`). */
function unquote(name: string): string {
  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

const COUNT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * The relations the foreign keys describe: a belongsTo named after the column without `_id`; its inverse named after the
 * table (or the column's `.inverse()`), a hasOne when the column alone is unique, a hasMany otherwise; and for a table with
 * exactly two foreign keys to two other tables that are unique together, a belongsToMany each way, named after the other
 * table. Two or more foreign keys to one table each need an inverse name; a relation never takes a name twice or hides a column.
 */
export function deriveRelations(facts: SchemaFacts): DerivedRelations {
  const problems: string[] = [];
  const relations = new Map<string, Map<string, Relation>>();
  const origins = new Map<string, string>();
  const softDeletes = new Set(facts.markers.filter((m) => m.marker === 'soft_deletes').map((m) => m.table));
  const inverses = new Map(facts.markers.filter((m) => m.marker === 'inverse' && m.value).map((m) => [`${m.table}\0${m.column}`, m.value!]));
  const add = (table: string, name: string, relation: Relation, origin: string) => {
    const key = `${table}\0${name}`;
    if (facts.columns.get(table)?.includes(name)) {
      problems.push(
        relation.kind === 'belongsTo'
          ? `${origin} references ${relation.table}, so its relation would be named "${name}" like the column — name the column ${name}_id`
          : `${table} has a column "${name}", and ${origin} would add a relation of that name — name the relation: .inverse('…')`,
      );
      return;
    }
    const earlier = origins.get(key);
    if (earlier) {
      problems.push(`${table} would get two relations named "${name}" (from ${earlier} and ${origin}) — name one of them: .inverse('…')`);
      return;
    }
    origins.set(key, origin);
    let map = relations.get(table);
    if (!map) relations.set(table, (map = new Map()));
    map.set(name, relation);
  };
  const unique = (table: string, columns: readonly string[]) =>
    (facts.uniques.get(table) ?? []).some((set) => set.length === columns.length && columns.every((column) => set.includes(column)));

  const keys = [...facts.foreignKeys].sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column));
  for (const key of keys) {
    const origin = `${key.table}.${key.column}`;
    add(
      key.table,
      key.column.replace(/_id$/, ''),
      {
        kind: 'belongsTo',
        table: key.references,
        foreignKey: key.column,
        localKey: key.column,
        targetKey: key.referenced,
        nullable: key.nullable || softDeletes.has(key.references),
      },
      origin,
    );
    const inverse = inverses.get(`${key.table}\0${key.column}`);
    const siblings = keys.filter((other) => other.table === key.table && other.references === key.references);
    // Two or more foreign keys to one table: every one names its way back, or none of them gets one.
    if (siblings.length > 1 && siblings.some((sibling) => !inverses.has(`${sibling.table}\0${sibling.column}`))) {
      if (siblings[0] === key) {
        problems.push(
          `${key.table} has ${COUNT[siblings.length] ?? siblings.length} foreign keys to ${key.references} (${siblings.map((s) => s.column).join(', ')}) — name the inverse relations: .inverse('…')`,
        );
      }
      continue;
    }
    const one = unique(key.table, [key.column]);
    add(
      key.references,
      inverse ?? key.table,
      {
        kind: one ? 'hasOne' : 'hasMany',
        table: key.table,
        foreignKey: key.column,
        localKey: key.referenced,
        targetKey: key.column,
        ...(one ? { nullable: true } : {}),
      },
      origin,
    );
  }

  // A pivot: exactly two foreign keys, to two different tables, unique together.
  const byTable = new Map<string, ForeignKey[]>();
  for (const key of keys) byTable.set(key.table, [...(byTable.get(key.table) ?? []), key]);
  for (const [pivot, pair] of byTable) {
    if (pair.length !== 2 || pair[0]!.references === pair[1]!.references || !unique(pivot, pair.map((k) => k.column))) continue;
    for (const [near, far] of [pair, pair.toReversed()] as [ForeignKey, ForeignKey][]) {
      add(
        near.references,
        far.references,
        { kind: 'belongsToMany', table: far.references, pivot, foreignKey: near.column, relatedKey: far.column, localKey: near.referenced, targetKey: far.referenced },
        `${pivot} (${near.column}, ${far.column})`,
      );
    }
  }

  const sorted = new Map(
    [...relations]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([table, map]) => [table, new Map([...map].sort(([a], [b]) => byCodePoint(a, b)))] as const),
  );
  return { relations: sorted, problems };
}
