import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as OxcTransform from 'oxc-transform';
import { ConfigError } from './environment.ts';

/**
 * The only TSX the server loads: the mail views of an app's modules. The same folder `SERVER_MODULES` in `@marmeon/vite` treats as
 * server code (`modules/<module>/mail/`), so nothing that is compiled here can be imported by client code, and no page view ever
 * runs in Node.
 */
const MAIL_VIEW = 'modules/*/mail/**/*.tsx';

/** The range of the optional peer `oxc-transform` in this package's manifest (a test keeps the two equal). */
export const OXC_TRANSFORM_RANGE = '>=0.157.0 <1.0.0';

/** Whether a URL names a `.tsx` file Node would otherwise refuse, as the file path; `undefined` for any other URL and for `node_modules`. */
export function tsxFileOf(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return undefined; // not a file path (an encoded separator, a foreign host): the loader's own error is the answer
  }
  if (!/\.tsx$/i.test(file) || file.split(/[\\/]/).includes('node_modules')) return undefined;
  return file;
}

/** One path's relative form, when it is a candidate: inside the app, no `..`, no backslash, never below `node_modules`, matching the glob (case-sensitive). */
function candidate(rel: string): boolean {
  if (rel === '' || isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) return false;
  const segments = rel.split(sep);
  if (segments.includes('..') || segments.includes('node_modules')) return false;
  return matchesGlob(segments.join('/'), MAIL_VIEW);
}

/**
 * Why `file` is not a mail view of the app in `root`, or `undefined` when it is. Fails closed: the path as written and the
 * path after symlinks are resolved must both lie in `modules/<module>/mail/` of the app, so a link in the folder cannot pull in a
 * file from elsewhere, and a link from elsewhere cannot borrow the folder; a path that cannot be resolved is refused.
 */
export function mailViewRefusal(root: string, file: string): string | undefined {
  return judge(root, file).refusal;
}

/** The verdict on `file`: its refusal, or the real path that was judged — the one to read. */
function judge(root: string, file: string): { refusal: string; real?: undefined } | { refusal?: undefined; real: string } {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(file);
  } catch {
    return { refusal: `${file} cannot be resolved` };
  }
  const absolute = resolve(file);
  const written = candidate(relative(realRoot, absolute)) || candidate(relative(resolve(root), absolute));
  if (written && candidate(relative(realRoot, real))) return { real };
  const shown = relative(realRoot, absolute);
  return { refusal: `${shown.startsWith('..') || isAbsolute(shown) ? file : shown.split(sep).join('/')} is TSX outside modules/<module>/mail/. On the server, TSX is loaded only for mail views; a page's view is rendered by Vite: name it, do not import it.` };
}

/** Whether `file` is a mail view of the app in `root` (see {@link mailViewRefusal}). */
export function isMailView(root: string, file: string): boolean {
  return mailViewRefusal(root, file) === undefined;
}

/** The module `jsxImportSource` may name: a package, optionally scoped, with subpaths — nothing that could end the string it is written into. */
const IMPORT_SOURCE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/i;

const jsxOfRoot = new Map<string, { importSource: string }>();

/** JSON with comments and trailing commas (a `tsconfig.json`). */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/^\uFEFF/, '').replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : ' '));
  return JSON.parse(withoutComments.replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, (match) => (match.startsWith('"') ? match : '')));
}

/**
 * The JSX setting of the app, from `compilerOptions` in `<root>/tsconfig.json` (read once per process; `extends` is not followed, so
 * what is not written there is the default, `react`). Only the automatic runtime is supported: `jsx` must be `react-jsx`,
 * `react-jsxdev` or unset. Throws a {@link ConfigError} for anything else.
 */
