import {
  AliasNode,
  expressionBuilder,
  ParensNode,
  WhereNode,
  type CompiledQuery,
  BinaryOperationNode,
  ColumnNode,
  FunctionNode,
  IdentifierNode,
  JoinNode,
  LimitNode,
  OperationNodeTransformer,
  OperatorNode,
  QueryNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  ValueNode,
  type AliasableExpression,
  type ExpressionBuilder,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type ReturningNode,
  type RootOperationNode,
  type SelectQueryBuilder,
  type Simplify,
  type StringReference,
  type UnknownRow,
} from 'kysely';
import { jsonArrayFrom as pgArray, jsonObjectFrom as pgObject } from 'kysely/helpers/postgres';
import { jsonArrayFrom as sqliteArray, jsonObjectFrom as sqliteObject } from 'kysely/helpers/sqlite';
import type { Relation } from './introspection.ts';
import type { ColumnKind as Kind, SchemaMetadata } from './metadata.ts';
import { hasPlaceholder, MANY, ONE, RELATION, RELATION_TARGET, SECRET, sourcesOf, WITH_TRASHED, type Source } from './placeholders.ts';
import { asked, guardSecrets, outputName, type Spelled } from './secret-guard.ts';
import type { Driver } from './schema/blueprint.ts';

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
  return relation(eb, MANY, `hasMany('${table}')`, table, `${table}.${foreignKey}`, localKey, build) as never;
}

/** The one row of `table` whose `foreignKey` points at the outer row — or `null`. */
export function hasOne<DB, TB extends keyof DB, R extends keyof DB & string, O>(
  eb: ExpressionBuilder<DB, TB>,
  table: R,
  foreignKey: keyof DB[R] & string,
  localKey: StringReference<DB, TB>,
  build: Build<DB, TB, R, O>,
): AliasableExpression<Simplify<O> | null> {
  return relation(eb, ONE, `hasOne('${table}')`, table, `${table}.${foreignKey}`, localKey, build) as never;
}

/** The row of `table` the outer row's `foreignKey` points at (its `ownerKey`, usually `id`) — or `null`. */
export function belongsTo<DB, TB extends keyof DB, R extends keyof DB & string, O>(
  eb: ExpressionBuilder<DB, TB>,
  table: R,
  ownerKey: keyof DB[R] & string,
  foreignKey: StringReference<DB, TB>,
  build: Build<DB, TB, R, O>,
): AliasableExpression<Simplify<O> | null> {
  return relation(eb, ONE, `belongsTo('${table}')`, table, `${table}.${ownerKey}`, foreignKey, build) as never;
}

function relation(eb: ExpressionBuilder<any, any>, kind: string, label: string, table: string, inner: string, outer: string, build: Build<any, any, any, unknown>) {
  const query = build(eb.selectFrom(table).whereRef(inner, '=', outer));
  // A marker the connection's RelationsPlugin replaces with its dialect's JSON aggregation.
  return eb.fn(kind, [query, eb.val(label)]);
}

// --- The chain's relations ---------------------------------------------------------------------

/** What a `with()` or `withRelation()` placeholder holds, besides the callback's query. */
export type RelationSpec =
  | { readonly kind: 'with'; readonly name: string }
  | { readonly kind: 'relation'; readonly name: string; readonly table: string; readonly foreignKey: string; readonly localKey: string; readonly one: boolean };

type Callback = (query: SelectQueryBuilder<any, any, any>) => unknown;

/**
 * The selection `with()` and `withRelation()` add: a placeholder holding what to load and the callback's query, which starts
 * from a stand-in table — the relation's table is only known once the placeholder is resolved.
 */
export function relationSelection(spec: RelationSpec, alias: string, callback: Callback | undefined, label: string): { toOperationNode(): OperationNode } {
  let query: OperationNode = SelectQueryNode.createFrom([TableNode.create(RELATION_TARGET)]);
  if (callback) {
    const built = callback(expressionBuilder<any, any>().selectFrom(RELATION_TARGET));
    const node = (built as { toOperationNode?: () => OperationNode } | undefined)?.toOperationNode?.();
    const own = node && SelectQueryNode.is(node) && node.from?.froms.some((from) => isTarget(from));
    if (!own) throw new TypeError(`The callback of ${label} returns something else than the query it was given — return the query: (q) => q.select(…).`);
    query = node!;
  }
  const marker = FunctionNode.create(RELATION, [ValueNode.createImmediate(JSON.stringify(spec)), query]);
  return { toOperationNode: () => AliasNode.create(marker, IdentifierNode.create(alias)) };
}

/**
 * Turns a `with()`/`withRelation()` placeholder into the relation's subquery — still a select with placeholders of its own (the
 * nested relations, `withTrashed()`), which the resolver resolves next, in its own scope. `sources` are the tables of the
 * select the placeholder is in; the relation is looked up on the one that has it. Table and column names come from the
 * metadata, never from the query.
 */
