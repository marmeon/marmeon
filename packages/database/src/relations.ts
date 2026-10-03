import {
  AliasNode,
  ColumnNode,
  FunctionNode,
  IdentifierNode,
  OperationNodeTransformer,
  ReferenceNode,
  SelectQueryNode,
  TableNode,
  type AliasableExpression,
  type ExpressionBuilder,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryBuilder,
  type Simplify,
  type StringReference,
  type UnknownRow,
} from 'kysely';
import { jsonArrayFrom as pgArray, jsonObjectFrom as pgObject } from 'kysely/helpers/postgres';
import { jsonArrayFrom as sqliteArray, jsonObjectFrom as sqliteObject } from 'kysely/helpers/sqlite';
import type { ColumnKind as Kind, SchemaMetadata } from './metadata.ts';
import type { Driver } from './schema/blueprint.ts';

const MANY = '__bespoke_relation_many__';
const ONE = '__bespoke_relation_one__';

type Build<DB, TB extends keyof DB, R extends keyof DB, O> = (query: SelectQueryBuilder<DB, TB | R, {}>) => SelectQueryBuilder<DB, any, O>;

/**
 * The rows of `table` whose `foreignKey` points at the outer row's `localKey` — loaded in the same
 * query, as an array (one query, no lazy loading: N+1 cannot happen). Select explicitly — the
 * selection is the type (and SQLite's JSON functions need the columns).
 *
 * ```ts
 * users.query().select((eb) => ['id', 'name',
 *   hasMany(eb, 'posts', 'user_id', 'users.id', (q) => q.select(['posts.id', 'posts.title']).orderBy('posts.id')).as('posts'),
 * ])
 * ```
 */
export function hasMany<DB, TB extends keyof DB, R extends keyof DB & string, O>(
  eb: ExpressionBuilder<DB, TB>,
  table: R,
  foreignKey: keyof DB[R] & string,
  localKey: StringReference<DB, TB>,
  build: Build<DB, TB, R, O>,
): AliasableExpression<Simplify<O>[]> {
  return relation(eb, MANY, table, `${table}.${foreignKey}`, localKey, build) as never;
}

/** The one row of `table` whose `foreignKey` points at the outer row — or `null`. */
export function hasOne<DB, TB extends keyof DB, R extends keyof DB & string, O>(
  eb: ExpressionBuilder<DB, TB>,
  table: R,
  foreignKey: keyof DB[R] & string,
  localKey: StringReference<DB, TB>,
  build: Build<DB, TB, R, O>,
): AliasableExpression<Simplify<O> | null> {
  return relation(eb, ONE, table, `${table}.${foreignKey}`, localKey, build) as never;
}

/** The row of `table` the outer row's `foreignKey` points at (its `ownerKey`, usually `id`) — or `null`. */
export function belongsTo<DB, TB extends keyof DB, R extends keyof DB & string, O>(
  eb: ExpressionBuilder<DB, TB>,
  table: R,
  ownerKey: keyof DB[R] & string,
  foreignKey: StringReference<DB, TB>,
  build: Build<DB, TB, R, O>,
): AliasableExpression<Simplify<O> | null> {
  return relation(eb, ONE, table, `${table}.${ownerKey}`, foreignKey, build) as never;
}

function relation(eb: ExpressionBuilder<any, any>, kind: string, table: string, inner: string, outer: string, build: Build<any, any, any, unknown>) {
  const query = build(eb.selectFrom(table).whereRef(inner, '=', outer));
  // A marker the connection's RelationsPlugin replaces with its dialect's JSON aggregation.
  return eb.fn(kind, [query]);
}

// --- The plugin ----------------------------------------------------------------------------

/** Where each key of a relation's JSON comes from — to give nested values the types `Tables` promises. */
interface Shape {
  readonly columns: Map<string, { table: string; column: string }>;
  readonly relations: Map<string, Shape>;
}

/**
 * Turns the relation markers into the dialect's JSON aggregation, and — since nested JSON escapes the
 * connection's own normalization — converts nested values to what the table types promise: booleans
 * (SQLite: 0/1), JSON (SQLite: text), decimals (both: numbers → `'12.50'`), timestamps (Postgres: `+00:00` → `Z`).
 */
export class RelationsPlugin implements KyselyPlugin {
  readonly #driver: Driver;
  readonly #metadata: SchemaMetadata;
  readonly #shapes = new WeakMap<QueryId, Map<string, Shape>>();

