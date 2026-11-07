import { hash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ConfigError } from './environment.ts';
import { injectConstructorDependencies } from './injection/analyze.ts';
import { mailViewFiles } from './injection/artifacts.ts';
import { compileMailView, jsxOptions, mailViewPath } from './mail-views.ts';
import { unreadableGeneratedPath, unsafeGeneratedPath } from './paths.ts';

/**
 * The app's mail views, compiled by `marmeon build` — so a production start never loads oxc-transform. Per mail view
 * (`modules/<module>/mail/**.tsx`, keyed by the path after symlinks, relative to the app) the file keeps the SHA-256 of the source
 * and the JavaScript the load hook would produce: injection lists applied, JSX compiled. Its own file, so `injections.json` keeps its format.
 * The code of an entry is only ever handed out for the bytes it was compiled from; any other source is compiled at start (when
 * oxc-transform is installed) or refused — never loaded as written.
 */
export const MAIL_VIEWS_FILE = '.marmeon/mail-views.json';

const FORMAT = 1;

export interface MailViewsFile {
  readonly format: typeof FORMAT;
  /** The `jsxImportSource` the code was compiled with: an entry is served only while the app's setting is still this one. */
  readonly jsxImportSource: string;
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly code: string }>>;
}

const sha256 = (source: Uint8Array) => hash('sha256', source, 'hex');

/** A mail view's key: its real path relative to the app's real path, with `/` separators. The same at build time and at start. */
export function mailViewName(realRoot: string, realFile: string): string {
  return relative(realRoot, realFile).split(sep).join('/');
}

/** Compiles every mail view of the app in `root` (what {@link writeMailViewArtifacts} writes, without writing). Throws the `ConfigError` of a missing or unusable oxc-transform. */
export function computeMailViewArtifacts(root: string): MailViewsFile {
  const realRoot = realpathSync.native(root);
  const files: Record<string, { sha256: string; code: string }> = {};
  for (const file of mailViewFiles(root)) {
    const real = mailViewPath(root, file);
    const bytes = readFileSync(real);
    const name = mailViewName(realRoot, real);
    const source = bytes.toString('utf8');
    const injected = source.includes('constructor') ? injectConstructorDependencies(source, name) : source;
    files[name] = { sha256: sha256(bytes), code: compileMailView(name, injected, { ...jsxOptions(realRoot), sourceName: basename(real) }) };
  }
  return { format: FORMAT, jsxImportSource: jsxOptions(realRoot).importSource, files };
}

/**
 * Writes {@link MAIL_VIEWS_FILE} (atomically: a temporary file renamed into place) — `marmeon build` runs it after the injection lists. An app
 * without mail views gets no file, and one left by an earlier build is removed. Throws a `ConfigError` when `.marmeon` leads out of the
 * app, or when there are mail views and oxc-transform is not installed.
 */
export function writeMailViewArtifacts({ root }: { root: string }): { path: string; views: number } {
  const path = join(root, MAIL_VIEWS_FILE);
  const refused = unsafeGeneratedPath(root, path);
  if (refused !== undefined) throw new ConfigError(refused);
  const { files, jsxImportSource } = computeMailViewArtifacts(root);
  const names = Object.keys(files).sort();
  if (names.length === 0) {
    rmSync(path, { force: true });
    return { path, views: 0 };
  }
  const lines = names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(files[name])}`);
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `{\n "format": ${FORMAT},\n "jsxImportSource": ${JSON.stringify(jsxImportSource)},\n "files": {\n${lines.join(',\n')}\n }\n}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path, views: names.length };
}

/** The load hook's side of {@link MAIL_VIEWS_FILE}: the compiled code of a mail view whose source is the one `marmeon build` saw. */
export class PrecomputedMailViews {
  readonly #files: MailViewsFile['files'];
  readonly #jsxImportSource: string | undefined;

  private constructor(files: MailViewsFile['files'], jsxImportSource?: string) {
    this.#files = files;
    this.#jsxImportSource = jsxImportSource;
  }

  /**
   * Reads `root`'s {@link MAIL_VIEWS_FILE}. No file is no error (every mail view is then compiled at start, or refused). Fails closed
   * otherwise: a `.marmeon` that leads out of the app, a file that cannot be read, is not JSON or has another shape throws a `ConfigError`,
   * because its code would run.
   */
  static load(root: string): PrecomputedMailViews {
    const file = join(root, MAIL_VIEWS_FILE);
    const refused = unreadableGeneratedPath(root, file);
    if (refused !== undefined) throw new ConfigError(refused);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new PrecomputedMailViews({});
      throw new ConfigError(`${MAIL_VIEWS_FILE} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}) — run marmeon build again.`);
    }
    const malformed = () => new ConfigError(`${MAIL_VIEWS_FILE} is not what marmeon build writes (format ${FORMAT}) — delete it and run marmeon build again.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw malformed();
    }
    const { format, files, jsxImportSource } = (parsed ?? {}) as { format?: unknown; files?: unknown; jsxImportSource?: unknown };
    if (format !== FORMAT || typeof jsxImportSource !== 'string' || typeof files !== 'object' || files === null || Array.isArray(files)) throw malformed();
    for (const entry of Object.values(files)) {
      const { sha256, code } = (entry ?? {}) as { sha256?: unknown; code?: unknown };
      if (typeof entry !== 'object' || typeof sha256 !== 'string' || typeof code !== 'string') throw malformed();
    }
    return new PrecomputedMailViews(files as MailViewsFile['files'], jsxImportSource);
  }

  /** The compiled code of the mail view `name` (see {@link mailViewName}) when `bytes` are the source it was compiled from and the app's `jsxImportSource` is the one it was compiled with, otherwise `undefined`. */
  code(name: string, bytes: Uint8Array, jsxImportSource: string): string | undefined {
    if (this.#jsxImportSource !== jsxImportSource) return undefined;
    const entry = Object.hasOwn(this.#files, name) ? this.#files[name] : undefined;
    return entry !== undefined && entry.sha256 === sha256(bytes) ? entry.code : undefined;
  }
}
