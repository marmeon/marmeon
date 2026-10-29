import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const compileFailures = new WeakMap<Error, string>();

/**
 * Whether `error` is a syntax error Node's ESM loader raised when it compiled a module, which names no file: no `path:line` head and
 * the first frame inside `node:internal/modules/esm/`.
 */
export function isLoaderCompileError(error: unknown): error is Error {
  if (!(error instanceof Error) || error.name !== 'SyntaxError' || HEADER.test((error.stack ?? '').split('\n')[0] ?? '')) return false;
  const first = (error.stack ?? '').split('\n').find((line) => /^\s+at /.test(line));
  return first?.includes('node:internal/modules/esm/') === true;
}

/** Remembers the `file:` URL of the module that failed to compile with `error`, for {@link appFrameOf}; the error itself stays as it is. */
export function noteCompileFailure(error: Error, url: string): void {
  compileFailures.set(error, url);
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
 * are the importers of the broken file and are skipped. `undefined` when no place in the app is known.
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
      // Compiled by the loader: the file is known only when the load hook saw it; Node names no line then.
      const noted = compileFailures.get(current);
      const file = noted && insideApp(noted, root);
      if (file) return file;
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