export function jsxOptions(root: string): { importSource: string } {
  const cached = jsxOfRoot.get(root);
  if (cached) return cached;
  const path = join(root, 'tsconfig.json');
  let compilerOptions: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw new ConfigError(`${path} cannot be read (${(error as { code?: unknown }).code ?? 'unknown error'}), so the JSX setting of the mail views is unknown.`);
    // No tsconfig.json: the defaults.
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch {
      throw new ConfigError(`${path} is not valid JSON, so the JSX setting of the mail views cannot be read.`);
    }
    const options = (parsed as { compilerOptions?: unknown } | null)?.compilerOptions;
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) throw new ConfigError(`${path}: "compilerOptions" must be an object.`);
    compilerOptions = (options ?? {}) as Record<string, unknown>;
  }
  const jsx = compilerOptions.jsx;
  if (jsx !== undefined && (typeof jsx !== 'string' || !['react-jsx', 'react-jsxdev'].includes(jsx.toLowerCase()))) {
    throw new ConfigError(`${path}: "jsx" is ${JSON.stringify(jsx)}; mail views are compiled with the automatic runtime — set "jsx": "react-jsx" (or leave it out).`);
  }
  const importSource = compilerOptions.jsxImportSource ?? 'react';
  if (typeof importSource !== 'string' || !IMPORT_SOURCE.test(importSource)) {
    throw new ConfigError(`${path}: "jsxImportSource" must be a package name such as "react", not ${JSON.stringify(importSource)}.`);
  }
  const options = { importSource };
  jsxOfRoot.set(root, options);
  return options;
}

let transformer: typeof OxcTransform | undefined;

function oxcTransform(): typeof OxcTransform {
  if (transformer) return transformer;
  let loaded: typeof OxcTransform;
  try {
    loaded = createRequire(import.meta.url)('oxc-transform') as typeof OxcTransform;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'MODULE_NOT_FOUND') throw error;
    throw new ConfigError(`Mail views are TSX and need oxc-transform to be compiled. Install it: pnpm add -D "oxc-transform@${OXC_TRANSFORM_RANGE}"`);
  }
  if (typeof (loaded as Partial<typeof OxcTransform> | null)?.transformSync !== 'function') {
    throw new ConfigError(`The installed oxc-transform has no transformSync; mail views need a version in ${OXC_TRANSFORM_RANGE}. Install it: pnpm add -D "oxc-transform@${OXC_TRANSFORM_RANGE}"`);
  }
  transformer = loaded;
  return transformer;
}

/**
 * The JavaScript of a mail view: TypeScript types erased (`import type` only, as with `verbatimModuleSyntax`), JSX compiled with the
 * automatic runtime of `importSource`, an inline source map appended. oxc-transform is loaded on the first call and synchronously — the load
 * hook cannot await. A syntax error becomes a `SyntaxError` that names `file:line:column`.
 */
export function compileMailView(file: string, source: string, { importSource }: { importSource: string }): string {
  const result = oxcTransform().transformSync(file, source, {
    lang: 'tsx',
    sourceType: 'module',
    typescript: { onlyRemoveTypeImports: true },
    jsx: { runtime: 'automatic', importSource, development: false },
    sourcemap: true,
  });
  const failure = result.errors.find((error) => error.severity === 'Error');
  if (failure) throw compileError(file, source, failure);
  const map = Buffer.from(JSON.stringify(result.map)).toString('base64');
  return `${result.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`;
}

/**
 * The error for a failed compile. Its stack starts the way Node prints a syntax error it found itself (`path:line`, the line, a caret),
 * so the command line shows the place in the app like any other.
 */
function compileError(file: string, source: string, failure: OxcTransform.OxcError): SyntaxError {
  const offset = failure.labels[0]?.start ?? 0;
  // oxc counts bytes of the UTF-8 source, not UTF-16 units.
  const before = Buffer.from(source).subarray(0, offset).toString('utf8');
  const line = before.split('\n').length;
  const column = before.length - (before.lastIndexOf('\n') + 1) + 1; // UTF-16 units of the decoded text, like the line
  const error = new SyntaxError(`${file}:${line}:${column} — ${failure.message}`);
  const text = source.split('\n')[line - 1] ?? '';
  error.stack = `${file}:${line}\n${text}\n${' '.repeat(column - 1)}^\n\n${error.name}: ${error.message}`;
  return error;
}

/** What the load hook does with a `.tsx` file outside `node_modules`: refuse it, or return its path after symlinks (the file that was judged) — read that one. */
export function mailViewPath(root: string, file: string): string {
  const verdict = judge(root, file);
  if (verdict.refusal !== undefined) throw new Error(verdict.refusal);
  return verdict.real;
}
