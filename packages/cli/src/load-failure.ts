import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strip } from './strip-types.ts';

const FRAME = /^\s+at (?:.* \()?(file:\/\/\/[^\s)]+?|\/[^\s)]+?|[A-Za-z]:[\\/][^\s)]+?):(\d+):(\d+)\)?$/;
const HEADER = /^(file:\/\/\/.+?|\/.+?|[A-Za-z]:[\\/].+?):(\d+)$/;

/** `path` relative to the app, when it is a file of the app itself (not a package, not Node's own). */
function insideApp(path: string, root: string): string | undefined {
  let absolute: string;
  try {
    absolute = path.startsWith('file://') ? fileURLToPath(path) : path;
  } catch {
    return undefined;
  }
  const inside = relative(root, absolute);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('node_modules')) return undefined;
  return inside.split(sep).join('/');
}

const compileFailures = new WeakMap<Error, { url: string; line?: number; column?: number }>();

/** Sources above this size are not parsed a second time. */
const MAX_CHECKED_SOURCE = 4 * 1024 * 1024;

/**
 * Whether `error` is a syntax error Node's ESM loader raised when it compiled a module, which names no file: no `path:line` head and
 * the first frame inside `node:internal/modules/esm/`.
 */
export function isLoaderCompileError(error: unknown): error is Error {
  if (!(error instanceof Error) || error.name !== 'SyntaxError' || HEADER.test((error.stack ?? '').split('\n')[0] ?? '')) return false;
  const first = (error.stack ?? '').split('\n').find((line) => /^\s+at /.test(line));
  return first?.includes('node:internal/modules/esm/') === true;
}

/**
 * Remembers the `file:` URL of the module that failed to compile with `error`, for {@link appFrameOf}; the error itself stays as it
 * is. With the `format` and `source` the loader compiled, it also works out the line, see {@link compilePosition}.
 */
export function noteCompileFailure(error: Error, url: string, loaded?: { format?: string | null; source?: unknown }): void {
  const position = loaded ? compilePosition(loaded.source, loaded.format, error) : undefined;
  compileFailures.set(error, { url, ...position });
}

/** `env` without `NODE_OPTIONS`, whatever its case (Windows names are case-insensitive). */
export function withoutNodeOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'));
}

/**
 * Where V8 finds `error` in `source`, the exact source the loader compiled, by parsing it once more with `node --check` as a module:
 * V8 gives a syntax error no place when it compiles a module for the loader. Only a module's source is parsed (`TypeScript` after its
 * types are stripped to spaces, as the loader does, so lines and columns hold). The place counts only when the child fails with
 * the very same message; `undefined` for anything else — another format, a source over 4 MiB, a failing strip, a child that
 * times out or is killed. The `column` is missing when V8 ends the input.
 */
export function compilePosition(
  source: unknown,
  format: string | null | undefined,
  error: Error,
  { timeout = 5000 }: { timeout?: number } = {},
): { line: number; column?: number } | undefined {
  if (format !== 'module' && format !== 'module-typescript') return undefined;
  if (typeof source !== 'string' && !(source instanceof Uint8Array)) return undefined;
  if ((typeof source === 'string' ? source.length : source.byteLength) > MAX_CHECKED_SOURCE) return undefined;
  let text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  if (format === 'module-typescript') {
    try {
      text = strip(text);
    } catch {
      return undefined;
    }
  }
  // A preload in NODE_OPTIONS (`--require`, `--import`) runs under `--check` too, which would run the app's code a second time.
  const env = withoutNodeOptions(process.env);
  const child = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], {
    input: text,
    env,
    cwd: tmpdir(),
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (child.error || child.signal || child.status === null || child.status === 0) return undefined;
  const lines = child.stderr.split('\n');
  const at = lines.findIndex((line) => /^\[stdin\]:\d+$/.test(line));
  if (at < 0) return undefined;
  const rest = lines.slice(at);
  const reported = rest.find((line) => line.startsWith(`${error.name}:`));
  if (reported !== `${error.name}: ${error.message}`) return undefined;
  const column = caretColumn(rest);
  return { line: Number(rest[0]!.slice('[stdin]:'.length)), ...(column > 0 && { column }) };
}

/** The column of the caret Node prints under the source line of a syntax error, between the `path:line` head and the error line (context lines above the source line may be empty). */
function caretColumn(lines: string[]): number {
  for (const line of lines.slice(1)) {
    if (/^\w*Error[\s:[]/.test(line)) return 0;
    if (/^\s*\^+\s*$/.test(line)) return line.indexOf('^') + 1;
  }
  return 0;
}

/**
 * Where in the app an error came from, as `modules/x/file.ts:12:3` (or `:12` when Node gives no column, or the file alone when only the load hook knew it): the first stack frame inside
 * the app root — not a package, not `node:` — of the error or, failing that, of its `cause` chain. A syntax error Node's loader finds
 * when it compiles a `.ts` file starts its stack with `path:line` and a caret line, which is read instead; the frames of such an error
 * are the importers of the broken file and are skipped. A syntax error only V8 reports names no file either: the load hook's file is
 * taken, with the line from a second parse of that source by V8 ({@link compilePosition}). `undefined` when no place in the app is known.
 */
export function appFrameOf(error: unknown, root: string): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 10; current = current.cause, depth++) {
    const lines = (current.stack ?? '').split('\n');
    const header = HEADER.exec(lines[0] ?? '');
    const head = header && insideApp(header[1]!, root);
    if (header && head) {
      const column = caretColumn(lines);
      return `${head}:${header[2]}${column > 0 ? `:${column}` : ''}`;
    }
    const first = lines.find((line) => /^\s+at /.test(line));
    if (current.name === 'SyntaxError' && first?.includes('node:internal/modules/')) {
      // Compiled by the loader: the file is known only when the load hook saw it, the line only when V8 gave it on a second parse.
      const noted = compileFailures.get(current);
      const file = noted && insideApp(noted.url, root);
      if (file) return noted.line === undefined ? file : `${file}:${noted.line}${noted.column === undefined ? '' : `:${noted.column}`}`;
      continue;
    }
    for (const line of lines) {
      const frame = FRAME.exec(line);
      const file = frame && insideApp(frame[1]!, root);
      if (frame && file) return `${file}:${frame[2]}:${frame[3]}`;
    }
  }
  return undefined;
}
