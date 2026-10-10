import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  ColumnUpdateNode,
  FunctionNode,
  OperationNodeTransformer,
  OperatorNode,
  RawNode,
  ReferenceNode,
  TableNode,
  UpdateQueryNode,
  ValueNode,
  WhereNode,
  type CompiledQuery,
  type DeleteQueryNode,
  type Expression,
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

// Placeholders for what only the schema metadata knows — whether a table has soft deletes or timestamps. A query is built
// synchronously, often before anything was loaded (the first query of a process, right after a migration); the placeholders
// are resolved when it compiles, or — while the metadata is not fresh — by the connection that runs it, after loading.
// One that reaches the database unresolved (a connection without Marmeon's plugins) fails there instead of reading wrong rows.

const PREFIX = '__marmeon_unresolved_';
/** In a WHERE: `"table"."deleted_at" is null` when the table has soft deletes, nothing otherwise. */
const SOFT_DELETE_FILTER = `${PREFIX}soft_delete_filter__`;
/** In a DELETE's WHERE: the statement becomes `update … set deleted_at` when the table has soft deletes. */
const SOFT_DELETE = `${PREFIX}soft_delete__`;
/** A column of an UPDATE's SET: becomes `updated_at` when the table has timestamps (and the update does not set it). */
export const TOUCH_COLUMN = `${PREFIX}updated_at__`;

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

/**
 * Resolves the placeholders while compiling when the metadata is fresh; otherwise it leaves them for the connection
 * ({@link SchemaResolver.deferred}, {@link SchemaResolver.resolve}), which loads the metadata first.
 */
export class SchemaResolver implements KyselyPlugin {
  readonly #metadata: SchemaMetadata;
  readonly #compiler: QueryCompiler;
  /**
   * The queries left for the connection. A query id belongs to a builder and every builder derived from it, so two
   * executions of one builder share it: kept, never taken out. A query of another `Kysely` on the same physical connection
   * (an infrastructure connection on SQLite) was never added — its placeholders reach the database and fail there.
   */
  readonly #deferred = new WeakSet<QueryId>();

  constructor(metadata: SchemaMetadata, compiler: QueryCompiler) {
    this.#metadata = metadata;
    this.#compiler = compiler;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    if (!hasPlaceholder(node)) return node;
    // A soft delete turns the DELETE into an UPDATE, which a plugin may not do (Kysely checks the kind): the connection does it.
    if (!this.#metadata.fresh || (node.kind === 'DeleteQueryNode' && hasPlaceholder(node.where, SOFT_DELETE))) {
      this.#deferred.add(queryId);
      return node;
    }
    return resolve(node, this.#metadata);
  }

  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result;
  }

  /** Whether `query` still holds placeholders this plugin left for the connection to resolve. */
  deferred(query: CompiledQuery): boolean {
    return query.sql.includes(PREFIX) && this.#deferred.has(query.queryId);
  }

  /** The query with its placeholders resolved — called on the connection, once the metadata is loaded there. */
  resolve(query: CompiledQuery): CompiledQuery {
    return this.#compiler.compileQuery(resolve(query.query, this.#metadata), query.queryId);
  }
}

function resolve(node: RootOperationNode, metadata: SchemaMetadata): RootOperationNode {
  const root = node.kind === 'DeleteQueryNode' ? softly(node, metadata) : node;
  return new Resolver(metadata).transformNode(root);
}

/** A delete with the soft-delete placeholder, on a table with soft deletes: `update … set deleted_at = now where … and deleted_at is null`. */
function softly(node: DeleteQueryNode, metadata: SchemaMetadata): RootOperationNode {
  const table = tableOf(node.from.froms[0]);
  if (!node.where || !table || !metadata.softDeletes.has(table) || !hasPlaceholder(node.where, SOFT_DELETE)) return node;
  const update = UpdateQueryNode.create([TableNode.create(table)], node.with);
  return {
    ...update,
    updates: [ColumnUpdateNode.create(ColumnNode.create('deleted_at'), ValueNode.create(new Date()))],
    where: WhereNode.create(AndNode.create(node.where.where, notDeleted(table))),
    ...(node.returning ? { returning: node.returning } : {}),
  };
}

class Resolver extends OperationNodeTransformer {
  readonly #metadata: SchemaMetadata;

  constructor(metadata: SchemaMetadata) {
    super();
    this.#metadata = metadata;
  }

  protected override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    if (node.func === SOFT_DELETE_FILTER) {
      const table = String((node.arguments[0] as ValueNode).value);
      return (this.#metadata.softDeletes.has(table) ? notDeleted(table) : NOTHING) as unknown as FunctionNode;
    }
    if (node.func === SOFT_DELETE) return NOTHING as unknown as FunctionNode; // done by `softly()` — or a hard delete
    return super.transformFunction(node, queryId);
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    return withoutNothing(super.transformSelectQuery(node, queryId));
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    return withoutNothing(super.transformDeleteQuery(node, queryId));
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    const transformed = withoutNothing(super.transformUpdateQuery(node, queryId));
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

function drop(node: OperationNode): OperationNode {
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

/** Whether a placeholder is anywhere below `node` — without serializing it (every query of the app passes here). */
function hasPlaceholder(node: unknown, func?: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => hasPlaceholder(item, func));
  const kind = (node as { kind?: unknown }).kind;
  // Values hold data, never nodes of the query (and may be large).
  if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode') return false;
  if (kind === 'FunctionNode' && (func ? (node as FunctionNode).func === func : (node as FunctionNode).func.startsWith(PREFIX))) return true;
  if (!func && kind === 'ColumnNode' && (node as ColumnNode).column.name.startsWith(PREFIX)) return true;
  for (const value of Object.values(node)) if (value !== null && typeof value === 'object' && hasPlaceholder(value, func)) return true;
  return false;
}
