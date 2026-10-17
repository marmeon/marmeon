import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** One error of the type checker, located when tsc says where. */
export interface TypeDiagnostic {
  /** Relative to the app root, `/`-separated; absent for an error that belongs to no file (a bad compiler option). */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /** `TS2322`. */
  readonly code: string;
  /** The message with the indented lines that follow it. */
  readonly message: string;
}

export type TypecheckResult =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly errors: number; readonly files: number; readonly output: string; readonly diagnostics: readonly TypeDiagnostic[] }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'missing' };

/**
 * Type-checks the app with its own TypeScript (`tsc --noEmit -p <root>`), as `next build` does — so a renamed route,
 * a view that no longer exists or a wrong prop fails the build, not the user. TypeScript is looked up through the
 * app's `node_modules` chain, like an ESM import (pnpm's bin shims would point `require.resolve` elsewhere).
 */
export async function typecheckApp(root: string, options: { readonly pretty?: boolean } = {}): Promise<TypecheckResult> {
  if (!existsSync(join(root, 'tsconfig.json'))) return { status: 'skipped', reason: 'no tsconfig.json' };
  const tsc = findBin(root, 'typescript', 'tsc');
  if (!tsc) return { status: 'missing' };

  const pretty = options.pretty ?? process.stdout.isTTY === true;
  const { code, output } = await runNode([tsc, '--noEmit', '-p', root, '--pretty', String(pretty)], root);
  if (code === 0) return { status: 'passed' };
  const plain = stripVTControlCharacters(output);
  // `file.ts(3,7): error TS…` (plain) or `file.ts:3:7 - error TS…` (pretty) — one line per error.
  const located = [...plain.matchAll(/^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)(?::| -) error TS\d+/gm)];
  const files = new Set(located.map((match) => match[1])).size;
  return { status: 'failed', errors: Math.max(located.length, 1), files, output, diagnostics: parseDiagnostics(plain, root, pretty) };
}

/**
 * The errors in tsc's output: `file(3,7): error TS2322: …` with the indented lines under it (plain), or `file:3:7 - error TS…`
 * (pretty — its code frames are left out).
 */
function parseDiagnostics(plain: string, root: string, pretty: boolean): TypeDiagnostic[] {
  const found: TypeDiagnostic[] = [];
  let last: { -readonly [K in keyof TypeDiagnostic]: TypeDiagnostic[K] } | undefined;
  for (const text of plain.split(/\r?\n/)) {
    const located = /^(\S.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))(?::| -) error (TS\d+): (.*)$/.exec(text);
    const global = located ? null : /^error (TS\d+): (.*)$/.exec(text);
    if (located) {
      const file = relative(resolve(root), resolve(root, located[1]!)).split(sep).join('/');
      last = { file, line: Number(located[2] ?? located[4]), column: Number(located[3] ?? located[5]), code: located[6]!, message: located[7]! };
      found.push(last);
    } else if (global) {
      last = { code: global[1]!, message: global[2]! };
      found.push(last);
    } else if (last && !pretty && /^\s+\S/.test(text)) {
      last.message += `\n${text.trim()}`;
    } else {
      last = undefined;
    }
  }
  return found;
}

/** `node_modules/<name>/<bin>` of the app (looked up through its `node_modules` chain), or undefined. */
export function findBin(root: string, name: string, bin: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      const { bin: field } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
      const path = typeof field === 'string' ? field : field?.[bin];
      return path ? join(dirname(manifest), path) : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Runs a Node script of the app's tooling in `cwd`; stdout and stderr come back as one string. */
export function runNode(args: string[], cwd: string): Promise<{ code: number; output: string; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => (output += chunk));
    child.once('error', fail);
    child.once('exit', (code, signal) => done({ code: code ?? (signal ? 1 : 0), output, stdout }));
  });
}
