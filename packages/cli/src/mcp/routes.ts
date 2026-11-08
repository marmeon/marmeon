import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_LIMIT = 200;
const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

/** The routes of the app, as `marmeon route:list --json` prints them, filtered and cut. */
export const ROUTES_TOOL: McpTool = {
  name: 'routes',
  description: `List the routes the app registers: methods, path, name, group, middleware, who may call it, the action and whether the route is an island. Starts the app once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n]+$', description: 'Only routes whose path contains this text.' },
      name: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n]+$', description: 'Only routes whose name starts with this text.' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], description: 'Only routes that answer this method.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_LIMIT, description: `At most this many routes (default ${DEFAULT_LIMIT}).` },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: listRoutes,
};

interface Route {
  readonly methods: readonly string[];
  readonly path: string;
  readonly name: string | null;
}

async function listRoutes(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  const run = await runMarmeonJson(root, ['route:list', '--json'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('The app did not answer in time: route:list was stopped after 120 seconds.');
  if (run.tooLarge) return failure('route:list printed more than 16 MiB; the result was dropped.');
  if (run.code !== 0) return failure(`The app did not start: ${run.stderrTail.trim() || `marmeon route:list ended with code ${run.code}`}`);
  if (run.document === undefined) return failure("marmeon route:list did not print one JSON document: something in the app writes to stdout directly.");
  const document = run.document as { format?: unknown; routes?: unknown } | undefined;
  if (document?.format !== 1 || !Array.isArray(document.routes)) {
    return failure('marmeon route:list printed a document this version does not read — update marmeon.');
  }
  const path = typeof input.path === 'string' ? input.path : undefined;
  const name = typeof input.name === 'string' ? input.name : undefined;
  const method = typeof input.method === 'string' ? input.method : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
  const matching = (document.routes as Route[]).filter(
    (route) => (path === undefined || route.path.includes(path)) && (name === undefined || (route.name ?? '').startsWith(name)) && (method === undefined || route.methods.includes(method)),
  );
  return { format: 1, routes: matching.slice(0, limit), total: matching.length, truncated: matching.length > limit, warnings: [] };
}
