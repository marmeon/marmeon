import { hasPackage } from '../commands/schema-project.ts';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_LIMIT = 50;
const CHILD_TIMEOUT_MS = 30_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

/** What `marmeon db:query --stdin` reads at most, in bytes (the command refuses more). */
const MAX_SQL_BYTES = 64 * 1024;
const MAX_REFUSAL_CHARACTERS = 300;

/** The exit code of `db:query` for a query it refuses; its stderr then holds the reason. */
const REFUSED = 3;

const NO_DATABASE = 'This app has no database (@marmeon/database is not installed).';

/**
 * One read-only query on a connection of the app, through `marmeon db:query`. The database keeps the connection read-only, which is
 * why the tool is announced as read-only; the secret columns of the migrations are refused, and so is a connection with
 * `managed: false`, where none are known. The SQL is the child's standard input and never part of a command line.
 */
export const QUERY_TOOL: McpTool = {
  name: 'query',
  description: `Run one read-only SQL query on a connection of the app (development and test only) and return its rows. The database itself keeps the query read-only; columns the migrations mark secret are refused (name the other columns instead of using *), connections set to managed: false are refused, and string values are masked. Rows are personal data of the development database and are sent to the agent's provider. Starts the app once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      sql: { type: 'string', minLength: 1, maxLength: MAX_SQL_BYTES, description: 'One SELECT, WITH … SELECT, VALUES or TABLE statement.' },
      database: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n-][^\\r\\n]{0,199}$', description: 'The connection to query (default: the default connection).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_LIMIT, description: `At most this many rows (default ${DEFAULT_LIMIT}).` },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  spawns: true,
  run: query,
};

async function query(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  const sql = typeof input.sql === 'string' ? input.sql : '';
  const database = typeof input.database === 'string' ? input.database : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) return failure(`The SQL is longer than ${MAX_SQL_BYTES / 1024} KiB.`);
  if (!hasPackage(root)) return failure(NO_DATABASE);
  // The arguments are fixed tokens and values the schema checked; the SQL is the input of the child, not an argument.
  const args = ['db:query', '--json', '--stdin', '--managed-only', `--limit=${limit}`, ...(database === undefined ? [] : [`--database=${database}`])];
  const run = await runMarmeonJson(root, args, { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES, input: sql });
  if (run.timedOut) return failure('The app did not answer in time: db:query was stopped after 30 seconds.');
  if (signal.aborted) return failure('The call was cancelled; marmeon db:query was stopped.');
  if (run.tooLarge) return failure('db:query printed more than 16 MiB; the result was dropped.');
  if (run.code === REFUSED) {
    // The command's own sentence, built from fixed text and the query's identifiers; the first line, redacted by the runner.
    const reason = run.stderrTail.trim().split('\n')[0]!.slice(0, MAX_REFUSAL_CHARACTERS);
    return failure(reason === '' ? 'The query was refused.' : `The query was refused: ${reason}`);
  }
  // Not its stderr: what the database failed with may name a file or an address. The command says why in a terminal.
  if (run.code === 1) return failure('The query did not run: the connection is unknown, the database could not run it, or the app is not in development or test. Run marmeon db:query in a terminal to see the message.');
  if (run.code === 2) return failure('marmeon db:query refused the call as a wrong one — update marmeon.');
  if (run.code !== 0) return failure(`marmeon db:query failed (exit code ${run.code}). Run it in a terminal to see the message.`);
  const document = run.document as Record<string, unknown> | null | undefined;
  if (document === undefined) return failure('marmeon db:query did not print one JSON document: something in the app writes to stdout directly.');
  return read(document) ?? failure('marmeon db:query printed a document this version does not read — update marmeon.');
}

/** The answer of the command, field by field; `undefined` when it is not the document of the format this version reads. */
function read(document: Record<string, unknown> | null): ToolDocument | undefined {
  if (document === null || typeof document !== 'object' || document.format !== 1) return undefined;
  const { connection, driver, columns, rows, truncated, cut, warnings } = document;
  if (typeof connection !== 'string' || (driver !== 'sqlite' && driver !== 'pgsql') || !Array.isArray(columns) || !Array.isArray(rows) || typeof truncated !== 'boolean' || typeof cut !== 'number' || !Array.isArray(warnings)) return undefined;
  const named: { name: string; type: string | null }[] = [];
  for (const column of columns as Record<string, unknown>[]) {
    if (column === null || typeof column !== 'object' || typeof column.name !== 'string' || (column.type !== null && typeof column.type !== 'string')) return undefined;
    named.push({ name: column.name, type: column.type });
  }
  if (!rows.every(Array.isArray)) return undefined;
  return { format: 1, connection, driver, columns: named, rows, truncated, cut, warnings: warnings.filter((warning): warning is string => typeof warning === 'string') };
}
