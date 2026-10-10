import {
  AliasNode,
  expressionBuilder,
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
import { hasPlaceholder, MANY, ONE, RELATION, RELATION_TARGET, sourcesOf, WITH_TRASHED, type Source } from './placeholders.ts';
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
    if (!node || !SelectQueryNode.is(node)) throw new TypeError(`The callback of ${label} returns something else than the query it was given — return the query: (q) => q.select(…).`);
    query = node;
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
  const outer = sources[0];
  const columns = metadata.kinds.get(spec.table);
  if (!outer) throw new Error(`${label}: the query has no table to relate "${spec.table}" to.`);
  if (!columns) throw new Error(`${label}: there is no table "${spec.table}".`);
  if (!columns.has(spec.foreignKey)) throw new Error(`${label}: "${spec.table}" has no column "${spec.foreignKey}".`);
  if (outer.table !== undefined && !metadata.kinds.get(outer.table)?.has(spec.localKey)) throw new Error(`${label}: "${outer.table}" has no column "${spec.localKey}".`);
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
 * Turns the relations' subqueries into the dialect's JSON aggregation — refusing a secret column selected anywhere in one — and,
 * since nested JSON escapes the connection's own normalization, converts nested values to what the table types promise:
 * booleans (SQLite: 0/1), JSON (SQLite: text), decimals (both: numbers → `'12.50'`), timestamps (Postgres: `+00:00` → `Z`).
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
    // Not fresh: the schema resolver left the query for the connection, which transforms it after loading ({@link transform}).
    if (!this.#metadata.fresh) return node;
    return this.transform(node, queryId);
  }

  /** The query with its relations as JSON — called while compiling, or by the connection once the metadata is loaded. */
  transform(node: RootOperationNode, queryId: QueryId): RootOperationNode {
    if (!hasPlaceholder(node, RELATIONS)) return node;
    const shapes = new Map<string, Shape>();
    const transformed = new RelationTransformer(this.#driver, this.#metadata, shapes).transformNode(node, queryId);
    // One id for a builder and the builders derived from it: what another of them loads is kept.
    if (shapes.size) this.#shapes.set(queryId, new Map([...(this.#shapes.get(queryId) ?? []), ...shapes]));
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
  readonly #metadata: SchemaMetadata;
  readonly #shapes: Map<string, Shape>;

  constructor(driver: Driver, metadata: SchemaMetadata, shapes: Map<string, Shape>) {
    super();
    this.#driver = driver;
    this.#metadata = metadata;
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
    if (node.func !== MANY && node.func !== ONE) return super.transformFunction(node, queryId);
    const label = String((node.arguments[1] as ValueNode | undefined)?.value ?? 'A relation');
    const guarded = new SecretGuard(this.#metadata, label).transformNode(node.arguments[0]!, queryId) as SelectQueryNode;
    const subquery = this.transformNode(guarded, queryId);
    const expression = { toOperationNode: () => subquery } as never;
    const many = node.func === MANY;
    const json = this.#driver === 'sqlite' ? (many ? sqliteArray(expression) : sqliteObject(expression)) : many ? pgArray(expression) : pgObject(expression);
    return json.toOperationNode() as unknown as FunctionNode;
  }
}

/**
 * A relation's JSON is never stripped of secret columns the way a top-level row is: so a secret column selected anywhere in a
 * relation's subquery — its table, a joined one, under an alias, through `secret()`, in a subquery of it — is refused, and
 * `selectAll()` below its top level is spelled out without them. Raw SQL is not seen: the developer chose its columns.
 */
class SecretGuard extends OperationNodeTransformer {
  readonly #metadata: SchemaMetadata;
  readonly #label: string;
  #depth = 0;

  constructor(metadata: SchemaMetadata, label: string) {
    super();
    this.#metadata = metadata;
    this.#label = label;
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    // A nested relation is guarded on its own, with its own label.
    return node.func === MANY || node.func === ONE ? node : super.transformFunction(node, queryId);
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const sources = sourcesOf(node);
    const selections = (node.selections ?? []).flatMap((selection) => this.#selection(selection, sources));
    this.#depth++;
    try {
      return super.transformSelectQuery({ ...node, selections }, queryId);
    } finally {
      this.#depth--;
    }
  }

  #selection(node: SelectionNode, sources: readonly Source[]): SelectionNode[] {
    const { selection } = node;
    const all = selection.kind === 'SelectAllNode' ? sources : ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode' ? sources.filter((source) => source.ref === selection.table?.table.identifier.name) : undefined;
    if (all) {
      if (this.#depth === 0) throw new Error('Relations need explicit columns: q.select([…]) instead of selectAll() — the selection is the type.');
      // A subquery's `*` is safe once its own select is: only tables are spelled out.
      return all.flatMap((source) =>
        source.table === undefined
          ? [SelectionNode.createSelectAllFromTable(TableNode.create(source.ref))]
          : (this.#metadata.columns.get(source.table) ?? []).map((column) => SelectionNode.create(ReferenceNode.create(ColumnNode.create(column), TableNode.create(source.ref)))),
      );
    }
    const name = outputName(selection);
    if (name !== undefined) {
      const owner = sources.find((source) => source.table !== undefined && this.#metadata.secrets.get(source.table)?.has(name));
      if (owner) this.#refuse(owner.table!, name);
    }
    this.#references(selection, sources);
    return [node];
  }

  /** Every column the selection reads, down to (not into) subqueries — they are selects of their own. */
  #references(node: unknown, sources: readonly Source[]): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.#references(item, sources);
      return;
    }
    const kind = (node as { kind?: unknown }).kind;
    if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode' || kind === 'SelectQueryNode') return;
    if (kind === 'FunctionNode' && ((node as FunctionNode).func === MANY || (node as FunctionNode).func === ONE)) return;
    if (kind === 'ReferenceNode' && ColumnNode.is((node as ReferenceNode).column)) {
      const reference = node as ReferenceNode;
      this.#check(reference.table?.table.identifier.name, (reference.column as ColumnNode).column.name, sources);
      return;
    }
    if (kind === 'ColumnNode') {
      this.#check(undefined, (node as ColumnNode).column.name, sources);
      return;
    }
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') this.#references(value, sources);
  }

  #check(qualifier: string | undefined, column: string, sources: readonly Source[]): void {
    // A name the select does not know is taken as a table: an outer table's secret is no less secret.
    const tables = qualifier === undefined ? sources.flatMap((source) => (source.table ? [source.table] : [])) : [sources.find((source) => source.ref === qualifier)?.table ?? qualifier];
    const owner = tables.find((table) => this.#metadata.secrets.get(table)?.has(column));
    if (owner) this.#refuse(owner, column);
  }

  #refuse(table: string, column: string): never {
    throw new Error(
      `${this.#label} selects ${table}.${column}, a secret column — a relation never loads one. Read it where it is needed, in a query of ` +
        'its own with secret(eb, …). See docs/queries.md#relations-and-secret-columns.',
    );
  }
}

function outputName(node: OperationNode): string | undefined {
  if (AliasNode.is(node) && IdentifierNode.is(node.alias)) return node.alias.name;
  if (ReferenceNode.is(node) && ColumnNode.is(node.column)) return node.column.column.name;
  if (ColumnNode.is(node)) return node.column.name;
  return undefined;
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
