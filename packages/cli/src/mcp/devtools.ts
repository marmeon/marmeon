import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 20;

/** The types of an entry, as `@marmeon/devtools` records them: kept here as literals, so the package is not needed to list the tools. */
const ENTRY_TYPES = ['request', 'query', 'job', 'mail', 'notification', 'log', 'exception', 'schedule', 'live', 'event', 'command'];

const NOT_INSTALLED = 'The devtools are not installed: pnpm add -E -D @marmeon/devtools@<version of your app> (docs/devtools.md#introduction)';

/** The entries the devtools recorded, as `marmeon devtools:list --json` prints them, passed on as the command's document. */
export const DEVTOOLS_ENTRIES_TOOL: McpTool = {
  name: 'devtools_entries',
  description: `The entries the devtools recorded while the app ran in development, newest first: requests, queries, jobs, mails, notifications, logs, exceptions, schedule runs, live messages, events and commands. They are recorded with secrets masked. Narrow by type first; search reads entry by entry. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        anyOf: [
          { type: 'string', enum: ENTRY_TYPES },
          { type: 'array', items: { type: 'string', enum: ENTRY_TYPES }, minItems: 1, maxItems: ENTRY_TYPES.length, uniqueItems: true },
        ],
        description: 'Only entries of this type, or of one of these types.',
      },
      tag: { type: 'string', pattern: '^[A-Za-z0-9:._/-]{1,100}$', minLength: 1, maxLength: 100, description: 'Only entries with exactly this tag.' },
      requestId: { type: 'string', pattern: '^[\\w.:-]{1,128}$', minLength: 1, maxLength: 128, description: 'Only entries of this request.' },
      search: { type: 'string', pattern: '^[^\\r\\n]+$', minLength: 1, maxLength: 200, description: 'Only entries whose text contains this, ignoring case.' },
      before: { type: 'string', pattern: '^[\\w.:-]{1,128}$', minLength: 1, maxLength: 128, description: 'Continue after this entry: the next of the previous answer.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: DEFAULT_LIMIT, description: `At most this many entries (default ${DEFAULT_LIMIT}).` },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: entries,
};

async function entries(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  // One token per option, from values the schema checked; the command is fixed.
  const types = typeof input.type === 'string' ? [input.type] : Array.isArray(input.type) ? input.type : undefined;
  const options: [string, unknown][] = [
    ['type', types?.join(',')],
    ['tag', input.tag],
    ['request', input.requestId],
    ['search', input.search],
    ['before', input.before],
    ['limit', typeof input.limit === 'number' ? String(input.limit) : undefined],
  ];
  const args = ['devtools:list', '--json', ...options.flatMap(([name, value]) => (typeof value === 'string' ? [`--${name}=${value}`] : []))];
  const run = await runMarmeonJson(root, args, { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('The app did not answer in time: devtools:list was stopped after 120 seconds.');
  if (signal.aborted) return failure('The call was cancelled; marmeon devtools:list was stopped.');
  if (run.tooLarge) return failure('devtools:list printed more than 16 MiB; the result was dropped.');
  if (run.code === 2 && run.stderrTail.includes('Command "devtools:list" is not defined. Run "marmeon list"')) return failure(NOT_INSTALLED);
  if (run.code !== 0) return failure(`marmeon devtools:list ended with code ${run.code}: ${run.stderrTail.trim() || 'no message'}`);
  if (run.document === undefined) return failure('marmeon devtools:list did not print one JSON document: something in the app writes to stdout directly.');
  const document = run.document as { format?: unknown; entries?: unknown; warnings?: unknown };
  if (document.format !== 1 || !Array.isArray(document.entries) || !Array.isArray(document.warnings)) {
    return failure('marmeon devtools:list printed a document this version does not read — update marmeon.');
  }
  // The format belongs to @marmeon/devtools: the document goes on as it is.
  return document as ToolDocument;
}