export function relationQuery(marker: FunctionNode, sources: readonly Source[], metadata: SchemaMetadata, alias: (table: string) => string): FunctionNode {
  const spec = JSON.parse(String((marker.arguments[0] as ValueNode).value)) as RelationSpec;
  const label = spec.kind === 'with' ? `with('${spec.name}')` : `withRelation('${spec.name}')`;
  const { outer, relation } = spec.kind === 'with' ? lookUp(spec.name, sources, metadata, label) : defined(spec, sources, metadata, label);
  const target = relation.table;
  // A relation to the outer row's own table (a parent category) needs a name of its own: the outer name would be the inner table.
  const ref = target === outer.ref ? alias(target) : target;
  let query = marker.arguments[1] as SelectQueryNode;
  query = { ...query, from: { ...query.from!, froms: query.from!.froms.map((from) => (isTarget(from) ? (ref === target ? TableNode.create(target) : AliasNode.create(TableNode.create(target), IdentifierNode.create(ref))) : from)) } };
  if (ref !== target) query = new Rename(target, ref).transformNode(query) as SelectQueryNode;

  query = { ...query, selections: selectionsOf(query, target, ref, metadata, label) };
  // The callback's own conditions in parentheses: an `or` in raw SQL must not swallow the correlation or the soft-delete filter.
  if (query.where) query = { ...query, where: WhereNode.create(ParensNode.create(query.where.where)) };
  const at = (table: string, column: string) => ReferenceNode.create(ColumnNode.create(column), TableNode.create(table));
  if (relation.kind === 'belongsToMany') {
    const pivot = relation.pivot!;
    // The pivot is joined here, not by the callback: a column the callback names without its table is the related table's.
    query = new Qualify(ref, new Set(metadata.kinds.get(target)?.keys())).transformNode(query) as SelectQueryNode;
    const join = JoinNode.createWithOn('InnerJoin', TableNode.create(pivot), BinaryOperationNode.create(at(pivot, relation.relatedKey!), OperatorNode.create('='), at(ref, relation.targetKey)));
    query = { ...query, joins: [join, ...(query.joins ?? [])] };
    query = QueryNode.cloneWithWhere(query, BinaryOperationNode.create(at(pivot, relation.foreignKey), OperatorNode.create('='), at(outer.ref, relation.localKey)));
  } else {
    query = QueryNode.cloneWithWhere(query, BinaryOperationNode.create(at(ref, relation.targetKey), OperatorNode.create('='), at(outer.ref, relation.localKey)));
  }
  // Soft-deleted rows never come through a relation — unless its callback asked for them.
  if (!hasPlaceholder(query.where, WITH_TRASHED, true)) {
    for (const [table, name] of [[target, ref], ...(relation.pivot ? [[relation.pivot, relation.pivot]] : [])] as [string, string][]) {
      if (metadata.softDeletes.has(table)) query = QueryNode.cloneWithWhere(query, BinaryOperationNode.create(at(name, 'deleted_at'), OperatorNode.create('is'), ValueNode.createImmediate(null)));
    }
  }
  const one = relation.kind === 'belongsTo' || relation.kind === 'hasOne' || (spec.kind === 'relation' && spec.one);
  // One row: the first the callback's order gives (Postgres' JSON object refuses a subquery of several rows).
  if (one && !query.limit) query = SelectQueryNode.cloneWithLimit(query, LimitNode.create(ValueNode.createImmediate(1)));
  return FunctionNode.create(one ? ONE : MANY, [query, ValueNode.createImmediate(label)]);
}

function lookUp(name: string, sources: readonly Source[], metadata: SchemaMetadata, label: string): { outer: Source; relation: Relation } {
  const found = sources.flatMap((source) => {
    const relation = source.table === undefined ? undefined : metadata.relations.get(source.table)?.get(name);
    return relation ? [{ outer: source, relation }] : [];
  });
  if (found.length === 1) return found[0]!;
  const tables = sources.flatMap((source) => (source.table ? [source.table] : []));
  if (found.length > 1) {
    throw new Error(`${label}: ${found.map(({ outer }) => outer.ref).join(' and ')} both have a relation "${name}" — load it in a query on one of them.`);
  }
  const known = [...new Set(tables.flatMap((table) => [...(metadata.relations.get(table)?.keys() ?? [])]))];
  throw new Error(`${label}: ${tables.join(', ') || 'the query'} has no relation "${name}"${known.length ? ` — it has ${known.join(', ')}` : ''}.`);
}

