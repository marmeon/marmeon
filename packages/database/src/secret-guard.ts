import {
  AliasNode,
  ColumnNode,
  FunctionNode,
  IdentifierNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  type DeleteQueryNode,
  type InsertQueryNode,
  type OperationNode,
  type ReturningNode,
  type RootOperationNode,
  type UpdateQueryNode,
  type ValueNode,
  type WithNode,
} from 'kysely';
import type { SchemaMetadata } from './metadata.ts';
import { MANY, ONE, SECRET } from './placeholders.ts';

// A secret column leaves the database only where a query asks for it with `secret()`. Every source of a query — a table, a common
// table expression, a subquery — carries the secret columns it outputs; any reference to one of them, or to a whole row of a source
// that carries one, is refused unless its selection is `secret()`, at every level that passes it on, and never in a relation.

/** What a select (a subquery, a common table expression) outputs: its column names, and which of them carry a secret. */
interface Output {
  readonly names: readonly string[];
  readonly secret: ReadonlySet<string>;
  /** A statement's `returning` as a common table expression: not followed. */
  readonly untyped?: boolean;
}

/** A table, common table expression or subquery a select reads from, under the name it is referred to by. */
interface Source {
  readonly ref: string;
  /** A table of the migrations, by name. */
  readonly table?: string;
  /** Its output columns — `undefined` when they are not known (a table nobody migrated). */
  readonly names?: readonly string[];
  readonly secret: ReadonlySet<string>;
  /** Raw SQL or a function in FROM: its columns cannot be checked. */
  readonly untyped?: boolean;
}

/** What the guard changes: selections spelled out without secret columns, by the select (or returning) they belong to. */
export type Spelled = ReadonlyMap<OperationNode, readonly SelectionNode[]>;

/**
 * Checks `root` against the secret columns of the schema and returns where `selectAll()` of a source that carries a secret column
 * must be spelled out without it, at every depth. Throws when the query reads a secret column it did not ask for with `secret()`,
 * a whole row of a source that carries one, a secret column in a relation, or a source it cannot check.
 */
export function guardSecrets(root: RootOperationNode, metadata: SchemaMetadata): Spelled {
  const guard = new Guard(metadata);
  guard.root(root);
  return guard.spelled;
}

class Guard {
  readonly #metadata: SchemaMetadata;
  readonly spelled = new Map<OperationNode, readonly SelectionNode[]>();
  /** The sources of the selects around the node being checked — innermost last. */
  readonly #scopes: Source[][] = [];
  /** The common table expressions in scope, by name — innermost last. */
  readonly #ctes: Map<string, Output>[] = [];
  /** The relation being checked (its label), and whether the next select is its top level. */
  #relation: string | undefined;
  #top = false;

  constructor(metadata: SchemaMetadata) {
    this.#metadata = metadata;
  }

  root(node: RootOperationNode): void {
    if (node.kind === 'SelectQueryNode') this.#select(node);
    else if (node.kind === 'InsertQueryNode' || node.kind === 'UpdateQueryNode' || node.kind === 'DeleteQueryNode') this.#write(node);
    else this.#scan(node);
  }

