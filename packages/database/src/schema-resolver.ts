import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  ColumnUpdateNode,
  FunctionNode,
  IdentifierNode,
  OperationNodeTransformer,
  OperatorNode,
  ParensNode,
  RawNode,
  ReferenceNode,
  TableNode,
  UpdateQueryNode,
  ValueNode,
  WhereNode,
  type CompiledQuery,
  type DeleteQueryNode,
  type Expression,
  type Kysely,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryCompiler,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryNode,
  type SqlBool,
  type UnknownRow,
} from 'kysely';
import type { SchemaMetadata } from './metadata.ts';
import { hasPlaceholder, RELATION, SOFT_DELETE, SOFT_DELETE_FILTER, sourcesOf, TOUCH_COLUMN, WITH_TRASHED, type Source } from './placeholders.ts';
import { labelOf, relationQuery, type RelationSpec, type RelationsPlugin } from './relations.ts';
import { outputName } from './secret-guard.ts';

// Placeholders for what only the schema metadata knows — whether a table has soft deletes or timestamps, which relations its
// foreign keys describe and which columns they may load. A query is built synchronously, often before anything was loaded (the
// first query of a process, right after a migration); the placeholders are resolved when it compiles, or — while the metadata
// is not fresh — by the connection that runs it, after loading. One that reaches a connection without Marmeon's plugins is
// refused there (`serialQueries`), and fails at the database if it gets that far, instead of reading wrong rows.

/** Where a placeholder stood and now nothing does: dropped from its AND chain, `1 = 1` anywhere else. */
const NOTHING = RawNode.createWithSql('1 = 1');

class Placeholder implements Expression<SqlBool> {
  readonly #node: FunctionNode;

  constructor(func: string, table: string) {
    this.#node = FunctionNode.create(func, [ValueNode.createImmediate(table)]);
  }

  get expressionType(): SqlBool | undefined {
    return undefined;
  }

  toOperationNode(): OperationNode {
    return this.#node;
  }
}

/** For `.where()`: leaves out the rows of `table` that are soft-deleted — if its migration called `softDeletes()`. */
export function softDeleteFilter(table: string): Expression<SqlBool> {
  return new Placeholder(SOFT_DELETE_FILTER, table);
}

/** For a `deleteFrom(table)`'s `.where()`: deletes softly — sets `deleted_at` — if the table's migration called `softDeletes()`. */
export function softDelete(table: string): Expression<SqlBool> {
  return new Placeholder(SOFT_DELETE, table);
}

/** For `.where()`: the select it is in keeps its soft-deleted rows (`withTrashed()`). */
export function withTrashed(): Expression<SqlBool> {
  return new Placeholder(WITH_TRASHED, '');
}

/**
 * Resolves the placeholders while compiling when the metadata is fresh; otherwise it leaves them for the connection
 * ({@link SchemaResolver.deferred}, {@link SchemaResolver.resolve}), which loads the metadata first. A query that reads rows (a
 * select, a `returning`) waits the same way while the metadata is not fresh: its secret columns must be the ones of the schema it
 * runs against.
 */
export class SchemaResolver implements KyselyPlugin {
  readonly #metadata: SchemaMetadata;
  readonly #compiler: QueryCompiler;
  readonly #relations: RelationsPlugin;
  /**
   * The queries left for the connection. A query id belongs to a builder and every builder derived from it, so two
   * executions of one builder share it: kept, never taken out. A query of another `Kysely` on the same physical connection
   * (an infrastructure connection on SQLite) was never added — its placeholders are refused on the connection.
   */
  readonly #deferred = new WeakSet<QueryId>();

  constructor(metadata: SchemaMetadata, compiler: QueryCompiler, relations: RelationsPlugin) {
    this.#metadata = metadata;
    this.#compiler = compiler;
    this.#relations = relations;
  }

  /** What the connection knows about its schema — what this plugin resolves with. */
  get metadata(): SchemaMetadata {
    return this.#metadata;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    if (!hasPlaceholder(node)) {
      // What it reads is checked against the secret columns (`guardSecrets`) and stripped of them: with the schema it runs against.
      if (!this.#metadata.fresh && readsRows(node)) this.#deferred.add(queryId);
      return node;
    }
    // A soft delete turns the DELETE into an UPDATE, which a plugin may not do (Kysely checks the kind): the connection does it.
    if (!this.#metadata.fresh || (node.kind === 'DeleteQueryNode' && hasPlaceholder(node.where, SOFT_DELETE))) {
      this.#deferred.add(queryId);
      return node;
    }
    // The relations' JSON is built by the next plugin, `RelationsPlugin`.
    return resolve(node, this.#metadata);
  }

  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result;
  }

  /** Whether `query` was left for the connection to resolve (it may hold placeholders, or wait for the metadata only). */
  deferred(query: CompiledQuery): boolean {
    return this.#deferred.has(query.queryId);
  }