function defined(spec: Extract<RelationSpec, { kind: 'relation' }>, sources: readonly Source[], metadata: SchemaMetadata, label: string): { outer: Source; relation: Relation } {
  const columns = metadata.kinds.get(spec.table);
  if (!columns) throw new Error(`${label}: there is no table "${spec.table}".`);
  if (!columns.has(spec.foreignKey)) throw new Error(`${label}: "${spec.table}" has no column "${spec.foreignKey}".`);
  // The local key is a column of the query's tables: the first (in FROM and join order) that has it.
  const outer = sources.find((source) => source.table !== undefined && metadata.kinds.get(source.table)?.has(spec.localKey));
  if (!outer) {
    const tables = sources.flatMap((source) => (source.table ? [source.table] : []));
    throw new Error(`${label}: ${tables.join(', ') || 'the query'} has no column "${spec.localKey}".`);
  }
  return { outer, relation: { kind: spec.one ? 'hasOne' : 'hasMany', table: spec.table, foreignKey: spec.foreignKey, localKey: spec.localKey, targetKey: spec.foreignKey } };
}

function isTarget(node: OperationNode): boolean {
  return TableNode.is(node) && node.table.identifier.name === RELATION_TARGET;
}

/**
 * The relation's selections: the callback's, with `selectAll()` spelled out as the columns a relation may load — and, when the
 * callback selects no column of the table itself, those columns first (the same rule as the result type).
 */
function selectionsOf(query: SelectQueryNode, target: string, ref: string, metadata: SchemaMetadata, label: string): SelectionNode[] {
  const own = metadata.kinds.get(target);
  const loadable = (source: Source) => (metadata.columns.get(source.table!) ?? []).map((column) => SelectionNode.create(ReferenceNode.create(ColumnNode.create(column), TableNode.create(source.ref))));
  const sources = sourcesOf(query);
  const spelled = (source: Source | undefined, name: string) => {
    if (!source?.table) throw new Error(`${label}: name the columns of "${name}" — a relation does not load all columns of a subquery.`);
    return loadable(source);
  };
  const selections = (query.selections ?? []).flatMap((node) => {
    const { selection } = node;
    if (selection.kind === 'SelectAllNode') return sources.flatMap((source) => spelled(source, source.ref));
    if (ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode') {
      const name = selection.table!.table.identifier.name;
      return spelled(sources.find((source) => source.ref === name), name);
    }
    return [node];
  });
  const explicit = selections.some(({ selection }) => own?.has(outputName(selection) ?? '') === true);
  return explicit ? selections : [...loadable({ table: target, ref }), ...selections];
}

/** Refers to `from` as `to` — the relation's table under its alias — but not in a nested relation, nor where `from` is a table again. */
class Rename extends OperationNodeTransformer {
  readonly #from: string;
  readonly #to: string;
  #depth = 0;

