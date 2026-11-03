import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { Redactor } from '@marmeon/core';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SerialQueue } from './queue.ts';
import { DATA_NOTICE, failure, toResult } from './result.ts';
import { TOOLS, type McpTool } from './tools.ts';

const INSTRUCTIONS = `These tools read the app in this directory while it is in development; none changes it. ${DATA_NOTICE}`;

/**
 * Serves the tools over stdio until the client closes stdin or the process is asked to end. `write` is the original stdout: the
 * protocol is the only thing that reaches it (`main.ts` sends everything else to stderr). There is no other transport and no
 * listener. Loaded only by `commands/mcp.ts`, after it checked that the app is in development.
 */
export async function serve({ root, write }: { readonly root: string; readonly write: (text: string) => void }): Promise<number> {
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      done();
    },
  });
  const ending = new AbortController();
  const queue = new SerialQueue();
  const handle = serveStdio(() => buildServer(root, queue, ending.signal), { transport: new StdioServerTransport(process.stdin, stdout) });

  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  // A child that still runs is told to end; the server does not wait for it.
  ending.abort();
  await handle.close();
  return 0;
}

function buildServer(root: string, queue: SerialQueue, ending: AbortSignal): McpServer {
  const server = new McpServer({ name: 'marmeon', version: packageVersion() }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema), annotations: { readOnlyHint: true, openWorldHint: false } },
      async (input, context) => {
        const signal = AbortSignal.any([ending, context.mcpReq.signal]);
        return toResult(await call(tool, queue, { input, root, signal }));
      },
    );
  }
  return server;
}

async function call(tool: McpTool, queue: SerialQueue, { input, root, signal }: { readonly input: Readonly<Record<string, unknown>>; readonly root: string; readonly signal: AbortSignal }) {
  const refused = tool.admit?.();
  if (refused) return refused;
  const run = () => tool.run(input, { root, signal });
  try {
    return await (tool.spawns ? queue.run(run) : run());
  } catch (error) {
    return failure(`The tool ${tool.name} failed: ${new Redactor().text(error instanceof Error ? error.message : String(error))}`);
  }
}

/** The version of the `marmeon` package, from its manifest (next to `src/` and `dist/`). */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
