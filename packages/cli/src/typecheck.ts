import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export type TypecheckResult =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly errors: number; readonly files: number; readonly output: string }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'missing' };

/**
 * Type-checks the app with its own TypeScript (`tsc --noEmit -p <root>`), as `next build` does — so a renamed route,
 * a view that no longer exists or a wrong prop fails the build, not the user. TypeScript is looked up through the
 * app's `node_modules` chain, like an ESM import (pnpm's bin shims would point `require.resolve` elsewhere).
 */
export async function typecheckApp(root: string): Promise<TypecheckResult> {
  if (!existsSync(join(root, 'tsconfig.json'))) return { status: 'skipped', reason: 'no tsconfig.json' };
  const tsc = findTsc(root);
  if (!tsc) return { status: 'missing' };

  const pretty = process.stdout.isTTY === true;
  const { code, output } = await run(process.execPath, [tsc, '--noEmit', '-p', root, '--pretty', String(pretty)], root);
  if (code === 0) return { status: 'passed' };
  const plain = stripVTControlCharacters(output);
  // `file.ts(3,7): error TS…` (plain) or `file.ts:3:7 - error TS…` (pretty) — one line per error.
  const located = [...plain.matchAll(/^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)(?::| -) error TS\d+/gm)];
  const files = new Set(located.map((match) => match[1])).size;
  return { status: 'failed', errors: Math.max(located.length, 1), files, output };
}

/** `node_modules/typescript/<bin.tsc>` of the app, or undefined. */
function findTsc(root: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', 'typescript', 'package.json');
    if (existsSync(manifest)) {
      const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
      const path = typeof bin === 'string' ? bin : bin?.tsc;
      return path ? join(dirname(manifest), path) : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code: code ?? (signal ? 1 : 0), output }));
  });
}