  /** The query with its placeholders resolved — called on the connection, once the metadata is loaded there. */
  resolve(query: CompiledQuery): CompiledQuery {
    // A builder deferred once keeps its id: a later compile of it, made while the metadata was fresh, is resolved and checked
    // already (`RelationsPlugin` returns such a node as it is) — only a soft delete is still to be done.
    const resolved = hasPlaceholder(query.query) ? resolve(query.query, this.#metadata) : query.query;
    const node = this.#relations.transform(resolved, query.queryId);
    return node === query.query ? query : this.#compiler.compileQuery(node, query.queryId);
  }
}

/**
 * The schema metadata of the connection `db` runs on (a transaction's too) — as far as it is loaded: after a query on it has run.
 * `undefined` on a connection without Marmeon's plugins.
 */
export function metadataOf(db: Pick<Kysely<any>, 'getExecutor'>): SchemaMetadata | undefined {
  return db.getExecutor().plugins.find((plugin): plugin is SchemaResolver => plugin instanceof SchemaResolver)?.metadata;
}

function resolve(node: RootOperationNode, metadata: SchemaMetadata): RootOperationNode {
  const root = node.kind === 'DeleteQueryNode' ? softly(node, metadata) : node;
  return new Resolver(metadata).transformNode(root);
}

/**
 * A delete with the soft-delete placeholder, on a table with soft deletes: `update … set deleted_at = now where … and deleted_at
 * is null`. It keeps the table, `with`, `where` and `returning` only — a delete with anything else is refused, never cut down.
 */
function softly(node: DeleteQueryNode, metadata: SchemaMetadata): RootOperationNode {
  const table = tableOf(node.from.froms[0]);
  if (!node.where || !table || !metadata.softDeletes.has(table) || !hasPlaceholder(node.where, SOFT_DELETE)) return node;
  const extra = (['using', 'joins', 'orderBy', 'limit', 'top', 'output', 'explain', 'endModifiers'] as const).filter((part) => node[part] !== undefined);
  if (node.from.froms.length !== 1 || !TableNode.is(node.from.froms[0]!) || extra.length) {
    throw new Error(`A soft delete of "${table}" runs as an update of the table by its WHERE; it cannot keep ${extra.length ? extra.join(', ') : 'an alias or a second table'}.`);
  }
  const update = UpdateQueryNode.create([TableNode.create(table)], node.with);
  return {
    ...update,
    updates: [ColumnUpdateNode.create(ColumnNode.create('deleted_at'), ValueNode.create(new Date()))],
    where: WhereNode.create(AndNode.create(node.where.where, notDeleted(table))),
    ...(node.returning ? { returning: node.returning } : {}),
  };
}

/** A select's tables, and whether it called `withTrashed()`. */
interface Frame {
  readonly sources: readonly Source[];
  readonly trashed: boolean;
}

class Resolver extends OperationNodeTransformer {
  readonly #metadata: SchemaMetadata;
  /** The selects around the node being transformed — the innermost last. */
  readonly #frames: Frame[] = [];
  #aliases = 0;

