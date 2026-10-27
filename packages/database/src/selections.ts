import { AliasNode, IdentifierNode, type KyselyPlugin, type RootOperationNode } from 'kysely';
import { isSecretSelection } from './secret-guard.ts';
import type { SelectQuery } from './builder.ts';

/**
 * The names of the values a query selects itself under an alias (`withCount(…, { as })`, `eb.fn(…).as(…)`): a column of such a name
 * reads that value, and SQL refers to it by name only in `ORDER BY`. A `secret()` is never one of them: it is in `secret`.
 */
export function selectionsOf(query: SelectQuery<any, any, any>): { selected: ReadonlySet<string>; secret: ReadonlySet<string> } {
  const selected = new Set<string>();
  const secret = new Set<string>();
  for (const { selection } of query.toOperationNode().selections ?? []) {
    if (AliasNode.is(selection) && IdentifierNode.is(selection.alias)) (isSecretSelection(selection) ? secret : selected).add(selection.alias.name);
  }
  return { selected, secret };
}

/** The query without the values it selects under these names — whatever builds on it, as a subquery too. */
export function leaveOutSelections<Q extends SelectQuery<any, any, any>>(query: Q, names: ReadonlySet<string>): Q {
  return names.size > 0 ? (query.withPlugin(new LeaveOut(names)) as Q) : query;
}

/** Leaves the values of hidden columns out of the base query's own selections — whatever builds on it, as a subquery too. */
class LeaveOut implements KyselyPlugin {
  readonly #names: ReadonlySet<string>;

  constructor(names: ReadonlySet<string>) {
    this.#names = names;
  }

  transformQuery({ node }: { node: RootOperationNode }): RootOperationNode {
    if (node.kind !== 'SelectQueryNode' || !node.selections) return node;
    const kept = node.selections.filter(({ selection }) => !(AliasNode.is(selection) && IdentifierNode.is(selection.alias) && this.#names.has(selection.alias.name)));
    return kept.length === node.selections.length ? node : { ...node, selections: kept };
  }

  async transformResult<R>({ result }: { result: R }): Promise<R> {
    return result;
  }
}
