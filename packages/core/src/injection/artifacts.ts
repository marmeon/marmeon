import { hash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { analyzeInjections, applyInsertions, injectConstructorDependencies, insertionsOf, mayHaveInsertions, type Insertion } from './analyze.ts';
import { isBrowserSource } from './browser.ts';
import { ConfigError } from '../environment.ts';
import { isMailView } from '../mail-views.ts';
import { unreadableGeneratedPath, unsafeGeneratedPath } from '../paths.ts';

/**
 * The app's injection lists, precomputed by `marmeon build` — so a production start neither parses the app with oxc
 * nor loads oxc-parser. The app stays `.ts`: the file keeps, per module, only what the load hook would insert
 * (the same analysis, {@link analyzeInjections} + {@link insertionsOf}, line-preserving) and the SHA-256 of the source it was
 * derived from. A start checks the hash of every module it loads; one that changed since the build (or is not in the file) is
 * analysed as in development — never trusted blindly — and the start says so once ("build artifacts are stale").
 */
export const INJECTIONS_FILE = '.marmeon/injections.json';

const FORMAT = 2;

export interface InjectionsFile {
  readonly format: typeof FORMAT;
  /** Per module, relative to the app (`/` separators): the source's SHA-256 and the insertions. */
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly insert: readonly Insertion[] }>>;
}

/** Directories of an app that hold no module a start loads through the hook. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'storage', 'coverage']);

/** A module the hook transforms: TypeScript Node runs (not declarations) or a mail view (`.tsx`, see {@link isMailView}), no tests. */
const MODULE = /(?<!\.d)\.(?:[cm]?ts|tsx)$/;
const TEST = /\.(test|spec)\.(?:[cm]?ts|tsx)$/;

/**
 * The name the analysis gives a module of the app in its messages ("Cannot inject modules/…/X.ts:12 — …"): the path
 * relative to the app — the same at build time and at start, and no build-machine path in the artifact.
 */
function moduleName(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function sha256(source: string | Uint8Array): string {
  return hash('sha256', source, 'hex');
}

/**
 * What {@link writeInjectionArtifacts} writes, without writing it: every module of the app that mentions `constructor` or calls `island(` (the
 * analysis has nothing to do for the others), also those whose lists are empty, so a start can tell "derived, nothing to
 * insert" from "not derived".
 */
export function computeInjectionArtifacts(root: string): InjectionsFile {
  const files: Record<string, { sha256: string; insert: Insertion[] }> = {};
  for (const file of appModules(root)) {
    const bytes = readFileSync(file);
    const source = bytes.toString('utf8');
    if (!mayHaveInsertions(source) || isBrowserSource(file)) continue;
    const name = moduleName(root, file);
    files[name] = { sha256: sha256(bytes), insert: insertionsOf(analyzeInjections(source, name)).filter(([, text]) => text !== '') };
  }
  return { format: FORMAT, files };
}

/**
 * Writes {@link INJECTIONS_FILE} for the app in `root` (atomically: a temporary file renamed into place) — what `marmeon build`
 * runs first. One line per module.
 */
export function writeInjectionArtifacts({ root }: { root: string }): { path: string; modules: number; classes: number } {
  const { files } = computeInjectionArtifacts(root);
  const names = Object.keys(files).sort();
  const lines = names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(files[name])}`);
  const path = join(root, INJECTIONS_FILE);
  const refused = unsafeGeneratedPath(root, path);
  if (refused !== undefined) throw new ConfigError(refused);
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `{\n "format": ${FORMAT},\n "files": {\n${lines.join(',\n')}\n }\n}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path, modules: names.length, classes: names.reduce((sum, name) => sum + files[name]!.insert.length, 0) };
}

/** The mail views `marmeon build` precompiles (see `mail-view-artifacts.ts`): the `.tsx` files {@link appModules} yields. */
export function* mailViewFiles(root: string): Generator<string> {
  for (const file of appModules(root)) if (file.endsWith('.tsx')) yield file;
}

function* appModules(root: string, dir = root): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) yield* appModules(root, join(dir, entry.name));
    } else if (entry.isFile() && MODULE.test(entry.name) && !TEST.test(entry.name)) {
      const file = join(dir, entry.name);
      if (!entry.name.endsWith('.tsx') || isMailView(root, file)) yield file;
    }
  }
}