  #select(node: SelectQueryNode): Output {
    const top = this.#top;
    this.#top = false;
    const ctes = this.#with(node.with);
    const sources: Source[] = [];
    this.#scopes.push(sources);
    try {
      // A joined subquery may refer to the sources before it (lateral): each sees the ones already known.
      for (const item of [...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)]) sources.push(this.#source(item));
      // Conditions and orders read columns, but nothing of them leaves the database: only their subqueries are checked.
      this.#scan([node.joins?.map((join) => join.on), node.where, node.groupBy, node.having, node.orderBy, node.distinctOn]);
      const output = this.#selections(node, node.selections ?? [], sources, top);
      for (const operation of node.setOperations ?? []) {
        const other = this.#select(operation.expression as SelectQueryNode);
        // A union's columns are named by its first select, by position.
        other.names.forEach((name, at) => {
          if (other.secret.has(name) && output.names[at] !== undefined) output.secret.add(output.names[at]!);
        });
      }
      return output;
    } finally {
      this.#scopes.pop();
      if (ctes) this.#ctes.pop();
    }
  }

  #write(node: InsertQueryNode | UpdateQueryNode | DeleteQueryNode): void {
    const ctes = this.#with(node.with);
    const items =
      node.kind === 'InsertQueryNode'
        ? [node.into]
        : node.kind === 'UpdateQueryNode'
          ? [node.table, ...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)]
          : [...node.from.froms, ...(node.using?.tables ?? []), ...(node.joins ?? []).map((join) => join.table)];
    const sources: Source[] = [];
    this.#scopes.push(sources);
    try {
      for (const item of items) if (item) sources.push(this.#source(item));
      const { returning, with: _, ...rest } = node as typeof node & { returning?: ReturningNode };
      this.#scan(Object.values(rest));
      if (returning) this.#selections(returning, returning.selections, sources, false);
    } finally {
      this.#scopes.pop();
      if (ctes) this.#ctes.pop();
    }
  }

  /** Registers a statement's common table expressions, each seeing the ones before it (and a recursive one itself). */
  #with(node: WithNode | undefined): boolean {
    if (!node) return false;
    const ctes = new Map<string, Output>();
    this.#ctes.push(ctes);
    for (const { name, expression } of node.expressions) {
      const table = name.table.table.identifier.name;
      const named = name.columns?.map((column) => column.column.name);
      ctes.set(table, { names: named ?? [], secret: new Set() });
      if (!SelectQueryNode.is(expression)) {
        // A statement with `returning` as a common table expression: its columns are not followed — it cannot be read from.
        this.#scan(expression);
        ctes.set(table, { names: [], secret: new Set(), untyped: true });
        continue;
      }
      const output = this.#select(expression);
      const names = named ?? output.names;
      ctes.set(table, { names, secret: new Set(output.names.flatMap((own, at) => (output.secret.has(own) && names[at] !== undefined ? [names[at]!] : []))) });
    }
    return true;
  }

  #source(item: OperationNode): Source {
    const alias = AliasNode.is(item) && IdentifierNode.is(item.alias) ? item.alias.name : undefined;
    const node = AliasNode.is(item) ? item.node : item;
    if (TableNode.is(node)) {
      const name = node.table.identifier.name;
      const ref = alias ?? name;
      const cte = this.#cte(name);
      if (cte) return { ref, names: cte.names, secret: cte.secret, ...(cte.untyped ? { untyped: true } : {}) };
      const kinds = this.#metadata.kinds.get(name);
      return { ref, table: name, ...(kinds ? { names: [...kinds.keys()] } : {}), secret: this.#metadata.secrets.get(name) ?? new Set() };
    }
    if (SelectQueryNode.is(node)) {
      const output = this.#select(node);
      return { ref: alias ?? '', names: output.names, secret: output.secret };
    }
    this.#scan(node);
    return { ref: alias ?? '', secret: new Set(), untyped: true };
  }

  #cte(name: string): Output | undefined {
    for (const ctes of this.#ctes.toReversed()) {
      const cte = ctes.get(name);
      if (cte) return cte;
    }
    return undefined;
  }

  /** Checks the selections of a select (or a returning), and records them spelled out where they must be. */
  #selections(owner: OperationNode, selections: readonly SelectionNode[], sources: readonly Source[], top: boolean): MutableOutput {
    const output: MutableOutput = { names: [], secret: new Set() };
    const kept: SelectionNode[] = [];
    let changed = false;
    for (const node of selections) {
      const { selection } = node;
      const all = selection.kind === 'SelectAllNode' ? sources : ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode' ? [this.#resolve(selection.table!.table.identifier.name)] : undefined;
      if (all) {
        // At a relation's top level the chain spelled it out already; the free helpers ask for the columns.
        if (this.#relation !== undefined && top) throw new Error('Relations need explicit columns: q.select([…]) instead of selectAll() — the selection is the type.');
        for (const source of all) if (source.untyped) this.#untyped(source);
        if (all.every((source) => source.secret.size === 0)) {
          kept.push(node);
          for (const source of all) output.names.push(...(source.names ?? []));
          continue;
        }
        changed = true;
        for (const source of all) {
          if (source.secret.size === 0) {
            kept.push(SelectionNode.createSelectAllFromTable(TableNode.create(source.ref)));
            output.names.push(...(source.names ?? []));
            continue;
          }
          for (const column of source.names!.filter((name) => !source.secret.has(name))) {
            kept.push(SelectionNode.create(ReferenceNode.create(ColumnNode.create(column), TableNode.create(source.ref))));
            output.names.push(column);
          }
        }
        continue;
      }
      const name = outputName(selection);
      if (AliasNode.is(selection) && FunctionNode.is(selection.node) && selection.node.func === SECRET) {
        // Asked for: it leaves this select as a secret column — and a relation's JSON never holds one.
        if (this.#relation !== undefined) this.#read(selection.node.arguments[0]);
        if (name !== undefined) output.secret.add(name);
      } else {
        this.#read(selection);
      }
      if (name !== undefined) output.names.push(name);
      kept.push(node);
    }
    if (changed) this.spelled.set(owner, kept);
    return output;
  }

  /** What a selection reads: every column and whole row in it, and the subqueries and relations in it. */
  #read(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.#read(item);
      return;
    }
    const kind = (node as { kind?: unknown }).kind;
    if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode') return;
    if (kind === 'SelectQueryNode') {
      const output = this.#select(node as SelectQueryNode);
      if (output.secret.size) this.#refuse(`${[...output.secret].join(', ')} of a subquery`);
      return;
    }
    if (kind === 'FunctionNode' && ((node as FunctionNode).func === MANY || (node as FunctionNode).func === ONE)) return this.#relationOf(node as FunctionNode);
    if (kind === 'ReferenceNode') return this.#reference(node as ReferenceNode);
    if (kind === 'ColumnNode') return this.#name((node as ColumnNode).column.name);
    // A table as a value is its whole row (`eb.table('users')`, `sql.table()`); `sql.id()` is a name, a column's or a source's.
    if (kind === 'TableNode') return this.#row((node as TableNode).table.identifier.name);
    if (kind === 'IdentifierNode') return this.#name((node as IdentifierNode).name);
    if (kind === 'AliasNode') return this.#read((node as AliasNode).node);
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') this.#read(value);
  }

  /** A part of the query whose values do not leave the database: only its subqueries and relations are checked. */
  #scan(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.#scan(item);
      return;
    }
    const kind = (node as { kind?: unknown }).kind;
    if (kind === 'ValueNode' || kind === 'ValueListNode' || kind === 'PrimitiveValueListNode') return;
    if (kind === 'SelectQueryNode') return void this.#select(node as SelectQueryNode);
    if (kind === 'FunctionNode' && ((node as FunctionNode).func === MANY || (node as FunctionNode).func === ONE)) return this.#relationOf(node as FunctionNode);
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') this.#scan(value);
  }

  #relationOf(node: FunctionNode): void {
    const [relation, top] = [this.#relation, this.#top];
    this.#relation = String((node.arguments[1] as ValueNode | undefined)?.value ?? 'A relation');
    this.#top = true;
    try {
      this.#select(node.arguments[0] as SelectQueryNode);
    } finally {
      [this.#relation, this.#top] = [relation, top];
    }
  }

  #reference(node: ReferenceNode): void {
    const qualifier = node.table?.table.identifier.name;
    if (node.column.kind === 'SelectAllNode') return this.#row(qualifier ?? '');
    if (qualifier === undefined) return this.#name(node.column.column.name);
    const source = this.#resolve(qualifier);
    if (source.untyped) this.#untyped(source);
    if (source.secret.has(node.column.column.name)) this.#refuse(`${source.table ?? source.ref}.${node.column.column.name}`);
  }

  /** A name without a table: any source in scope may have it as a column (over-strict on purpose) — or be it, as a whole row. */
  #name(name: string): void {
    for (const sources of this.#scopes.toReversed()) {
      for (const source of sources) {
        if (source.untyped) this.#untyped(source);
        if (source.secret.has(name)) this.#refuse(`${source.table ?? source.ref}.${name}`);
        if (source.ref === name) this.#row(name);
      }
    }
  }

  #row(name: string): void {
    const source = this.#resolve(name);
    if (source.untyped) this.#untyped(source);
    if (source.secret.size === 0) return;
    throw new Error(
      `${this.#relation ?? 'This query'} reads the whole row of ${source.table ?? source.ref}, secret columns included — name the columns it ` +
        'needs, and read a secret one with secret(eb, …) in a query of its own. See docs/queries.md#relations-and-secret-columns.',
    );
  }

  /** The source a name refers to: innermost scope first, then a common table expression; an unknown name is taken as a table's. */
  #resolve(name: string): Source {
    for (const sources of this.#scopes.toReversed()) {
      const source = sources.find((candidate) => candidate.ref === name);
      if (source) return source;
    }
    const cte = this.#cte(name);
    if (cte) return { ref: name, names: cte.names, secret: cte.secret, ...(cte.untyped ? { untyped: true } : {}) };
    return { ref: name, table: name, secret: this.#metadata.secrets.get(name) ?? new Set() };
  }

  #refuse(what: string): never {
    if (this.#relation !== undefined) {
      throw new Error(
        `${this.#relation} selects ${what}, a secret column — a relation never loads one. Read it where it is needed, in a query of ` +
          'its own with secret(eb, …). See docs/queries.md#relations-and-secret-columns.',
      );
    }
    throw new Error(
      `This query selects ${what}, a secret column, without secret() — read it with secret(eb, …) where it is needed, at every level ` +
        'of the query that passes it on. See docs/migrations.md#secret-columns.',
    );
  }

  #untyped(source: Source): never {
    throw new Error(
      `${this.#relation ?? 'This query'} reads ${source.ref ? `"${source.ref}", ` : ''}raw SQL or a function in FROM, whose columns cannot be ` +
        'checked for secret ones. Select from a table, a subquery or a common table expression instead. See docs/queries.md#relations-and-secret-columns.',
    );
  }
}

interface MutableOutput {
  readonly names: string[];
  readonly secret: Set<string>;
}

/** The name a selection gets in the result. */
export function outputName(node: OperationNode): string | undefined {
  if (AliasNode.is(node) && IdentifierNode.is(node.alias)) return node.alias.name;
  if (ReferenceNode.is(node) && ColumnNode.is(node.column)) return node.column.column.name;
  if (ColumnNode.is(node)) return node.column.name;
  return undefined;
}
