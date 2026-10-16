import {
  AliasNode,
  ColumnNode,
  FunctionNode,
  IdentifierNode,
  RawNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  ValuesNode,
  type ColumnUpdateNode,
  type DeleteQueryNode,
  type InsertQueryNode,
  type MergeQueryNode,
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
// Names are compared without ASCII case, as SQLite does (`TOKEN` is `token` there); names in scope that differ only in case are
// refused, since Postgres tells them apart.

/**
 * What a select (a subquery, a common table expression) outputs: its columns by position (`undefined` for one without a name), and
 * which names carry a secret. `known` is false when its width is not: a `selectAll()` of a table the metadata does not know.
 */
interface Output {
  readonly names: readonly (string | undefined)[];
  /** Folded ({@link fold}), like every set of secret columns here. */
  readonly secret: ReadonlySet<string>;
  readonly known: boolean;
  /** A statement's `returning` as a common table expression: not followed. */
  readonly untyped?: boolean;
}

/** A table, common table expression or subquery a select reads from, under the name it is referred to by. */
interface Source {
  readonly ref: string;
  /** A table of the migrations, by name. */
  readonly table?: string;
  /** Its output columns — `undefined` when they are not known (a table nobody migrated, a view). */
  readonly names?: readonly (string | undefined)[];
  readonly secret: ReadonlySet<string>;
  /** Raw SQL or a function in FROM: its columns cannot be checked. */
  readonly untyped?: boolean;
}

const WRITES: ReadonlySet<string> = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode']);

/** What the guard changes: selections spelled out without secret columns, by the select (or returning) they belong to. */
export type Spelled = ReadonlyMap<OperationNode, readonly SelectionNode[]>;

/**
 * A `secret()` as the connection compiles it: the column with a comment in front that marks the ask. Transformers copy a raw
 * node's text, so a query this one is compiled into as a subquery (a builder's plugins run on it first) still sees the ask.
 */
const ASKED = '/* secret() */ ';

/** @internal — the column a `secret()` asked for, compiled as itself. */
export function asked(reference: OperationNode): RawNode {
  return RawNode.create([ASKED, ''], [reference]);
}

/**
 * Whether a selection reads a column with `secret()` — as written, or as the connection compiled it. For code that builds on a
 * query's own selections, such as a data table: such a value is never one of its columns. See `docs/migrations.md#secret-columns`.
 */
export function isSecretSelection(selection: OperationNode): boolean {
  return askedOf(selection) !== undefined;
}

/** The column inside a `secret()` — before the connection compiled it, or after. */
function askedOf(node: OperationNode): OperationNode | undefined {
  if (AliasNode.is(node)) node = node.node;
  if (FunctionNode.is(node) && node.func === SECRET) return node.arguments[0];
  if (RawNode.is(node) && node.sqlFragments.length === 2 && node.sqlFragments[0] === ASKED && node.sqlFragments[1] === '') return node.parameters[0];
  return undefined;
}

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
  /** The relation being checked (its label). */
  #relation: string | undefined;

  /** The table each statement being checked writes — innermost last. */
  readonly #targets: (Source | undefined)[] = [];

  readonly #tables: ReadonlyMap<string, Table>;

  constructor(metadata: SchemaMetadata) {
    this.#metadata = metadata;
    this.#tables = tablesOf(metadata);
  }

  root(node: RootOperationNode): void {
    if (node.kind === 'SelectQueryNode') this.#select(node);
    else if (node.kind === 'InsertQueryNode' || node.kind === 'UpdateQueryNode' || node.kind === 'DeleteQueryNode' || node.kind === 'MergeQueryNode') this.#write(node);
    else this.#scan(node);
  }

  #select(node: SelectQueryNode): Output {
    const ctes = this.#with(node.with);
    const sources: Source[] = [];
    this.#scopes.push(sources);
    try {
      // A joined subquery may refer to the sources before it (lateral): each sees the ones already known.
      for (const item of [...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)]) this.#add(sources, this.#source(item));
      // Conditions and orders read columns, but nothing of them leaves the database: only their subqueries are checked.
      this.#scan([node.joins?.map((join) => join.on), node.where, node.groupBy, node.having, node.orderBy, node.distinctOn]);
      const output = this.#selections(node, node.selections ?? [], sources);
      for (const operation of node.setOperations ?? []) this.#union(output, this.#select(operation.expression as SelectQueryNode));
      return output;
    } finally {
      this.#scopes.pop();
      if (ctes) this.#ctes.pop();
    }
  }

  /**
   * A union's (intersect's, except's) columns are the first select's, by position: a column of either part that carries a secret
   * carries it in the result. A part of unknown width cannot be lined up with one that carries a secret.
   */
  #union(output: MutableOutput, other: Output): void {
    if (output.secret.size === 0 && other.secret.size === 0) {
      if (!other.known) output.known = false;
      return;
    }
    if (!output.known || !other.known || output.names.length !== other.names.length) {
      throw new Error(
        `${this.#relation ?? 'This query'} combines a select that passes on a secret column with one whose columns are not known (a selectAll() ` +
          'of a table the migrations did not create, such as a view), so they cannot be lined up. Name the columns of both. See docs/migrations.md#secret-columns.',
      );
    }
    other.names.forEach((name, at) => {
      if (name === undefined || !other.secret.has(fold(name))) return;
      const own = output.names[at];
      if (own === undefined) this.#refuse(`${name} of a union, under no name`);
      output.secret.add(fold(own));
    });
  }

  #write(node: InsertQueryNode | UpdateQueryNode | DeleteQueryNode | MergeQueryNode): void {
    const ctes = this.#with(node.with);
    const items =
      node.kind === 'InsertQueryNode'
        ? [node.into]
        : node.kind === 'UpdateQueryNode'
          ? [node.table, ...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)]
          : node.kind === 'MergeQueryNode'
            ? [node.into, node.using?.table]
            : [...node.from.froms, ...(node.using?.tables ?? []), ...(node.joins ?? []).map((join) => join.table)];
    const sources: Source[] = [];
    this.#scopes.push(sources);
    // `excluded` of an upsert is the row that was to be inserted: it carries the secret columns of the table written.
    const excluded: Source[] = [];
    this.#scopes.push(excluded);
    this.#targets.push(undefined);
    try {
      for (const item of items) if (item) this.#add(sources, this.#source(item));
      this.#targets[this.#targets.length - 1] = sources[0];
      if (node.kind === 'InsertQueryNode' && node.onConflict && sources[0]) {
        const { names, secret } = sources[0];
        excluded.push({ ref: 'excluded', ...(names ? { names } : {}), secret });
      }
      const { returning, with: _, ...rest } = node as typeof node & { returning?: ReturningNode };
      // A merge's using clause is a source; only its `on` is a part to scan.
      if (node.kind === 'MergeQueryNode') (rest as { using?: unknown }).using = node.using?.on;
      let scanned: unknown[] = Object.values(rest);
      if (node.kind === 'InsertQueryNode') scanned = Object.values(this.#copy(rest as InsertQueryNode));
      this.#scan(scanned);
      if (returning) this.#selections(returning, returning.selections, sources);
    } finally {
      this.#targets.pop();
      this.#scopes.pop();
      this.#scopes.pop();
      if (ctes) this.#ctes.pop();
    }
  }

  /**
   * Checks the rows an insert is given: a secret column passed on by a select, or read by an expression, may land only in a secret
   * column of the table written. Returns the insert without them, for the rest to be scanned.
   */
  #copy(node: InsertQueryNode): InsertQueryNode {
    const target = this.#targets.at(-1);
    const into = (column: string | undefined) => column !== undefined && target?.secret.has(fold(column)) === true;
    const column = (at: number) => node.columns?.[at]?.column.name;
    const { values } = node;
    if (values && SelectQueryNode.is(values)) {
      const output = this.#select(values);
      output.names.forEach((name, at) => {
        if (name !== undefined && output.secret.has(fold(name)) && !into(column(at))) this.#refuse(`${name} of a subquery, copied into ${column(at) ?? 'a column without a name'}`);
      });
    } else if (values && ValuesNode.is(values)) {
      for (const row of values.values) {
        if (row.kind !== 'ValueListNode') continue;
        row.values.forEach((value, at) => {
          if (value.kind === 'ValueNode') return;
          if (into(column(at))) this.#scan(value);
          else this.#read(value);
        });
      }
    } else if (values) {
      this.#scan(values);
    }
    return { ...node, values: undefined };
  }

  /**
   * Registers a statement's common table expressions. Every one is known before any body is checked — a body may refer to a
   * later one — and the bodies are checked again until no column gains a secret. One whose body reaches its own name, directly
   * or through another of the clause, is recursive (keyword or not): since recursion can move a value from column to column,
   * once any of its columns carries a secret, every column does. A name a table or an outer expression has is refused: which of
   * the two a reference means depends on the database (and on the clause's order), so neither is modelled.
   */
  #with(node: WithNode | undefined): boolean {
    if (!node) return false;
    const ctes = new Map<string, Output>();
    this.#ctes.push(ctes);
    const bodies: { name: string; expression: SelectQueryNode; named: readonly string[] | undefined; self: Output; mentions: ReadonlySet<string> }[] = [];
    for (const { name, expression } of node.expressions) {
      const table = name.table.table.identifier.name;
      const named = name.columns?.map((column) => column.column.name);
      const shadows = this.#tables.has(fold(table)) ? 'a table of the migrations' : this.#cte(table) ? 'a common table expression around it' : undefined;
      if (shadows) {
        throw new Error(
          `${this.#relation ?? 'This query'} names a common table expression "${table}", which is also ${shadows} — rename the expression: whether a ` +
            'reference means the one or the other differs between databases, so the check for secret columns cannot follow it. See docs/migrations.md#secret-columns.',
        );
      }
      if (!SelectQueryNode.is(expression)) {
        // A statement with `returning` as a common table expression: its columns are not followed — it cannot be read from.
        if (WRITES.has(expression.kind)) this.#write(expression as InsertQueryNode);
        else this.#scan(expression);
        ctes.set(fold(table), { names: [], secret: new Set(), known: false, untyped: true });
        continue;
      }
      // Its own name inside its body (a recursive one): columns that carry nothing yet.
      const self: Output = { names: named ?? [], secret: new Set(), known: named !== undefined };
      ctes.set(fold(table), self);
      bodies.push({ name: fold(table), expression, named, self, mentions: tablesIn(expression) });
    }
    const recursive = new Set(bodies.filter((body) => reaches(body.name, body.name, bodies)).map((body) => body.name));
    for (let pass = 0; ; pass++) {
      let changed = false;
      let failed: unknown;
      for (const { name, expression, named, self } of bodies) {
        const previous = ctes.get(name)!;
        let output: Output;
        ctes.set(name, self);
        try {
          output = this.#select(expression);
        } catch (error) {
          // A later one may still be unknown: once nothing changes any more, the refusal stands.
          failed ??= error;
          continue;
        } finally {
          ctes.set(name, previous);
        }
        const names = named ?? output.names;
        // Grows from pass to pass; the first starts from nothing (`self` is only how its own body sees it).
        const secret = new Set(previous === self ? [] : previous.secret);
        output.names.forEach((own, at) => {
          if (own !== undefined && output.secret.has(fold(own)) && names[at] !== undefined) secret.add(fold(names[at]!));
        });
        if (recursive.has(name) && secret.size) for (const column of names) if (column !== undefined) secret.add(fold(column));
        const known = output.known && names.length === output.names.length;
        if (secret.size === previous.secret.size && known === previous.known && names.length === previous.names.length && names.every((column, at) => column === previous.names[at])) continue;
        ctes.set(name, { names, secret, known });
        changed = true;
      }
      if (!changed) {
        if (failed) throw failed;
        return true;
      }
      if (pass > bodies.length * 2) {
        throw new Error(
          `${this.#relation ?? 'This query'} has common table expressions that refer to one another in a way the check for secret columns cannot ` +
            'settle. Name the columns of each, and read a secret one with secret(eb, …). See docs/migrations.md#secret-columns.',
        );
      }
    }
  }

  #source(item: OperationNode): Source {
    const alias = AliasNode.is(item) && IdentifierNode.is(item.alias) ? item.alias.name : undefined;
    const node = AliasNode.is(item) ? item.node : item;
    if (TableNode.is(node)) {
      const name = node.table.identifier.name;
      const ref = alias ?? name;
      const cte = this.#cte(name);
      if (cte) return { ref, ...(cte.known ? { names: cte.names } : {}), secret: cte.secret, ...(cte.untyped ? { untyped: true } : {}) };
      const known = this.#table(name);
      return { ref, table: name, ...(known?.names ? { names: known.names } : {}), secret: known?.secret ?? new Set() };
    }
    if (SelectQueryNode.is(node)) {
      const output = this.#select(node);
      return { ref: alias ?? '', ...(output.known ? { names: output.names } : {}), secret: output.secret };
    }
    this.#scan(node);
    return { ref: alias ?? '', secret: new Set(), untyped: true };
  }

  #cte(name: string): Output | undefined {
    for (const ctes of this.#ctes.toReversed()) {
      const cte = ctes.get(fold(name));
      if (cte) return cte;
    }
    return undefined;
  }

  /** A table of the migrations by a name in any case: its columns as named exactly, if one is, and the secret ones of every match. */
  #table(name: string): { readonly names?: readonly string[]; readonly secret: ReadonlySet<string> } | undefined {
    const table = this.#tables.get(fold(name));
    if (!table) return undefined;
    const exact = this.#metadata.kinds.get(name);
    return { ...(exact ? { names: [...exact.keys()] } : table.names ? { names: table.names } : {}), secret: table.secret };
  }

  /**
   * Adds a source to the select's. Two names in scope that differ only in case would mean one source on SQLite and two on
   * Postgres — a reference to one could read the other's secret column on either: refused.
   */
  #add(sources: Source[], source: Source): void {
    if (source.ref) {
      const key = fold(source.ref);
      for (const scope of this.#scopes) {
        const other = scope.find((candidate) => candidate.ref !== source.ref && fold(candidate.ref) === key);
        if (other) {
          throw new Error(
            `${this.#relation ?? 'This query'} names "${other.ref}" and "${source.ref}", which differ only in case — rename one: some databases tell ` +
              'them apart and some do not, so the check for secret columns cannot follow them. See docs/migrations.md#secret-columns.',
          );
        }
      }
    }
    sources.push(source);
  }

  /** Checks the selections of a select (or a returning), and records them spelled out where they must be. */
  #selections(owner: OperationNode, selections: readonly SelectionNode[], sources: readonly Source[]): MutableOutput {
    const output: MutableOutput = { names: [], secret: new Set(), known: true };
    const kept: SelectionNode[] = [];
    let changed = false;
    for (const node of selections) {
      const { selection } = node;
      const all = selection.kind === 'SelectAllNode' ? sources : ReferenceNode.is(selection) && selection.column.kind === 'SelectAllNode' ? [this.#own(selection.table!.table.identifier.name, sources)] : undefined;
      if (all) {
        for (const source of all) if (source.untyped) this.#untyped(source);
        if (all.every((source) => source.secret.size === 0)) {
          kept.push(node);
          for (const source of all) {
            if (source.names) output.names.push(...source.names);
            else output.known = false;
          }
          continue;
        }
        changed = true;
        let columns = 0;
        for (const source of all) {
          if (source.secret.size === 0) {
            kept.push(SelectionNode.createSelectAllFromTable(TableNode.create(source.ref)));
            if (source.names) output.names.push(...source.names);
            else output.known = false;
            columns++;
            continue;
          }
          // Of unknown width (a select that asked for a secret next to a view's selectAll()): nothing to spell out, so its row is refused.
          if (!source.names) this.#wholeRow(source);
          for (const column of source.names) {
            if (column === undefined) this.#refuse(`a column of ${source.ref} without a name, next to a secret one`);
            if (source.secret.has(fold(column))) continue;
            kept.push(SelectionNode.create(ReferenceNode.create(ColumnNode.create(column), TableNode.create(source.ref))));
            output.names.push(column);
            columns++;
          }
        }
        if (columns === 0) {
          throw new Error(
            `${this.#relation ?? 'This query'} selects all columns of ${all.map((source) => source.ref).join(', ')}, and every one is a secret column — ` +
              'name the columns it needs, and read a secret one with secret(eb, …). See docs/migrations.md#secret-columns.',
          );
        }
        continue;
      }
      const name = outputName(selection);
      const column = AliasNode.is(selection) ? askedOf(selection) : undefined;
      if (column) {
        // Asked for: it leaves this select as a secret column — and a relation's JSON never holds one.
        if (this.#relation !== undefined) this.#read(column);
        if (name !== undefined) output.secret.add(fold(name));
      } else {
        this.#read(selection);
      }
      output.names.push(name);
      kept.push(node);
    }
    // Checked again (a later pass over a with clause): what this pass found replaces what an earlier one did.
    if (changed) this.spelled.set(owner, kept);
    else this.spelled.delete(owner);
    return output;
  }

  /** The source `selectAll('name')` names — one of this select's own. */
  #own(name: string, sources: readonly Source[]): Source {
    const source = sources.find((candidate) => fold(candidate.ref) === fold(name));
    if (!source) throw new Error(`${this.#relation ?? 'This query'} selects all columns of "${name}", which is no table, subquery or alias of its own.`);
    return source;
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
    if (kind === 'ColumnUpdateNode') return this.#assigned(node as ColumnUpdateNode);
    // An insert of a merge: the table written is the merge's.
    if (kind === 'InsertQueryNode') return this.#scan(Object.values(this.#copy(node as InsertQueryNode)));
    if (kind === 'ValuesNode') {
      for (const row of (node as ValuesNode).values) if (row.kind === 'ValueListNode') for (const value of row.values) if (value.kind !== 'ValueNode') this.#read(value);
      return;
    }
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') this.#scan(value);
  }

  /**
   * The value of a `set` (an update's, an upsert's, a merge's) is stored, and a later select hands it out: it is read like a
   * selection — unless a secret column of the table written receives it.
   */
  #assigned(node: ColumnUpdateNode): void {
    const name = ColumnNode.is(node.column) ? node.column.column.name : undefined;
    if (name !== undefined && this.#targets.at(-1)?.secret.has(fold(name))) this.#scan(node.value);
    else this.#read(node.value);
  }

  #relationOf(node: FunctionNode): void {
    const relation = this.#relation;
    this.#relation = String((node.arguments[1] as ValueNode | undefined)?.value ?? 'A relation');
    try {
      this.#select(node.arguments[0] as SelectQueryNode);
    } finally {
      this.#relation = relation;
    }
  }

  #reference(node: ReferenceNode): void {
    const qualifier = node.table?.table.identifier.name;
    if (node.column.kind === 'SelectAllNode') return this.#row(qualifier ?? '');
    if (qualifier === undefined) return this.#name(node.column.column.name);
    const source = this.#resolve(qualifier);
    if (source.untyped) this.#untyped(source);
    if (source.secret.has(fold(node.column.column.name))) this.#refuse(`${source.table ?? source.ref}.${node.column.column.name}`);
  }

  /** A name without a table: any source in scope may have it as a column (over-strict on purpose) — or be it, as a whole row. */
  #name(name: string): void {
    for (const sources of this.#scopes.toReversed()) {
      for (const source of sources) {
        if (source.untyped) this.#untyped(source);
        if (source.secret.has(fold(name))) this.#refuse(`${source.table ?? source.ref}.${name}`);
        if (fold(source.ref) === fold(name)) this.#row(name);
      }
    }
  }

  #row(name: string): void {
    const source = this.#resolve(name);
    if (source.untyped) this.#untyped(source);
    if (source.secret.size) this.#wholeRow(source);
  }

  #wholeRow(source: Source): never {
    throw new Error(
      `${this.#relation ?? 'This query'} reads the whole row of ${source.table ?? source.ref}, secret columns included — name the columns it ` +
        'needs, and read a secret one with secret(eb, …) in a query of its own. See docs/queries.md#relations-and-secret-columns.',
    );
  }

  /** The source a name refers to: innermost scope first, then a common table expression; an unknown name is taken as a table's. */
  #resolve(name: string): Source {
    for (const sources of this.#scopes.toReversed()) {
      const source = sources.find((candidate) => fold(candidate.ref) === fold(name));
      if (source) return source;
    }
    const cte = this.#cte(name);
    if (cte) return { ref: name, names: cte.names, secret: cte.secret, ...(cte.untyped ? { untyped: true } : {}) };
    return { ref: name, table: name, secret: this.#table(name)?.secret ?? new Set() };
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

/** A table of the migrations, under its folded name: the columns of one spelling, and the folded secret columns of every spelling. */
interface Table {
  /** Unknown for a table with secret columns the catalog does not list (none, unless the books and the schema disagree). */
  readonly names?: readonly string[];
  readonly secret: ReadonlySet<string>;
}

/** A name as SQLite compares it: ASCII letters in lower case (only those — SQLite folds no other letter by default). */
export function fold(name: string): string {
  return /[A-Z]/.test(name) ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : name;
}

/** The tables of the metadata by folded name — once per load (the metadata replaces its maps when it loads). */
const folded = new WeakMap<object, { readonly kinds: object; readonly tables: ReadonlyMap<string, Table> }>();
function tablesOf(metadata: SchemaMetadata): ReadonlyMap<string, Table> {
  const cached = folded.get(metadata.secrets);
  if (cached?.kinds === metadata.kinds) return cached.tables;
  const tables = new Map<string, { names?: readonly string[]; secret: Set<string> }>();
  const entry = (name: string) => {
    let table = tables.get(fold(name));
    if (!table) {
      const kinds = metadata.kinds.get(name);
      tables.set(fold(name), (table = { ...(kinds ? { names: [...kinds.keys()] } : {}), secret: new Set() }));
    }
    return table;
  };
  for (const name of metadata.kinds.keys()) entry(name);
  for (const [name, columns] of metadata.secrets) for (const column of columns) entry(name).secret.add(fold(column));
  folded.set(metadata.secrets, { kinds: metadata.kinds, tables });
  return tables;
}

interface MutableOutput {
  readonly names: (string | undefined)[];
  readonly secret: Set<string>;
  known: boolean;
}

/** Every table name a node mentions — a source, a qualifier, a whole row — at any depth (more rather than fewer, on purpose). */
function tablesIn(node: unknown, into = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return into;
  if (TableNode.is(node as OperationNode)) into.add(fold((node as TableNode).table.identifier.name));
  else for (const value of Object.values(node)) if (value !== null && typeof value === 'object') tablesIn(value, into);
  return into;
}

/** Whether the common table expression `from` reaches `to` through the mentions of the clause's expressions. */
function reaches(from: string, to: string, bodies: readonly { name: string; mentions: ReadonlySet<string> }[]): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const body = bodies.find((candidate) => candidate.name === pending.pop());
    if (!body) continue;
    for (const name of body.mentions) {
      if (name === to) return true;
      if (!seen.has(name)) {
        seen.add(name);
        pending.push(name);
      }
    }
  }
  return false;
}

/** The name a selection gets in the result. */
export function outputName(node: OperationNode): string | undefined {
  if (AliasNode.is(node) && IdentifierNode.is(node.alias)) return node.alias.name;
  if (ReferenceNode.is(node) && ColumnNode.is(node.column)) return node.column.column.name;
  if (ColumnNode.is(node)) return node.column.name;
  return undefined;
}
