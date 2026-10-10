import { AliasNode, IdentifierNode, TableNode, type ColumnNode, type FunctionNode, type OperationNode, type SelectQueryNode } from 'kysely';

// The names of the placeholders the chain and the repository put into a query for what only the schema metadata knows (see
// `SchemaResolver`). They all start with one prefix, which nothing else in a query does: a connection without Marmeon's
// plugins refuses a query that still holds one (`serialQueries`), and the database would fail on the name.

/** What every placeholder's name starts with — and nothing else's. */
export const PREFIX = '__marmeon_unresolved_';
/** In a WHERE: `"table"."deleted_at" is null` when the table has soft deletes, nothing otherwise. */
export const SOFT_DELETE_FILTER = `${PREFIX}soft_delete_filter__`;
/** In a DELETE's WHERE: the statement becomes `update … set deleted_at` when the table has soft deletes. */
export const SOFT_DELETE = `${PREFIX}soft_delete__`;
/** A column of an UPDATE's SET: becomes `updated_at` when the table has timestamps (and the update does not set it). */
export const TOUCH_COLUMN = `${PREFIX}updated_at__`;
/** In a select's WHERE (`withTrashed()`): that select's soft-delete filters — its own, a relation's — are left out. */
export const WITH_TRASHED = `${PREFIX}with_trashed__`;
/** A selection (`with()`, `withRelation()`): becomes the relation's subquery, by what it names and the callback's query. */
export const RELATION = `${PREFIX}relation_needs_the_apps_connection__`;
/** The table a relation callback's query starts from — the relation's table, once it is resolved. */
export const RELATION_TARGET = `${PREFIX}relation_target__`;
/** A relation's subquery, resolved: turned into the dialect's JSON array (many) or object (one) by `RelationsPlugin`. */
export const MANY = `${PREFIX}relation_many__`;
export const ONE = `${PREFIX}relation_one__`;
/** A selection `secret()` asked for: the column it holds may leave the query (see `secret-guard.ts`), then it is the column itself. */
export const SECRET = `${PREFIX}secret__`;

/**
 * Whether a placeholder is anywhere below `node` — without serializing it (every query of the app passes here). `shallow`
 * stops at subqueries: only the select the node belongs to.
 */
export function hasPlaceholder(node: unknown, func?: string | readonly string[], shallow = false): boolean {
  if (node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => hasPlaceholder(item, func, shallow));
  const kind = (node as { kind?: unknown }).kind;
  // Values hold data, never nodes of the query (and may be large).
  if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode') return false;
  if (shallow && kind === 'SelectQueryNode') return false;
  if (kind === 'FunctionNode') {
    const name = (node as FunctionNode).func;
    if (func === undefined ? name.startsWith(PREFIX) : typeof func === 'string' ? name === func : func.includes(name)) return true;
  }
  if (!func && kind === 'ColumnNode' && (node as ColumnNode).column.name.startsWith(PREFIX)) return true;
  for (const value of Object.values(node)) if (value !== null && typeof value === 'object' && hasPlaceholder(value, func, shallow)) return true;
  return false;
}

/** A table of a select — or a subquery in its FROM or a join, which has no table. */
export interface Source {
  readonly table?: string;
  /** The name the select refers to it by: its alias, or the table's name. */
  readonly ref: string;
  /** A subquery's node. */
  readonly query?: OperationNode;
}

/** The tables of a select's FROM and joins. */
export function sourcesOf(node: SelectQueryNode): Source[] {
  const items = [...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)];
  return items.flatMap((item): Source[] => {
    if (TableNode.is(item)) return [{ table: item.table.identifier.name, ref: item.table.identifier.name }];
    if (AliasNode.is(item) && IdentifierNode.is(item.alias)) {
      return [TableNode.is(item.node) ? { table: item.node.table.identifier.name, ref: item.alias.name } : { ref: item.alias.name, query: item.node }];
    }
    return [];
  });
}