  constructor(from: string, to: string) {
    super();
    this.#from = from;
    this.#to = to;
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    if (this.#depth > 0 && sourcesOf(node).some((source) => source.ref === this.#from)) return node;
    this.#depth++;
    try {
      return super.transformSelectQuery(node, queryId);
    } finally {
      this.#depth--;
    }
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    return node.func === RELATION ? node : super.transformFunction(node, queryId);
  }

  protected override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    if (node.table?.table.identifier.name !== this.#from) return super.transformReference(node, queryId);
    return ReferenceNode.create(node.column as ColumnNode, TableNode.create(this.#to));
  }
}

/** Refers to the relation's own columns that its select names without a table by `ref` — in that select, not in its subqueries. */
class Qualify extends OperationNodeTransformer {
  readonly #ref: string;
  readonly #columns: ReadonlySet<string>;
  #depth = 0;

  constructor(ref: string, columns: ReadonlySet<string>) {
    super();
    this.#ref = ref;
    this.#columns = columns;
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    if (this.#depth > 0) return node;
    this.#depth++;
    try {
      return super.transformSelectQuery(node, queryId);
    } finally {
      this.#depth--;
    }
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    return node.func === RELATION ? node : super.transformFunction(node, queryId);
  }

  protected override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    if (node.table || !ColumnNode.is(node.column) || !this.#columns.has(node.column.column.name)) return super.transformReference(node, queryId);
    return ReferenceNode.create(node.column, TableNode.create(this.#ref));
  }
}

// --- The plugin ----------------------------------------------------------------------------

const RELATIONS = [MANY, ONE];

/** Where each key of a relation's JSON comes from — to give nested values the types `Tables` promises. */
interface Shape {
  readonly columns: Map<string, { table: string; column: string }>;
  readonly relations: Map<string, Shape>;
}

/**
 * Keeps secret columns out of what a query reads ({@link guardSecrets}) and turns the relations' subqueries into the dialect's
 * JSON aggregation. Since nested JSON escapes the connection's own normalization, the connection converts nested values to what
 * the table types promise ({@link convert}): booleans (SQLite: 0/1), JSON (SQLite: text), decimals (both: numbers → `'12.50'`),
 * timestamps (Postgres: `+00:00` → `Z`).
 */
export class RelationsPlugin implements KyselyPlugin {
  readonly #driver: Driver;
  readonly #metadata: SchemaMetadata;
  /** By the query as compiled — one entry per compile, never shared by the builders derived from one another. */
  readonly #shapes = new WeakMap<RootOperationNode, Map<string, Shape>>();
  /** By query id, the last compile's: a plugin added after this one (`db.withPlugin()`) hands the connection another node. */
  readonly #lastShapes = new WeakMap<QueryId, Map<string, Shape>>();
  /** What {@link transform} returned: checked and rewritten already (`secret()` unwrapped) — never again. */
  readonly #done = new WeakSet<RootOperationNode>();

  constructor(driver: Driver, metadata: SchemaMetadata) {
    this.#driver = driver;
    this.#metadata = metadata;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    // Not fresh: the schema resolver left the query for the connection, which transforms it after loading ({@link transform}).
    if (!this.#metadata.fresh) return node;
    return this.transform(node, queryId);
  }

  /** The query checked for secret columns, with its relations as JSON — while compiling, or on the connection after loading. */
  transform(node: RootOperationNode, queryId: QueryId): RootOperationNode {
    if (this.#done.has(node)) return node;
    const spelled = guardSecrets(node, this.#metadata);
    const relations = hasPlaceholder(node, RELATIONS);
    const transformed = relations || spelled.size > 0 || hasPlaceholder(node, SECRET) ? new RelationTransformer(this.#driver, spelled).transformNode(node, queryId) : node;
    this.#done.add(transformed);
    // Only the keys of the query's own rows (a nested relation's shape is reached through its parent's) — for every compile, an
    // empty map included: a builder derived from the same one shares the query id, never what this compile loads.
    const shapes = new Map<string, Shape>();
    if (relations && SelectQueryNode.is(node)) {
      for (const { selection } of node.selections ?? []) {
        if (AliasNode.is(selection) && IdentifierNode.is(selection.alias) && FunctionNode.is(selection.node) && RELATIONS.includes(selection.node.func)) {
          shapes.set(selection.alias.name, shapeOf(selection.node.arguments[0] as SelectQueryNode));
        }
      }
    }
    this.#shapes.set(transformed, shapes);
    this.#lastShapes.set(queryId, shapes);
    return transformed;
  }

  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result;
  }

  /** @internal — converts the nested values of `result`, the rows of `query` as it ran (called by the connection). */
  convert(query: CompiledQuery, result: QueryResult<unknown>): void {
    const shapes = this.#shapes.get(query.query) ?? this.#lastShapes.get(query.queryId);
    if (!shapes?.size || result.rows.length === 0) return;
    // Loaded by the driver on the connection this query ran on (a lookup here could deadlock inside a transaction).
    const kinds = this.#metadata.kinds;
    for (const row of result.rows) convertRow(row as Record<string, unknown>, shapes, kinds);
  }
}

class RelationTransformer extends OperationNodeTransformer {
  readonly #driver: Driver;
  readonly #spelled: Spelled;

  constructor(driver: Driver, spelled: Spelled) {
    super();
    this.#driver = driver;
    this.#spelled = spelled;
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const selections = this.#spelled.get(node);
    return super.transformSelectQuery(selections ? { ...node, selections } : node, queryId);
  }

  protected override transformReturning(node: ReturningNode, queryId?: QueryId): ReturningNode {
    const selections = this.#spelled.get(node);
    return super.transformReturning(selections ? { ...node, selections } : node, queryId);
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    // `secret()` was asked for: the column itself, still marked as asked for.
    if (node.func === SECRET) return asked(this.transformNode(node.arguments[0]!, queryId)) as unknown as FunctionNode;
    if (node.func !== MANY && node.func !== ONE) return super.transformFunction(node, queryId);
    const subquery = this.transformNode(node.arguments[0]!, queryId);
    const expression = { toOperationNode: () => subquery } as never;
    const many = node.func === MANY;
    const json = this.#driver === 'sqlite' ? (many ? sqliteArray(expression) : sqliteObject(expression)) : many ? pgArray(expression) : pgObject(expression);
    return json.toOperationNode() as unknown as FunctionNode;
  }
}

function shapeOf(query: SelectQueryNode): Shape {
  const sources = sourcesOf(query);
  const tableOf = (ref: string | undefined) => (ref === undefined ? sources[0]?.table : (sources.find((source) => source.ref === ref)?.table ?? ref));
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
      const table = tableOf(node.table?.table.identifier.name);
      if (table) shape.columns.set(key ?? node.column.column.name, { table, column: node.column.column.name });
    } else if (ColumnNode.is(node)) {
      const table = tableOf(undefined);
      if (table) shape.columns.set(key ?? node.column.name, { table, column: node.column.name });
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