  constructor(metadata: SchemaMetadata) {
    super();
    this.#metadata = metadata;
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    if (node.func === SOFT_DELETE_FILTER) {
      const table = String((node.arguments[0] as ValueNode).value);
      const filtered = this.#metadata.softDeletes.has(table) && !this.#frames.at(-1)?.trashed;
      return (filtered ? notDeleted(table) : NOTHING) as unknown as FunctionNode;
    }
    // A soft delete is done by `softly()` (or it is a hard one); `withTrashed()` was read by its select.
    if (node.func === SOFT_DELETE || node.func === WITH_TRASHED) return NOTHING as unknown as FunctionNode;
    if (node.func === RELATION) {
      // Top-down: the relation's subquery is built in the scope of the select it is in, then resolved as a select of its own.
      const { query, wrap } = relationQuery(node, this.#frames.at(-1)?.sources ?? [], this.#metadata, (table) => `${table}__${++this.#aliases}`);
      return wrap(this.transformNode(query, queryId)) as unknown as FunctionNode;
    }
    return super.transformFunction(node, queryId);
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    refuseTaken(node, this.#metadata);
    this.#frames.push({ sources: sourcesOf(node), trashed: hasPlaceholder(node.where, WITH_TRASHED, true) });
    try {
      return withoutNothing(super.transformSelectQuery(isolated(node), queryId));
    } finally {
      this.#frames.pop();
    }
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    return withoutNothing(super.transformDeleteQuery(isolated(node), queryId));
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    const transformed = withoutNothing(super.transformUpdateQuery(isolated(node), queryId));
    const updates = transformed.updates ?? [];
    const touch = updates.find((update) => ColumnNode.is(update.column) && update.column.column.name === TOUCH_COLUMN);
    if (!touch) return transformed;
    const table = tableOf(transformed.table);
    const explicit = updates.some((update) => ColumnNode.is(update.column) && update.column.column.name === 'updated_at');
    const kept =
      table && this.#metadata.timestamps.has(table) && !explicit
        ? updates.map((update) => (update === touch ? ColumnUpdateNode.create(ColumnNode.create('updated_at'), update.value) : update))
        : updates.filter((update) => update !== touch);
    return { ...transformed, updates: kept };
  }
}

/**
 * A relation (`with()`, `withCount()`) may not take a name the select has already — its own selections, the columns of its
 * `selectAll()`: the row would hold two values under one name, and one of them would be lost.
 */
function refuseTaken(node: SelectQueryNode, metadata: SchemaMetadata): void {
  const selections = node.selections ?? [];
  const relations = selections.flatMap(({ selection }) =>
    AliasNode.is(selection) && IdentifierNode.is(selection.alias) && FunctionNode.is(selection.node) && selection.node.func === RELATION ? [{ name: selection.alias.name, marker: selection.node }] : [],
  );
  if (relations.length === 0) return;
  const sources = sourcesOf(node);
  const columnsOf = (source: Source | undefined) => [...((source?.table && metadata.kinds.get(source.table)?.keys()) || [])];
  const names: string[] = [];
  for (const { selection } of selections) {
    if (selection.kind === 'SelectAllNode') names.push(...sources.flatMap(columnsOf));
    else if (ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode') names.push(...columnsOf(sources.find((source) => source.ref === selection.table?.table.identifier.name)));
    else {
      const name = outputName(selection);
      if (name !== undefined) names.push(name);
    }
  }
  for (const { name, marker } of relations) {
    if (names.filter((other) => other === name).length > 1) {
      const label = labelOf(JSON.parse(String((marker.arguments[0] as ValueNode).value)) as RelationSpec);
      throw new Error(`${label} adds "${name}", which the query selects already — give it another name with { as }.`);
    }
  }
}

/** Whether a statement reads rows — a select, a `returning` (of a merge too), or a select inside (`insert … select`) — whose secret columns are checked. */
function readsRows(node: RootOperationNode): boolean {
  if (node.kind === 'SelectQueryNode') return true;
  if (node.kind !== 'InsertQueryNode' && node.kind !== 'UpdateQueryNode' && node.kind !== 'DeleteQueryNode' && node.kind !== 'MergeQueryNode') return false;
  return node.returning !== undefined || hasSelect(node);
}

function hasSelect(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasSelect);
  const kind = (node as { kind?: unknown }).kind;
  if (kind === 'SelectQueryNode') return true;
  if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode') return false;
  return Object.values(node).some((value) => value !== null && typeof value === 'object' && hasSelect(value));
}

function notDeleted(table: string): OperationNode {
  return BinaryOperationNode.create(ReferenceNode.create(ColumnNode.create('deleted_at'), TableNode.create(table)), OperatorNode.create('is'), ValueNode.createImmediate(null));
}

/** The query without the conditions a resolved placeholder left as {@link NOTHING} in its AND chain. */
function withoutNothing<N extends { readonly where?: WhereNode }>(node: N): N {
  if (!node.where) return node;
  const where = drop(node.where.where);
  if (where === node.where.where) return node;
  if (where === NOTHING) {
    const { where: _, ...rest } = node;
    return rest as N;
  }
  return { ...node, where: WhereNode.create(where) };
}

/**
 * The statement with the conditions next to its soft-delete filter in parentheses: `where(sql\`a or b\`)` after `query()` must stay
 * `deleted_at is null and (a or b)`, never `deleted_at is null and a or b`.
 */
function isolated<N extends { readonly where?: WhereNode }>(node: N): N {
  if (!node.where) return node;
  const operands: OperationNode[] = [];
  const flatten = (operand: OperationNode): void => {
    if (AndNode.is(operand)) {
      flatten(operand.left);
      flatten(operand.right);
    } else operands.push(operand);
  };
  flatten(node.where.where);
  const marks = operands.filter((operand) => FunctionNode.is(operand) && (operand.func === SOFT_DELETE_FILTER || operand.func === WITH_TRASHED || operand.func === SOFT_DELETE));
  const rest = operands.filter((operand) => !marks.includes(operand));
  if (marks.length === 0 || rest.length === 0) return node;
  const conditions = rest.reduce((left, right) => AndNode.create(left, right));
  return { ...node, where: WhereNode.create([...marks, ParensNode.create(conditions)].reduce((left, right) => AndNode.create(left, right))) };
}

function drop(node: OperationNode): OperationNode {
  if (ParensNode.is(node)) {
    const inner = drop(node.node);
    return inner === NOTHING ? NOTHING : inner === node.node ? node : ParensNode.create(inner);
  }
  if (!AndNode.is(node)) return node;
  const left = drop(node.left);
  const right = drop(node.right);
  if (left === NOTHING) return right;
  if (right === NOTHING) return left;
  return left === node.left && right === node.right ? node : AndNode.create(left, right);
}

function tableOf(node: OperationNode | undefined): string | undefined {
  if (node && TableNode.is(node)) return node.table.identifier.name;
  if (node && AliasNode.is(node) && TableNode.is(node.node)) return node.node.table.identifier.name;
  return undefined;
}
