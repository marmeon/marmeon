import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { build, type InlineConfig, type Rolldown } from 'vite';

/**
 * Bundle measurements for the size budget, the leak test (Wave 5c, E75) and `pnpm size` — the method of the spike
 * `2026-10-02-client-kern-tree-shaking`, made repeatable: Vite's **app** mode as `bespoke build` runs it (not `lib`
 * mode, which leaves ES libraries partly unminified), production defines, minified, gzip level 9 per chunk.
 */

/** `packages/` — module ids are reported relative to it (`http/dist/client/navigation.js`). */
export const PACKAGES = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

/** Not part of the measurement: React comes from the app, i18n only when the app translates (an optional peer). */
export const EXTERNAL = /^(react|react-dom|@bespokecore\/i18n)(\/|$)/;

export interface BundleChunk {
  readonly fileName: string;
  /** Bytes, minified. */
  readonly min: number;
  /** Bytes, gzip level 9. */
  readonly gzip: number;
}

/** A module's part of a chunk: its minified bytes, and its share of the chunk's gzip (scaled, not stand-alone). */
export interface ModuleShare {
  readonly min: number;
  readonly gzip: number;
}

export interface AppBundle {
  /** Minified bytes of the initial chunks: the entries and what they import statically. */
  readonly min: number;
  /** gzip (level 9) bytes of the initial chunks, each compressed on its own — as a browser downloads them. */
  readonly gzip: number;
  /** The modules in the initial chunks, relative to `packages/` (an isolated build's entry is `(entry)`). */
  readonly modules: readonly string[];
  /** The initial chunks' code, joined. */
  readonly code: string;
  readonly initial: readonly BundleChunk[];
  /** Chunks loaded on demand (`import()`): listed, not counted. */
  readonly lazy: readonly BundleChunk[];
  /** The modules in those chunks (features loaded on first use, E74). */
  readonly lazyModules: readonly string[];
  /** With `sourcemap: true`: every byte of the initial and the lazy chunks attributed to its module, by source map. */
  readonly attribution?: {
    readonly initial: ReadonlyMap<string, ModuleShare>;
    readonly lazy: ReadonlyMap<string, ModuleShare>;
    /**
     * The marginal gzip of some modules in the initial chunks: what the download loses without their bytes (each chunk
     * compressed with and without them). Unlike the scaled shares, it does not grow when code is split into more modules.
     */
    marginalGzip(modules: (module: string) => boolean): number;
  };
}

let workspace: string | undefined;

/**
 * An app directory that depends on the framework packages as an app's `node_modules` would (symlinks to the workspace
 * packages), so their `exports` resolve without the `@bespokecore/source` condition: to `dist/`, what an app gets from
 * a published package. One per workspace checkout, reused (test workers end without an `exit` event to clean up after).
 */
