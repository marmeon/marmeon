import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const bin = join(repo, 'packages/cli/bin/marmeon.js');
export const webApp = join(repo, 'apps/web-app');
export const tsc = join(repo, 'node_modules/.bin/tsc');

export function marmeon(cwd: string, args: string[], env: Record<string, string> = {}, timeout?: number) {
  // The launcher must re-exec, not think it is the child; and the web app here is the SQLite app of
  // .env.test — `pnpm test:pgsql` points app tests at Postgres, commands get that only when a test says so.
  const { MARMEON_CHILD: _child, DB_DRIVER: _connection, DB_URL: _url, ...parent } = process.env;
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout, env: { ...parent, NO_COLOR: '1', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A copy of the web app, with its `node_modules` (a symlink), for a command that writes into the app. */
export function webAppCopy(): string {
  const app = realpathSync(tempDir('marmeon-web-app-'));
  cpSync(webApp, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(webApp.length)) && !/[/\\]\.env$/.test(source) });
  symlinkSync(join(webApp, 'node_modules'), join(app, 'node_modules'), 'dir');
  mkdirSync(join(app, 'storage'));
  return app;
}

/** The fixture's `services/Greeter.ts`, whose constructor takes `parameters` (a `Clock`, maybe a `Redactor`). */
export function greeter(parameters: string[]): string {
  return [
    "import { Clock, Redactor } from '@marmeon/core';",
    'export class Greeter {',
    '  readonly #parts: object[];',
    `  constructor(${parameters.join(', ')}) {`,
    `    this.#parts = [${parameters.map((parameter) => parameter.split(':')[0]).join(', ')}];`,
    '  }',
    '  describe(): string {',
    "    return this.#parts.map((part) => part.constructor.name).join('+');",
    '  }',
    '}',
    "export type Unused = Redactor;",
    '',
  ].join('\n');
}
