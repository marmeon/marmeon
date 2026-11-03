import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hasPackage } from '../commands/schema-project.ts';
import { readRegularIn } from '../files.ts';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

/** Where `marmeon schema:project` keeps the projection, relative to the app's root (docs/migrations.md#what-the-migrations-describe). */
const FILE = '.marmeon/schema.json';

/** The format of {@link FILE} this version reads. */
const FILE_FORMAT = 2;

const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LISTED_TABLES = 50;

/** The schema the app's migrations describe, as `marmeon schema:project` computes it, whole or for one table. */
export const SCHEMA_TOOL: McpTool = {
  name: 'schema',
  description: `The schema the app's migrations describe: tables, columns (type per driver, nullable, default), unique keys, indexes and foreign keys, freshly computed. It is the source of bootstrap/database.d.ts. A column with secret: true never belongs in an answer. Starts the app's build step once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,62}$', description: 'Only this table.' },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: schema,
};

async function schema(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  // The command is fixed. It prints no JSON, so only its exit code counts; on failure its message says what is missing.
  const run = await runMarmeonJson(root, ['schema:project'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('marmeon schema:project did not finish within 120 seconds and was stopped.');
  if (signal.aborted) return failure('The call was cancelled; marmeon schema:project was stopped.');
  if (run.code !== 0) return failure(`marmeon schema:project failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}`);

  const file = readRegularIn(root, FILE, MAX_FILE_BYTES);
  if (!file) {
    // Absent after a successful run: the app has no database package. Anything else there (a link, a directory) is not read, and said.
    if (!exists(join(root, FILE))) {
      if (hasPackage(root)) return failure(`${FILE} could not be written; run marmeon schema:project in a terminal to see why.`);
      return { format: 1, projection: null, warnings: ['This app has no @marmeon/database.'] };
    }
    return failure(`${FILE} is not a regular file inside the app, so it was not read.`);
  }
  if (file.truncated) return failure(`${FILE} is larger than 16 MiB, so it was not read.`);
  let projection: { format?: unknown; tables?: unknown };
  try {
    projection = JSON.parse(file.text) as typeof projection;
  } catch {
    return failure(`${FILE} is not valid JSON; run marmeon schema:project again.`);
  }
  if (projection === null || typeof projection !== 'object' || projection.format !== FILE_FORMAT) {
    // Only an integer is shown: anything else in a refused file stays out of the answer.
    const found = projection !== null && typeof projection === 'object' ? projection.format : undefined;
    const format = typeof found === 'number' && Number.isInteger(found) ? found : 'none';
    return failure(`${FILE} has format ${format}; this marmeon reads ${FILE_FORMAT} — update marmeon.`);
  }
  const table = typeof input.table === 'string' ? input.table : undefined;
  if (table === undefined) return { format: 1, projection, warnings: [] };
  const tables = projection.tables !== null && typeof projection.tables === 'object' ? (projection.tables as Record<string, unknown>) : {};
  if (!Object.hasOwn(tables, table)) {
    const names = Object.keys(tables);
    const listed = names.slice(0, MAX_LISTED_TABLES).join(', ');
    return failure(`The migrations describe no table "${table}". Tables: ${listed || 'none'}${names.length > MAX_LISTED_TABLES ? `, and ${names.length - MAX_LISTED_TABLES} more` : ''}.`);
  }
  return { format: 1, projection: { ...projection, tables: { [table]: tables[table] } }, warnings: [] };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
