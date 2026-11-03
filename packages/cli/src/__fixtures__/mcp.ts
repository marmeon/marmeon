import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { bin, repo } from './cli.ts';

const blank = join(repo, 'apps/blank-app');

/** The lines a test app's boot appends to `MCP_BOOT_LOG`, and the text it prints when `MCP_BOOT_NOISE` is set (see `mcpApp`). */
const BOOT_HOOK = [
  "import { appendFileSync } from 'node:fs';",
  "if (process.env.MCP_BOOT_LOG) appendFileSync(process.env.MCP_BOOT_LOG, 'boot\\n');",
  "if (process.env.MCP_BOOT_NOISE) console.log(process.env.MCP_BOOT_NOISE);",
  '',
].join('\n');

/**
 * A copy of `apps/blank-app` that runs in development (its `.env`), with a hook in a module that records each boot of the app in
 * the file `MCP_BOOT_LOG` names and prints `MCP_BOOT_NOISE` to stdout when that is set. `env` replaces the lines of the `.env`.
 */
export function mcpApp(env: readonly string[] = ['NODE_ENV=development']): string {
  const app = realpathSync(tempDir('marmeon-mcp-app-'));
  cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
  mkdirSync(join(app, 'storage'));
  const testEnv = readFileSync(join(blank, '.env.test'), 'utf8');
  writeFileSync(join(app, '.env'), `${env.join('\n')}\n${testEnv}`);
  const module = join(app, 'modules/system/index.ts');
  writeFileSync(module, BOOT_HOOK + readFileSync(module, 'utf8'));
  return app;
}

/** The environment of a `marmeon` process of these tests: the one of this run, with `NODE_ENV` as the test says (`undefined`: not set). */
export function mcpEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const { MARMEON_CHILD: _child, NODE_ENV: _env, DB_DRIVER: _driver, DB_URL: _url, ...parent } = process.env;
  const env: Record<string, string | undefined> = { ...parent, NO_COLOR: '1', ...overrides };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export interface McpSession {
  readonly child: ChildProcess;
  /** Sends one JSON-RPC message. */
  send(message: Record<string, unknown>): void;
  /** Sends a request and resolves with the response of the same id. */
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Every line the server wrote to stdout so far, unparsed. */
  readonly stdoutLines: readonly string[];
  readonly stderr: () => string;
  /** Ends stdin and resolves with the exit code once the server ended. */
  close(): Promise<number | null>;
}

/**
 * `marmeon mcp` in `cwd` and a client that speaks JSON-RPC to it line by line, the way the protocol frames stdio. Every line on
 * stdout is kept as it came: `isFrame` tells a test whether every line is a message.
 */
export function mcpSession(cwd: string, env: Record<string, string> = mcpEnv({ NODE_ENV: 'development' })): McpSession {
  const child = spawn(process.execPath, [bin, 'mcp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutLines: string[] = [];
  const waiting = new Map<number, (message: Record<string, any>) => void>();
  let stderr = '';
  let rest = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) {
      stdoutLines.push(line);
      const message = parse(line);
      if (typeof message?.id === 'number') waiting.get(message.id)?.(message);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const ended = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  const send = (message: Record<string, unknown>) => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    child,
    send,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        send({ id, method, params });
      });
    },
    stdoutLines,
    stderr: () => stderr,
    close() {
      child.stdin.end();
      return ended;
    },
  };
}

function parse(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
}

/** Whether `line` is a JSON-RPC 2.0 message — what stdout may carry, and nothing else. */
export function isFrame(line: string): boolean {
  return parse(line)?.jsonrpc === '2.0';
}

/** `initialize` and the notification that follows it, the way a client of the 2025 revision opens a session. */
export async function initialize(session: McpSession, protocolVersion = '2025-06-18'): Promise<Record<string, any>> {
  const response = await session.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  session.send({ method: 'notifications/initialized' });
  return response;
}

/** The preload that records loads of the MCP SDK (`MCP_SDK_LOG`) and writes noise on SIGUSR2 (`MCP_NOISE`). */
export const PRELOAD = new URL('./mcp-preload.mjs', import.meta.url).pathname;

/** `NODE_OPTIONS` of this run with the preload added. */
export function withPreload(): string {
  return `${process.env.NODE_OPTIONS ?? ''} --import=${PRELOAD}`.trim();
}
