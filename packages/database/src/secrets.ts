import { TableNode } from 'kysely';
import type {
  AliasedExpression,
  ColumnType,
  ExpressionBuilder,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  RootOperationNode,
  SelectionNode,
  UnknownRow,
  UpdateType,
} from 'kysely';
import type { SchemaMetadata } from './metadata.ts';

/**
 * A column its migration marked `.secret()` (a password hash, a 2FA secret): written like any
 * column, but never read by accident. Kysely's `Selectable` — and so `Row<'users'>` — leaves it out,
 * and at runtime the connection removes it from every `selectAll()` and `returningAll()` result.
 * Reading it takes {@link secret}.
 */
export type Secret<T> = ColumnType<never, T, T>;

type IsSecret<C> = [C] extends [ColumnType<infer S, any, infer U>] ? ([S] extends [never] ? ([U] extends [never] ? false : true) : false) : false;

/** The secret columns of the tables in scope: `'password'` or `'users.password'`. */
export type SecretReference<DB, TB extends keyof DB> = {
  [T in TB & string]: { [C in keyof DB[T] & string]: IsSecret<DB[T][C]> extends true ? C | `${T}.${C}` : never }[keyof DB[T] & string];
}[TB & string];

type SecretName<R extends string> = R extends `${string}.${infer C}` ? C : R;
type SecretValue<DB, TB extends keyof DB, R extends string> = R extends `${infer T}.${infer C}`
  ? T extends TB ? (C extends keyof DB[T] ? UpdateType<DB[T][C]> : never) : never
  : { [T in TB]: R extends keyof DB[T] ? UpdateType<DB[T][R]> : never }[TB];

/**
 * Reads a secret column — deliberately, where it is needed (checking a password at login):
 *
 * ```ts
 * this.query().select((eb) => ['id', secret(eb, 'password')]).where('email', '=', email)
 * ```
 */
export function secret<DB, TB extends keyof DB, R extends SecretReference<DB, TB>>(
  eb: ExpressionBuilder<DB, TB>,
  column: R,
): AliasedExpression<SecretValue<DB, TB, R>, SecretName<R>> {
  const name = column.slice(column.lastIndexOf('.') + 1);
  return eb.ref(column as never).as(name) as never;
}

interface Plan {
  /** Every table the query touches. */
  readonly tables: ReadonlySet<string>;
  /** Names the query selects or returns explicitly (`secret(eb, 'password')`, `select('id')`). */
  readonly explicit: ReadonlySet<string>;
}

/**
 * Removes secret columns from the results of queries that select or return `*` — at any depth
 * (a subquery's `selectAll()` passes its columns up). Explicitly selected names stay. Raw SQL
 * (`sql\`select * …\``) is not seen: the developer chose its columns.
 */
export class SecretColumnsPlugin implements KyselyPlugin {
  readonly #metadata: SchemaMetadata;
  readonly #plans = new WeakMap<QueryId, Plan>();

  constructor(metadata: SchemaMetadata) {
    this.#metadata = metadata;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    const plan = planOf(node);
    if (plan) this.#plans.set(queryId, plan);
    return node;
  }

  async transformResult({ result, queryId }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const plan = this.#plans.get(queryId);
    if (!plan || result.rows.length === 0) return result;
    const strip: string[] = [];
    for (const table of plan.tables) {
      for (const column of this.#metadata.secrets.get(table) ?? []) if (!plan.explicit.has(column)) strip.push(column);
    }
    if (strip.length) for (const row of result.rows) for (const column of strip) delete (row as Record<string, unknown>)[column];
    return result;
  }
}

/** Whether the connection strips secret columns from the statement's result — it selects or returns `*` somewhere. */
export function selectsAll(node: RootOperationNode): boolean {
  return planOf(node) !== undefined;
}

function planOf(node: RootOperationNode): Plan | undefined {
  const root = rootSelections(node);
  if (!root) return undefined;
  const tables = new Set<string>();
  let selectsAll = false;
  walk(node, (child) => {
    if (child.kind === 'SelectAllNode') selectsAll = true;
    else if (TableNode.is(child)) tables.add(child.table.identifier.name);
  });
  if (!selectsAll) return undefined;
  const explicit = new Set<string>();
  for (const { selection } of root) {
    const name = outputName(selection);
    if (name) explicit.add(name);
  }
  return { tables, explicit };
}

function rootSelections(node: RootOperationNode): readonly SelectionNode[] | undefined {
  if (node.kind === 'SelectQueryNode') return node.selections ?? [];
  if (node.kind === 'InsertQueryNode' || node.kind === 'UpdateQueryNode' || node.kind === 'DeleteQueryNode') return node.returning?.selections;
  return undefined;
}

function outputName(node: OperationNode): string | undefined {
  const n = node as { kind: string; alias?: { kind: string; name?: string }; column?: { kind: string; column?: { name: string }; name?: string } };
  if (n.kind === 'AliasNode') return n.alias?.kind === 'IdentifierNode' ? n.alias.name : undefined;
  if (n.kind === 'ReferenceNode') return n.column?.kind === 'ColumnNode' ? n.column.column?.name : undefined;
  if (n.kind === 'ColumnNode') return (n as unknown as { column: { name: string } }).column.name;
  return undefined;
}

/** Visits every operation node below `node` (nodes are plain frozen objects with a `kind`). */
function walk(node: unknown, visit: (node: OperationNode) => void): void {
  if (ArrayBuffer.isView(node)) return; // a binary parameter — nothing to visit, possibly large
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node !== null && typeof node === 'object') {
    if (typeof (node as { kind?: unknown }).kind === 'string') visit(node as OperationNode);
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') walk(value, visit);
  }
}
