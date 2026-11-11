import { hasPackage } from '../commands/schema-project.ts';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

const NO_DATABASE: ToolDocument = { format: 1, database: false, connection: null, driver: null, server: null, tables: [], warnings: [] };

/** A connection's driver, server version and tables with their column and row counts, as `marmeon db:show --json` prints them, without its target. */
export const DATABASE_TOOL: McpTool = {
  name: 'database',
  description: `Show a database connection of the app: its driver, the server version and each table with its number of columns and rows. It reports names and counts and reads no row, and it does not say where the connection points. Needs the database. Starts the app once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[A-Za-z_][A-Za-z0-9_.-]{0,62}$', description: 'The connection by its name (default: the default connection).' },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: database,
};

async function database(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  if (!hasPackage(root)) return NO_DATABASE;
  // One token for the option, from a value the schema checked; the command is fixed.
  const args = ['db:show', '--json', ...(typeof input.connection === 'string' ? [`--database=${input.connection}`] : [])];
  const run = await runMarmeonJson(root, args, { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('The app did not answer in time: db:show was stopped after 120 seconds.');
  if (signal.aborted) return failure('The call was cancelled; marmeon db:show was stopped.');
  if (run.tooLarge) return failure('db:show printed more than 16 MiB; the result was dropped.');
  if (run.code !== 0) {
    return failure(`marmeon db:show failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}. Run it in a terminal to see the whole message.`);
  }
  if (run.document === undefined) return failure('marmeon db:show did not print one JSON document: something in the app writes to stdout directly.');
  const document = run.document as Record<string, unknown>;
  const unreadable = () => failure('marmeon db:show printed a document this version does not read — update marmeon.');
  if (document.format !== 1 || typeof document.connection !== 'string' || typeof document.driver !== 'string' || typeof document.server !== 'string' || !Array.isArray(document.tables) || !Array.isArray(document.warnings)) {
    return unreadable();
  }
  // Fields are copied one by one: `target` (the configuration) and anything a later version adds stay behind.
  const tables: { name: string; schema: string | null; columns: number; rows: number }[] = [];
  for (const raw of document.tables as Record<string, unknown>[]) {
    if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.columns !== 'number' || typeof raw.rows !== 'number') return unreadable();
    tables.push({ name: raw.name, schema: typeof raw.schema === 'string' ? raw.schema : null, columns: raw.columns, rows: raw.rows });
  }
  return {
    format: 1,
    database: true,
    connection: document.connection,
    driver: document.driver,
    server: document.server,
    tables,
    warnings: (document.warnings as unknown[]).filter((warning): warning is string => typeof warning === 'string'),
  };
}
