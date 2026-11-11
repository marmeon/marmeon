import { fold } from './secret-guard.ts';

// Postgres deparses the plan of a query (`EXPLAIN (VERBOSE, FORMAT JSON)`): every expression arrives as text with the functions it
// calls by name, and every scan names the relation it reads. The guard reads that text. It proves a query safe rather than listing
// what is dangerous: a name it cannot account for is refused.

/** What a function does to data, as `pg_proc.provolatile` says: `i` immutable, `s` stable, `v` volatile. */
export interface FunctionFact {
  readonly schema: string;
  readonly name: string;
  readonly volatility: string;
}

/** What the database says about the names a plan uses, read in the transaction that runs the query. */
export interface PlanFacts {
  /** Every `pg_proc` entry whose name appears in the plan. */
  readonly functions: readonly FunctionFact[];
  /** Relation name → the relations it inherits from or is a partition of (its parents, transitively). */
  readonly ancestors: ReadonlyMap<string, readonly string[]>;
  /** Matview name → the relations its definition reads, transitively: a materialized view keeps a copy of what it was built from. */
  readonly derived: ReadonlyMap<string, readonly string[]>;
  /** Columns the query may never read, by table. */
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A function the plan calls, as it is written there (`schema` when qualified). */
export interface Call {
  readonly schema: string | undefined;
  readonly name: string;
}

/** What a plan reads and calls. */
export interface PlanReading {
  readonly calls: readonly Call[];
  readonly relations: readonly { readonly schema: string | undefined; readonly name: string; readonly alias: string | undefined }[];
  /** Every identifier of the plan's text, folded, with literals left out. */
  readonly words: ReadonlySet<string>;
  /** The plan's text with literals left out. */
  readonly texts: readonly string[];
  /** A node reads from another server. */
  readonly foreign: boolean;
}

// Functions that run queries of their own, read the server's files or settings, or reach other servers: refused whatever they are
// marked, because the checks on the plan do not see what they read.
const DENIED_FUNCTIONS = [
  /_to_xml(schema)?$/,
  /_to_xml_and_xmlschema$/,
  /^ts_stat$/,
  /^current_setting$/,
  /^pg_show_all_settings$/,
  /^pg_show_all_file_settings$/,
  /^pg_hba_file_rules$/,
  /^pg_ident_file_mappings$/,
  /^pg_config$/,
  /^pg_stat_get_activity$/,
  /^pg_stat_get_backend_activity$/,
  /^dblink/,
  /^lo_/,
  /^lo(read|write)$/,
  /^pg_read_/,
  /^pg_ls_/,
  /^pg_stat_file$/,
  // Functions that run the SQL they are given as text, which the plan does not show: tablefunc, xml2, text search rewriting.
  /^crosstab\d*$/,
  /^connectby$/,
  /^xpath_table$/,
  /^ts_rewrite$/,
  // Raw pages of tables and indexes, statements other sessions ran.
  /^(get_raw_page|page_header|page_checksum|fsm_page_contents|(heap|bt|hash|gin|gist|brin|tuple)_[a-z_]*(page|items|tuple)[a-z_]*)$/,
  /^pg_stat_statements/,
  // They assign a transaction id, which a read-only transaction would not otherwise have.
  /^(txid_current|pg_current_xact_id)$/,
];

// Catalog tables that hold samples of the data, credentials or settings of other roles.
const DENIED_RELATIONS = new Set([
  'pg_statistic',
  'pg_statistic_ext_data',
  'pg_authid',
  'pg_user_mapping',
  'pg_subscription',
  'pg_largeobject',
  'pg_db_role_setting',
  'pg_foreign_server',
]);

// Words the deparsed text puts before `(` that are not functions: type names with a modifier, `varchar(20)` as `character varying(20)`.
const TYPE_WORDS = new Set(['varying', 'character', 'char', 'bit', 'time', 'timestamp', 'interval', 'numeric', 'decimal', 'float', 'second', 'minute', 'hour', 'day', 'month', 'year']);

const IDENT = String.raw`"(?:[^"]|"")+"|[\p{Ll}\p{Lo}_][\p{Ll}\p{Lo}\p{N}_$]*`;
// Postgres writes unquoted identifiers in lower case, so the upper-case grammar words (`COALESCE(`, `ROW(`, `ANY (`, `EXTRACT(`,
// `OVER (`) are never names. It writes a call without a space before its `(`.
const CALL = new RegExp(String.raw`(?<![\p{L}\p{N}_$."])(?:(${IDENT})\.)?(${IDENT}) ?\(`, 'gu');
const WORD = new RegExp(String.raw`"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*`, 'gu');

/**
 * What the plan of `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON)` reads and calls; `undefined` when it does not have the shape this
 * reads (then nothing about it is known).
 */
export function readPlan(plan: unknown): PlanReading | undefined {
  if (!Array.isArray(plan) || plan.length !== 1) return undefined;
  const root: unknown = (plan[0] as { Plan?: unknown } | null)?.Plan;
  if (!isNode(root)) return undefined;
  const strings: string[] = [];
  const calls: Call[] = [];
  const relations: { schema: string | undefined; name: string; alias: string | undefined }[] = [];
  let foreign = false;
  let unreadable = false;
  const visit = (node: Record<string, unknown>): void => {
    if (typeof node['Node Type'] !== 'string') unreadable = true;
    if (String(node['Node Type']).startsWith('Foreign')) foreign = true;
    if (typeof node['Relation Name'] === 'string') {
      relations.push({
        schema: typeof node['Schema'] === 'string' ? node['Schema'] : undefined,
        name: node['Relation Name'],
        alias: typeof node['Alias'] === 'string' ? node['Alias'] : undefined,
      });
    }
    if (typeof node['Function Name'] === 'string') {
      calls.push({ schema: typeof node['Schema'] === 'string' ? node['Schema'] : undefined, name: node['Function Name'] });
    }
    collect(node, strings);
    const children = node['Plans'];
    if (children === undefined) return;
    if (!Array.isArray(children)) {
      unreadable = true;
      return;
    }
    for (const child of children) {
      if (isNode(child)) visit(child);
      else unreadable = true;
    }
  };
  visit(root);
  if (unreadable) return undefined;
  const texts: string[] = [];
  const words = new Set<string>();
  for (const text of strings) {
    const code = withoutLiterals(text);
    if (code === undefined) return undefined;
    texts.push(code);
    for (const found of code.matchAll(CALL)) calls.push({ schema: found[1] === undefined ? undefined : unquote(found[1]), name: unquote(found[2] ?? '') });
    for (const found of code.matchAll(WORD)) words.add(fold(unquote(found[0])));
  }
  return { calls, relations, words, texts, foreign };
}

/** The message that says why the plan may not run, or `undefined` when it may. */
export function checkPlan(plan: unknown, facts: PlanFacts): string | undefined {
  const reading = readPlan(plan);
  if (!reading) return 'Could not read the query plan, so the query cannot be checked.';
  if (reading.foreign) return 'A foreign table reads from another server and cannot be checked: it cannot be read here.';
  for (const relation of reading.relations) {
    if ((relation.schema === undefined || relation.schema === 'pg_catalog') && DENIED_RELATIONS.has(relation.name)) {
      return `${relation.name} holds samples of the data, credentials or settings and cannot be read.`;
    }
  }
  for (const relation of reading.relations) {
    // The storage behind a value too big for its row holds the value in pieces, with no column to name.
    if (relation.schema?.startsWith('pg_toast') || (relation.schema === undefined && relation.name.startsWith('pg_toast_'))) return 'TOAST tables hold the stored text of other tables and cannot be read.';
    for (const origin of facts.derived.get(fold(relation.name)) ?? []) {
      if ([...facts.secrets.keys()].some((table) => fold(lastSegment(table)) === fold(origin))) {
        return `${relation.name} keeps a copy of data from ${origin}, which has secret columns, and cannot be read.`;
      }
    }
  }
  const secret = secretProblem(reading, facts);
  if (secret) return secret;
  for (const call of reading.calls) {
    if (DENIED_FUNCTIONS.some((pattern) => pattern.test(call.name))) return `${call.name}() is not available here.`;
    const entries = facts.functions.filter((entry) => entry.name === call.name && (call.schema === undefined || entry.schema === call.schema));
    if (entries.length === 0) {
      if (call.schema === undefined && TYPE_WORDS.has(call.name)) continue;
      return `${call.name}() is not a function the database knows, so the query cannot be checked.`;
    }
    // Any overload counts: which one runs depends on the arguments, and the plan does not say.
    if (entries.some((entry) => entry.volatility === 'v')) return `${call.name}() can have effects (it is volatile): only functions that read can run here.`;
  }
  return undefined;
}

/**
 * A scan of a table with secret columns (or of one that inherits from it) may not name one of them anywhere in the plan, nor
 * read the whole row. Over-approximates on purpose: a column of that name in another table is refused as well, because a name in a
 * filter, a sort key or an expression is as good as a read (`where password like 'a%'`).
 */
function secretProblem(reading: PlanReading, facts: PlanFacts): string | undefined {
  const secrets = new Map<string, ReadonlySet<string>>();
  for (const [table, columns] of facts.secrets) secrets.set(fold(lastSegment(table)), new Set([...columns].map(fold)));
  for (const relation of reading.relations) {
    const name = fold(relation.name);
    for (const table of [name, ...(facts.ancestors.get(name) ?? []).map(fold)]) {
      const columns = secrets.get(table);
      if (!columns || columns.size === 0) continue;
      if (relation.alias !== undefined && wholeRow(reading.texts, relation.alias)) {
        return `${table} has secret columns (${[...columns].join(', ')}): name the columns you need instead of reading the whole row.`;
      }
      for (const column of columns) {
        if (reading.words.has(column)) return `${table}.${column} is a secret column: name the columns you need instead of *.`;
      }
    }
  }
  return undefined;
}

function wholeRow(texts: readonly string[], alias: string): boolean {
  const spelled = [alias.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), `"${alias.replaceAll('"', '""')}"`.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)];
  const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_$])(?:${spelled.join('|')})\.\*`, 'u');
  return texts.some((text) => pattern.test(text));
}

/** The names of the plan that need a catalog entry, for the query that fetches {@link PlanFacts}. */
export function calledNames(reading: PlanReading): string[] {
  return [...new Set(reading.calls.map((call) => call.name))];
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collect(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, into);
  else if (isNode(value)) for (const [key, item] of Object.entries(value)) if (key !== 'Plans') collect(item, into);
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier;
}

/**
 * The text with its `'…'` literals emptied and its quoted identifiers kept; `undefined` when a quote is not closed, because then
 * what follows it cannot be told from a literal.
 */
function withoutLiterals(text: string): string | undefined {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "'" && char !== '"') {
      out += char;
      index++;
      continue;
    }
    let end = index + 1;
    for (;;) {
      end = text.indexOf(char, end);
      if (end === -1) return undefined;
      if (text[end + 1] !== char) break;
      end += 2;
    }
    out += char === '"' ? text.slice(index, end + 1) : "''";
    index = end + 1;
  }
  return out;
}