function appDirectory(): string {
  if (workspace) return workspace;
  const dir = join(realpathSync(tmpdir()), `bespoke-bundle-${createHash('sha256').update(PACKAGES).digest('hex').slice(0, 12)}`);
  mkdirSync(join(dir, 'node_modules', '@bespokecore'), { recursive: true });
  for (const name of ['http', 'i18n', 'react']) {
    try {
      symlinkSync(join(PACKAGES, name), join(dir, 'node_modules', '@bespokecore', name), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; // made by an earlier (or a parallel) run
    }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bundle-measurement', private: true, type: 'module' }));
  return (workspace = dir);
}

let entries = 0;

export interface BundleOptions {
  /** What stays out of the bundle (default {@link EXTERNAL}). */
  external?: RegExp;
  /** Attribute every byte to its module (slower; for `pnpm size`). */
  sourcemap?: boolean;
}

/**
 * Builds `code` as an app's client entry, against the packages' `dist/` (run `pnpm build` first). Keep what you
 * measure reachable, e.g. `globalThis.__keep = { createBespokeApp }`, or tree-shaking drops it.
 */
export async function appBundle(code: string, { external = EXTERNAL, sourcemap = false }: BundleOptions = {}): Promise<AppBundle> {
  const root = appDirectory();
  const entry = join(root, `entry-${process.pid}-${threadId}-${++entries}.js`);
  writeFileSync(entry, code);
  try {
    return await measure(
      {
        configFile: false,
        root,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"production"' },
        resolve: { conditions: ['module', 'browser', 'production', 'import', 'default'] },
        build: {
          outDir: join(root, 'dist'),
          minify: true,
          modulePreload: false,
          rolldownOptions: { input: { entry }, external: (id) => external.test(id) },
        },
      },
      { sourcemap, entry },
    );
  } finally {
    rmSync(entry, { force: true });
  }
}

/**
 * The client build of a real app (its own `vite.config.ts`), measured the same way — nothing is written. In the
 * monorepo the framework packages come from `dist/` too: a build never takes the `@bespokecore/source` condition.
 */
export async function appClientBuild(root: string, { sourcemap = false }: Pick<BundleOptions, 'sourcemap'> = {}): Promise<AppBundle> {
  // Before Vite resolves the config: an unset NODE_ENV becomes "development", and React's development build with it.
  process.env.NODE_ENV = 'production';
  return measure({ root, logLevel: 'silent', build: {} }, { sourcemap });
}

async function measure(config: InlineConfig, { sourcemap, entry }: { sourcemap: boolean; entry?: string }): Promise<AppBundle> {
  let outDir = '';
  const result = (await build({
    ...config,
    mode: 'production',
    plugins: [...(config.plugins ?? []), { name: 'bespokecore:measure', configResolved: (resolved) => void (outDir = resolve(resolved.root, resolved.build.outDir)) }],
    // `hidden`: no `sourceMappingURL` comment, so the measured code is the shipped code.
    build: { ...config.build, write: false, sourcemap: sourcemap ? 'hidden' : false, reportCompressedSize: false },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];

  const chunks = (Array.isArray(result) ? result : [result]).flatMap(({ output }) => output.filter((item) => item.type === 'chunk'));
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const initial = new Set<Rolldown.OutputChunk>();
  const visit = (chunk: Rolldown.OutputChunk | undefined): void => {
    if (!chunk || initial.has(chunk)) return;
    initial.add(chunk);
    for (const imported of chunk.imports) visit(byName.get(imported));
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk);
  const lazy = chunks.filter((chunk) => !initial.has(chunk));

  const namesOf = (list: Iterable<Rolldown.OutputChunk>) => {
    const names = new Set<string>();
    for (const chunk of list) {
      for (const id of chunk.moduleIds) {
        if (id === entry) names.add('(entry)');
        else if (!id.startsWith('\0')) names.add(moduleName(id));
      }
    }
    return names;
  };
  const modules = namesOf(initial);
  const sizes = (chunk: Rolldown.OutputChunk): BundleChunk => ({
    fileName: chunk.fileName,
    min: Buffer.byteLength(chunk.code),
    gzip: gzipSync(chunk.code, { level: 9 }).length,
  });
  const initialSizes = [...initial].map(sizes);
  const attributed = (list: Iterable<Rolldown.OutputChunk>) => {
    const total = new Map<string, ModuleShare>();
    for (const chunk of list) {
      for (const [module, share] of attribute(chunk, join(outDir, dirname(chunk.fileName)), entry)) {
        const sum = total.get(module);
        total.set(module, sum ? { min: sum.min + share.min, gzip: sum.gzip + share.gzip } : share);
      }
    }
    return total;
  };
  return {
    min: initialSizes.reduce((sum, chunk) => sum + chunk.min, 0),
    gzip: initialSizes.reduce((sum, chunk) => sum + chunk.gzip, 0),
    modules: [...modules].sort(),
    code: [...initial].map((chunk) => chunk.code).join('\n'),
    initial: initialSizes,
    lazy: lazy.map(sizes),
    lazyModules: [...namesOf(lazy)].sort(),
    ...(sourcemap
      ? {
          attribution: {
            initial: attributed(initial),
            lazy: attributed(lazy),
            marginalGzip: (modules: (module: string) => boolean) =>
              [...initial].reduce((sum, chunk) => {
                const kept = segmentsOf(chunk, join(outDir, dirname(chunk.fileName)), entry).filter(([module]) => !modules(module));
                return sum + gzipSync(chunk.code, { level: 9 }).length - gzipSync(kept.map(([, text]) => text).join(''), { level: 9 }).length;
              }, 0),
          },
        }
      : {}),
  };
}

/** A module id as reported: relative to `packages/` for the framework, else relative to the working directory. */
function moduleName(id: string): string {
  let real = id;
  try {
    real = realpathSync(id);
  } catch {
    // virtual or gone: keep the id
  }
  const fromPackages = relative(PACKAGES, real).replaceAll('\\', '/');
  if (!fromPackages.startsWith('../')) return fromPackages;
  const nodeModules = real.lastIndexOf('/node_modules/');
  if (nodeModules !== -1) return real.slice(nodeModules + 1);
  return relative(process.cwd(), real).replaceAll('\\', '/');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Source map v3 `mappings` → per generated line, the segments `[column, source index | -1]`. */
function decodeMappings(mappings: string): [number, number][][] {
  const lines: [number, number][][] = [];
  let source = 0;
  for (const line of mappings.split(';')) {
    const segments: [number, number][] = [];
    let column = 0;
    for (const segment of line.split(',')) {
      if (!segment) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0]!;
      if (fields.length > 1) source += fields[1]!;
      segments.push([column, fields.length > 1 ? source : -1]);
      // fields 2–4 (original line, column, name) are relative too, but not needed here
    }
    lines.push(segments);
  }
  return lines;
}

/** A chunk's code in order, as `[module, text]` pieces by its source map — joined, they are the code again. */
function segmentsOf(chunk: Rolldown.OutputChunk, dir: string, entry: string | undefined): [string, string][] {
  const map = chunk.map;
  if (!map) throw new Error(`${chunk.fileName} has no source map.`);
  const sources = map.sources.map((source) => {
    const absolute = resolve(dir, source);
    return absolute === entry ? '(entry)' : moduleName(absolute);
  });
  const pieces: [string, string][] = [];
  const add = (module: string, text: string) => {
    if (text) pieces.push([module, text]);
  };
  const codeLines = chunk.code.split('\n');
  const mapped = decodeMappings(map.mappings);
  codeLines.forEach((text, index) => {
    const segments = mapped[index] ?? [];
    add('(unmapped)', text.slice(0, segments[0]?.[0] ?? text.length));
    segments.forEach(([column, source], at) => {
      add(source === -1 ? '(unmapped)' : sources[source]!, text.slice(column, segments[at + 1]?.[0] ?? text.length));
    });
    if (index < codeLines.length - 1) add('(unmapped)', '\n');
  });
  return pieces;
}

/**
 * Every byte of a chunk, attributed to its source module by the chunk's source map: a module's bytes are the
 * segments mapped to it; its gzip is its share of the chunk's real gzip (each module's text compressed on its own,
 * then scaled so the shares add up to the chunk) — a share, not a stand-alone size.
 */
function attribute(chunk: Rolldown.OutputChunk, dir: string, entry: string | undefined): Map<string, ModuleShare> {
  const texts = new Map<string, string[]>();
  // Line breaks are left out of the shares (they always were): only the marginal measure needs them, to rebuild the code.
  for (const [module, text] of segmentsOf(chunk, dir, entry)) if (text !== '\n') (texts.get(module) ?? texts.set(module, []).get(module)!).push(text);

  const raw = [...texts].map(([module, parts]) => {
    const text = parts.join('');
    return { module, min: Buffer.byteLength(text), gzip: gzipSync(text, { level: 9 }).length };
  });
  const scale = gzipSync(chunk.code, { level: 9 }).length / raw.reduce((sum, { gzip }) => sum + gzip, 0);
  return new Map(raw.map(({ module, min, gzip }) => [module, { min, gzip: gzip * scale }]));
}

/** An entry that keeps `names` from `specifier` alive. */
export function entryOf(specifier: string, names: readonly string[]): string {
  return `import { ${names.join(', ')} } from '${specifier}';\nglobalThis.__keep = { ${names.join(', ')} };\n`;
}

/** The client core as an adapter uses it at least: the navigator, the document, links, forms, routes, titles, messages. */
const CORE = [
  ...['DEFAULT_PAGE_CACHE_SIZE', 'isHistoryState', 'mergePage', 'Navigator', 'SCROLL_REGION_ATTRIBUTE', 'xsrfToken'],
  ...['hasServerMarkup', 'isDevelopment', 'readInitialPage', 'rootElement'],
  ...['isCurrentLink', 'matchesRouteName', 'visitUrlOf'],
  ...['defaultFormEntries', 'dirtyPaths', 'fieldPath', 'firstErrors', 'formEntries', 'formObject', 'isDirtyPath', 'restoreFormEntries', 'sameEntries'],
  ...['resolveRoute', 'defaultTitle', 'TitleRegistry', 'loadPageMessages', 'pageLocale'],
];
/** An entry with the client core and `names` from it. */
export const coreEntry = (...names: string[]) => entryOf('@bespokecore/http/client', [...CORE, ...names]);
/** An entry with `createBespokeApp` and `names` from `@bespokecore/react`. */
export const appEntry = (...names: string[]) => entryOf('@bespokecore/react', ['createBespokeApp', ...names]);

/** The measured scenarios; `size-budget.json` holds a limit for each. */
export const SCENARIOS = {
  /** The client core alone. */
  core: coreEntry(),
  /** An app without a single page (`createBespokeApp`). */
  emptyApp: appEntry(),
  /** Pages with links and forms. */
  minimalApp: appEntry('Link', 'useForm', 'usePage', 'Head'),
  /** All of `@bespokecore/react`. */
  everything: `import * as all from '@bespokecore/react';\nglobalThis.__keep = all;\n`,
} as const;
export type Scenario = keyof typeof SCENARIOS;

/** A scenario's line in `size-budget.json`, in KB gzip. */
export interface BudgetLine {
  /** The ratchet: the size may not grow over it, and it only ever goes down. */
  readonly limit: number;
  /** Where Wave 5c takes it (informational). */
  readonly target?: number;
  /** A ceiling, not a ratchet: no request to lower it when the size shrinks (totals that may shift between chunks). */
  readonly ceiling?: boolean;
}

export interface Budget {
  readonly gzipKB: Readonly<Record<Scenario, BudgetLine>>;
  /** The client core and the React adapter in an app's initial chunks (`pnpm size`; their attributed share). */
  readonly appsGzipKB: Readonly<Record<string, BudgetLine>>;
  readonly stillLeaking: Readonly<Record<Exclude<Scenario, 'everything'>, readonly string[]>>;
}

export const BUDGET_FILE = fileURLToPath(new URL('../../size-budget.json', import.meta.url));
export const BUDGET_WHERE = 'packages/react/size-budget.json';
export const readBudget = (): Budget => JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget;

/** Lowers limits in place, so the file keeps its layout: `"emptyApp": { "limit": 23.0` → `"emptyApp": { "limit": 22.4`. */
export function lowerLimits(limits: Readonly<Record<string, number>>): void {
  let text = readFileSync(BUDGET_FILE, 'utf8');
  for (const [name, limit] of Object.entries(limits)) {
    text = text.replace(new RegExp(`("${name}":\\s*\\{\\s*"limit":\\s*)[\\d.]+`), `$1${limit.toFixed(1)}`);
  }
  writeFileSync(BUDGET_FILE, text);
}

/** Room above today's size, so a limit is not broken by every byte. */
export const TOLERANCE_KB = 0.1;
/** A size this far under its limit asks for a lower limit — a ratchet only holds if it follows every gain. */
export const SHRINK_KB = 0.3;

export const kb = (bytes: number): number => Math.round((bytes / 1024) * 100) / 100;

/** The limit for a size of `size` KB: `size` plus the tolerance, rounded up to 0.1 KB. */
export function limitFor(size: number): number {
  return Math.ceil(Math.round((size + TOLERANCE_KB) * 1000) / 100) / 10;
}

/** Why `size` (KB gzip) breaks its budget line — or `undefined` when it holds. */
export function budgetProblem(name: string, size: number, line: BudgetLine): string | undefined {
  if (size > line.limit) {
    return (
      `${name} grew to ${size} KB gzip, over its limit of ${line.limit.toFixed(1)} KB (${BUDGET_WHERE}). Limits only go down: ` +
      'find what grew (`pnpm size` attributes every byte to its module) instead of raising the limit.'
    );
  }
  if (!line.ceiling && size < line.limit - SHRINK_KB) {
    return (
      `${name} shrank to ${size} KB gzip — lower its limit in ${BUDGET_WHERE} from ${line.limit.toFixed(1)} to ` +
      `${limitFor(size).toFixed(1)} so the gain is kept (or run with BESPOKE_SIZE_BUDGET=update).`
    );
  }
  return undefined;
}
