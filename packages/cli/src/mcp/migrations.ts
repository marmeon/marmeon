import { hasPackage } from '../commands/schema-project.ts';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_LIMIT = 200;
const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

const NO_DATABASE: ToolDocument = { format: 1, database: false, connections: [], migrations: [], total: 0, truncated: false, warnings: [] };

/** The migrations that ran and the ones that are pending, as `marmeon migrate:status --json` prints them, filtered and cut. */
export const MIGRATIONS_TOOL: McpTool = {
  name: 'migrations',
  description: `List the migrations of the app, each with its module, the connection it runs on, its batch and whether it ran or is pending, and per connection how many ran and how many are pending. Needs the database; the record is on the default connection. Starts the app once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ran', 'pending'], description: 'Only migrations in this state.' },
      module: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n-][^\\r\\n]{0,199}$', description: 'Only migrations of this module.' },
      connection: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n-][^\\r\\n]{0,199}$', description: 'Only migrations that run on this connection.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_LIMIT, description: `At most this many migrations (default ${DEFAULT_LIMIT}).` },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: migrations,
};

interface Entry {
  readonly name: string;
  readonly module: string;
  readonly connection: string | null;
  readonly batch: number | null;
  readonly status: 'ran' | 'pending';
}

async function migrations(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  if (!hasPackage(root)) return NO_DATABASE;
  // The command and its arguments are fixed: nothing of the input reaches the child, the filters apply to its document.
  const run = await runMarmeonJson(root, ['migrate:status', '--json'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('The app did not answer in time: migrate:status was stopped after 120 seconds.');
  if (signal.aborted) return failure('The call was cancelled; marmeon migrate:status was stopped.');
  if (run.tooLarge) return failure('migrate:status printed more than 16 MiB; the result was dropped.');
  if (run.code !== 0) {
    return failure(`marmeon migrate:status failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}. Run it in a terminal to see the whole message.`);
  }
  if (run.document === undefined) return failure('marmeon migrate:status did not print one JSON document: something in the app writes to stdout directly.');
  const document = run.document as { format?: unknown; migrations?: unknown; warnings?: unknown };
  if (document.format !== 1 || !Array.isArray(document.migrations) || !Array.isArray(document.warnings)) {
    return failure('marmeon migrate:status printed a document this version does not read — update marmeon.');
  }
  // Fields are copied one by one; an entry without `connection` (an older @marmeon/database) runs on an unknown one.
  const all: Entry[] = [];
  for (const raw of document.migrations as Record<string, unknown>[]) {
    if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.module !== 'string' || (raw.status !== 'ran' && raw.status !== 'pending')) {
      return failure('marmeon migrate:status printed a document this version does not read — update marmeon.');
    }
    all.push({
      name: raw.name,
      module: raw.module,
      connection: typeof raw.connection === 'string' ? raw.connection : null,
      batch: typeof raw.batch === 'number' ? raw.batch : null,
      status: raw.status,
    });
  }

  const counts = new Map<string | null, { ran: number; pending: number }>();
  for (const entry of all) {
    const count = counts.get(entry.connection) ?? { ran: 0, pending: 0 };
    count[entry.status] += 1;
    counts.set(entry.connection, count);
  }
  const connections = [...counts].map(([name, count]) => ({ name, ...count })).sort((a, b) => (a.name === b.name ? 0 : a.name === null ? 1 : b.name === null ? -1 : a.name < b.name ? -1 : 1));

  const status = typeof input.status === 'string' ? input.status : undefined;
  const module = typeof input.module === 'string' ? input.module : undefined;
  const connection = typeof input.connection === 'string' ? input.connection : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
  const matching = all.filter((entry) => (status === undefined || entry.status === status) && (module === undefined || entry.module === module) && (connection === undefined || entry.connection === connection));
  return {
    format: 1,
    database: true,
    connections,
    migrations: matching.slice(0, limit),
    total: matching.length,
    truncated: matching.length > limit,
    warnings: (document.warnings as unknown[]).filter((warning): warning is string => typeof warning === 'string'),
  };
}