/**
 * The load hook's side of {@link INJECTIONS_FILE}: hands out the precomputed insertions of an unchanged module and remembers
 * every module of the app it could not vouch for (changed since the build, not in the file, or no file at all) — those are
 * analysed like in development.
 */
export class PrecomputedInjections {
  readonly #root: string;
  readonly #files: InjectionsFile['files'];
  readonly #missing: boolean;
  readonly #stale: string[] = [];

  private constructor(root: string, files: InjectionsFile['files'], missing: boolean) {
    this.#root = root;
    this.#files = files;
    this.#missing = missing;
  }

  /** Reads `root`'s {@link INJECTIONS_FILE}. A missing or unreadable file is no error: every module is then analysed at start. Throws a `ConfigError` when `.marmeon` leads out of the app. */
  static load(root: string): PrecomputedInjections {
    const refused = unreadableGeneratedPath(root, join(root, INJECTIONS_FILE));
    if (refused !== undefined) throw new ConfigError(refused);
    try {
      const parsed = JSON.parse(readFileSync(join(root, INJECTIONS_FILE), 'utf8')) as Partial<InjectionsFile>;
      if (parsed.format === FORMAT && typeof parsed.files === 'object' && parsed.files !== null) return new PrecomputedInjections(root, parsed.files, false);
    } catch {
      // Not built (or by another version): analysed below.
    }
    return new PrecomputedInjections(root, {}, true);
  }

  /**
   * The module's source with its injection lists — the precomputed ones when the source is the one `marmeon build` saw,
   * otherwise derived now (and the module counted as stale). Modules outside the app (a workspace package's sources) are
   * analysed without counting: the file covers the app only.
   */
  transform(file: string, source: string | Uint8Array, decode: (source: Uint8Array) => string): string {
    const text = typeof source === 'string' ? source : decode(source);
    const name = moduleName(this.#root, file);
    if (name.startsWith('../') || name.startsWith('/')) return injectConstructorDependencies(text, file);
    const entry = Object.hasOwn(this.#files, name) ? this.#files[name] : undefined;
    if (entry && entry.sha256 === sha256(source)) return applyInsertions(text, entry.insert);
    // Without `constructor`, `island(` or `island as` the analysis has nothing to derive: only a listed module that changed is stale.
    if (!mayHaveInsertions(text)) {
      if (entry) this.#stale.push(name);
      return text;
    }
    this.#stale.push(name);
    return injectConstructorDependencies(text, name);
  }

  /** Counts a mail view that was compiled at start for the stale warning (once, whatever else counted it). */
  noteStale(name: string): void {
    if (!this.#stale.includes(name)) this.#stale.push(name);
  }

  /** The modules and mail views of the app that were analysed at start (in load order). */
  get stale(): readonly string[] {
    return this.#stale;
  }

  /** What the start says about stale artifacts — once per process (see {@link takeInjectionWarning}). */
  warning(): string | undefined {
    const count = this.#stale.length;
    if (count === 0) return undefined;
    const modules = `${count} file${count === 1 ? '' : 's'}`;
    const names = this.#stale.slice(0, 3).join(', ') + (count > 3 ? ', …' : '');
    return this.#missing
      ? `Build artifacts are missing (${INJECTIONS_FILE}): ${modules} (${names}) ${count === 1 ? 'was' : 'were'} analysed at start (injection lists with oxc-parser, mail views with oxc-transform) — run marmeon build before starting.`
      : `Build artifacts are stale (${modules}: ${names}): ${count === 1 ? 'it changed' : 'they changed'} since marmeon build, so ${count === 1 ? 'it was' : 'they were'} analysed at start (injection lists with oxc-parser, mail views with oxc-transform) — run marmeon build again.`;
  }
}

let active: PrecomputedInjections | undefined;
let warned = false;

/** Called by the load hook (`@marmeon/core/register`) when it uses the precomputed lists — in a protected environment. */
export function usePrecomputedInjections(precomputed: PrecomputedInjections): void {
  active = precomputed;
}

/**
 * The stale-artifacts warning of this process, the first time it is asked for after a module was analysed at start
 * (`createApplication` logs it after booting). `undefined` when everything came from {@link INJECTIONS_FILE}, in development
 * (no precomputed lists) and after the warning was given.
 */
export function takeInjectionWarning(): string | undefined {
  if (warned || !active) return undefined;
  const warning = active.warning();
  if (warning) warned = true;
  return warning;
}