  constructor(driver: Driver, metadata: SchemaMetadata) {
    this.#driver = driver;
    this.#metadata = metadata;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    if (!mentionsRelation(node)) return node;
    const shapes = new Map<string, Shape>();
    const transformed = new RelationTransformer(this.#driver, shapes).transformNode(node, queryId);
    if (shapes.size) this.#shapes.set(queryId, shapes);
    return transformed;
  }

  async transformResult({ result, queryId }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const shapes = this.#shapes.get(queryId);
    if (!shapes || result.rows.length === 0) return result;
    // Loaded by the driver on the connection this query ran on (a lookup here could deadlock inside a transaction).
    const kinds = this.#metadata.kinds;
    for (const row of result.rows) convertRow(row as Record<string, unknown>, shapes, kinds);
    return result;
  }
}

class RelationTransformer extends OperationNodeTransformer {
  readonly #driver: Driver;
  readonly #shapes: Map<string, Shape>;

  constructor(driver: Driver, shapes: Map<string, Shape>) {
    super();
    this.#driver = driver;
    this.#shapes = shapes;
  }

  protected override transformAlias(node: AliasNode, queryId?: QueryId): AliasNode {
    const transformed = super.transformAlias(node, queryId);
    if (FunctionNode.is(node.node) && (node.node.func === MANY || node.node.func === ONE) && IdentifierNode.is(node.alias)) {
      this.#shapes.set(node.alias.name, shapeOf(node.node.arguments[0] as SelectQueryNode));
    }
    return transformed;
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    const transformed = super.transformFunction(node, queryId);
    if (transformed.func !== MANY && transformed.func !== ONE) return transformed;
    const subquery = transformed.arguments[0]!;
    if (SelectQueryNode.is(subquery) && subquery.selections?.some((s) => isSelectAll(s.selection))) {
      throw new Error('Relations need explicit columns: q.select([…]) instead of selectAll() — the selection is the type.');
    }
    const expression = { toOperationNode: () => subquery } as never;
    const many = transformed.func === MANY;
    const json = this.#driver === 'sqlite' ? (many ? sqliteArray(expression) : sqliteObject(expression)) : many ? pgArray(expression) : pgObject(expression);
    return json.toOperationNode() as unknown as FunctionNode;
  }
}

function mentionsRelation(node: OperationNode): boolean {
  // Cheap check before transforming: only selects can contain relations.
  return node.kind === 'SelectQueryNode' && JSON.stringify(node, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)).includes('__bespoke_relation_');
}

function isSelectAll(node: OperationNode): boolean {
  return node.kind === 'SelectAllNode' || (ReferenceNode.is(node) && node.column.kind === 'SelectAllNode');
}

function shapeOf(query: SelectQueryNode): Shape {
  const from = query.from?.froms[0];
  const defaultTable = from && TableNode.is(from) ? from.table.identifier.name : from && AliasNode.is(from) && TableNode.is(from.node) ? from.node.table.identifier.name : undefined;
  const shape: Shape = { columns: new Map(), relations: new Map() };
  for (const { selection } of query.selections ?? []) {
    let node: OperationNode = selection;
    let key: string | undefined;
    if (AliasNode.is(node) && IdentifierNode.is(node.alias)) {
      key = node.alias.name;
      node = node.node;
    }
    if (FunctionNode.is(node) && (node.func === MANY || node.func === ONE) && key) {
      shape.relations.set(key, shapeOf(node.arguments[0] as SelectQueryNode));
    } else if (ReferenceNode.is(node) && ColumnNode.is(node.column)) {
      const table = node.table?.table.identifier.name ?? defaultTable;
      if (table) shape.columns.set(key ?? node.column.column.name, { table, column: node.column.column.name });
    } else if (ColumnNode.is(node) && defaultTable) {
      shape.columns.set(key ?? node.column.name, { table: defaultTable, column: node.column.name });
    }
  }
  return shape;
}

function convertRow(row: Record<string, unknown>, shapes: Map<string, Shape>, kinds: ReadonlyMap<string, ReadonlyMap<string, Kind>>): void {
  for (const [key, shape] of shapes) {
    let value = row[key];
    // SQLite loses the JSON subtype at a subquery boundary: a relation inside a relation arrives as JSON text.
    if (typeof value === 'string') row[key] = value = JSON.parse(value);
    if (Array.isArray(value)) for (const item of value) convertNested(item, shape, kinds);
    else if (value && typeof value === 'object') convertNested(value as Record<string, unknown>, shape, kinds);
  }
}

function convertNested(object: Record<string, unknown>, shape: Shape, kinds: ReadonlyMap<string, ReadonlyMap<string, Kind>>): void {
  for (const [key, { table, column }] of shape.columns) {
    const kind = kinds.get(table)?.get(column);
    if (kind && key in object) object[key] = convert(object[key], kind);
  }
  convertRow(object, shape.relations, kinds);
}

function convert(value: unknown, kind: Kind): unknown {
  if (value === null || value === undefined) return value;
  if (kind === 'boolean') return typeof value === 'number' ? value !== 0 : value;
  if (kind === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
  if (kind === 'timestamp') return typeof value === 'string' && !value.endsWith('Z') ? new Date(value).toISOString() : value;
  if (typeof kind === 'object') return typeof value === 'number' ? value.toFixed(kind.decimal) : value;
  return value;
}
