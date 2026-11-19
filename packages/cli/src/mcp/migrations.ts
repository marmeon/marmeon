import { hasPackage } from '../commands/schema-project.ts';
import { readMigrationStatus } from '../migration-status.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_LIMIT = 200;
const CHILD_TIMEOUT_MS = 120_000;

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

async function migrations(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  if (!hasPackage(root)) return NO_DATABASE;
  // The command and its arguments are fixed: nothing of the input reaches the child, the filters apply to its document.
  const read = await readMigrationStatus(root, { signal, timeoutMs: CHILD_TIMEOUT_MS });
  if (!read.ok) return failure(read.reason);
  const all = read.migrations;

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
    warnings: read.warnings,
  };
}
