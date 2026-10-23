import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { build, type InlineConfig, type Rolldown } from 'vite';

/**
 * Bundle measurements for the leak test and `pnpm size`: Vite's **app** mode as `marmeon build` runs it
 * (not `lib` mode, which leaves ES libraries partly unminified), production defines, minified, gzip level 9 per chunk.
 */

/**
 * `packages/` — module ids are reported relative to it (`http/dist/client/navigation.js`). `MARMEON_MEASURE_PACKAGES` points it
 * at another checkout's `packages/`: how `pnpm size --base` measures the base commit with this checkout's script.
 */
export const PACKAGES = realpathSync(process.env.MARMEON_MEASURE_PACKAGES ?? fileURLToPath(new URL('../../../', import.meta.url)));

/** Not part of the measurement: React comes from the app, i18n only when the app translates (an optional peer). */
export const EXTERNAL = /^(react|react-dom|@marmeon\/i18n)(\/|$)/;

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
  /** The modules in those chunks (features loaded on first use). */
  readonly lazyModules: readonly string[];
  /** Those chunks' code, joined. */
  readonly lazyCode: string;
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

/** The measurement's app directory for the checkout whose `packages/` is `packages`. */
export const bundleDirectory = (packages: string): string =>
  join(realpathSync(tmpdir()), `marmeon-bundle-${createHash('sha256').update(packages).digest('hex').slice(0, 12)}`);

let workspace: string | undefined;

/**
 * An app directory that depends on the framework packages as an app's `node_modules` would (symlinks to the workspace
 * packages), so their `exports` resolve without the `@marmeon/source` condition: to `dist/`, what an app gets from
 * a published package. One per workspace checkout, reused (test workers end without an `exit` event to clean up after).
 */
function appDirectory(): string {
  if (workspace) return workspace;
  const dir = bundleDirectory(PACKAGES);
  mkdirSync(join(dir, 'node_modules', '@marmeon'), { recursive: true });
  const link = (target: string, path: string) => {
    try {
      symlinkSync(target, path, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; // made by an earlier (or a parallel) run
    }
  };
  for (const name of ['http', 'i18n', 'react', 'table']) link(join(PACKAGES, name), join(dir, 'node_modules', '@marmeon', name));
  // TanStack Table: an optional peer of the React adapter, for its bridge's scenario — where the adapter has it installed.
  mkdirSync(join(dir, 'node_modules', '@tanstack'), { recursive: true });
  link(realpathSync(join(PACKAGES, 'react/node_modules/@tanstack/react-table')), join(dir, 'node_modules', '@tanstack', 'react-table'));
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
 * measure reachable, e.g. `globalThis.__keep = { createMarmeonApp }`, or tree-shaking drops it.
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
          // The first page's code in one chunk, as `marmeon()` splits an app's client build (`CLIENT_CHUNKS` of @marmeon/vite —
          // its `vendor` group stays empty here, React being external): not a chunk for each module a lazy chunk shares with it.
          rolldownOptions: { input: { entry }, external: (id) => external.test(id), output: { codeSplitting: { groups: [{ name: 'index', tags: ['$initial'] }] } } },
        },
      },
      { sourcemap, entry },
    );
  } finally {
    rmSync(entry, { force: true });
  }
}

/**
 * The client build of a real app (its own `vite.config.ts`), measured the same way — of a copy ({@link appCopy}): nothing
 * is written into the app. In the monorepo the framework packages come from `dist/` too: a build never takes the
 * `@marmeon/source` condition.
 */
export async function appClientBuild(root: string, { sourcemap = false }: Pick<BundleOptions, 'sourcemap'> = {}): Promise<AppBundle> {
  const copy = appCopy(root);
  copies.set(copy, root);
  try {
    writeBrowserRoutes(copy);
    // Before Vite resolves the config: an unset NODE_ENV becomes "development", and React's development build with it.
    process.env.NODE_ENV = 'production';
    return await measure({ root: copy, logLevel: 'silent', build: {} }, { sourcemap });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/**
 * The app copies built, each with the app it copies — module ids are reported as the app's own. Kept after the copy is
 * gone: `attribution.marginalGzip` names modules when it is called.
 */
const copies = new Map<string, string>();

/**
 * A copy of the app, with the app's `node_modules` (a symlink) and without what the app generates: the build reads the
 * route manifest, and the app's own may be stale (`.marmeon/` survives a change of branch) or rewritten right now by a test
 * that boots the app — the copy gets its own, from the routes as they are.
 */
function appCopy(root: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `marmeon-app-${basename(root)}-`));
  try {
    cpSync(root, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(root.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    // The compiler options the transform reads: a relative `extends` (the monorepo's base config) still names the app's.
    const tsconfig = join(dir, 'tsconfig.json');
    try {
      writeFileSync(tsconfig, readFileSync(tsconfig, 'utf8').replace(/("extends":\s*")(\.[^"]*)"/, (_, key: string, path: string) => `${key}${resolve(root, path).replaceAll('\\', '/')}"`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The browser's route manifest (`.marmeon/routes.json`) the build reads — what `marmeon build` writes first: `marmeon
 * route:types`, in the app's committed test environment (no `.env` needed). It writes `bootstrap/routes.ts` too, in the copy.
 */
function writeBrowserRoutes(root: string): void {
  const { MARMEON_CHILD: _child, DB_DRIVER: _connection, DB_URL: _url, ...env } = process.env;
  const bin = join(PACKAGES, 'cli/bin/marmeon.js');
  const result = spawnSync(process.execPath, [bin, 'route:types'], { cwd: root, encoding: 'utf8', env: { ...env, NODE_ENV: 'test' } });
  if (result.status !== 0) throw new Error(`marmeon route:types failed in ${root}:\n${result.stdout}${result.stderr}`);
}

/** Vite's helper around every `import()` of a client build (it preloads a lazy chunk's dependencies). */
const PRELOAD_HELPER = '\0vite/preload-helper.js';

/**
 * Measured without Vite's preload helper (≈ 0.5 KB gzip): the first `import()`
 * of a build brings it — every app with lazy pages ships it whatever the framework does, so it is no framework code. A stub
 * takes its place in the measured builds only (it loads the chunk without preloading its dependencies); nothing ships it.
 */
const withoutPreloadHelper = {
  name: 'marmeon:measure-without-preload-helper',
  enforce: 'pre' as const,
  resolveId: (id: string) => (id === PRELOAD_HELPER ? id : undefined),
  load: (id: string) => (id === PRELOAD_HELPER ? 'export const __vitePreload = (load) => load();' : undefined),
};

async function measure(config: InlineConfig, { sourcemap, entry }: { sourcemap: boolean; entry?: string }): Promise<AppBundle> {
  let outDir = '';
  const result = (await build({
    ...config,
    mode: 'production',
    plugins: [...(config.plugins ?? []), withoutPreloadHelper, { name: 'marmeon:measure', configResolved: (resolved) => void (outDir = resolve(resolved.root, resolved.build.outDir)) }],
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
    lazyCode: lazy.map((chunk) => chunk.code).join('\n'),
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
  for (const [copy, app] of copies) if (real.startsWith(`${copy}/`)) real = join(app, real.slice(copy.length));
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
  // A chunk the bundler made of its own code (rolldown's runtime, when chunk groups split modules apart): no module of ours.
  if (!map) return [['(unmapped)', chunk.code]];
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
  // Line breaks are left out of the shares: only the marginal measure needs them, to rebuild the code.
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
  ...['isHistoryState', 'mergePage', 'Navigator'],
  ...['hasServerMarkup', 'readInitialPage', 'rootElement'],
  ...['isCurrentLink', 'visitUrlOf'],
  ...['defaultFormEntries', 'dirtyPaths', 'fieldPath', 'firstErrors', 'formEntries', 'formObject', 'isDirtyPath', 'restoreFormEntries', 'sameEntries'],
  ...['defaultTitle', 'TitleRegistry', 'loadPageMessages', 'pageLocale'],
];
/** An entry with the client core: what an app uses of `@marmeon/http/client`, and `CORE` and `names` from `@marmeon/http/client/adapter`. */
export const coreEntry = (...names: string[]) => {
  const adapter = [...CORE, ...names];
  return `import { isDevelopment, resolveRoute, xsrfToken } from '@marmeon/http/client';\nimport { ${adapter.join(', ')} } from '@marmeon/http/client/adapter';\nglobalThis.__keep = { isDevelopment, resolveRoute, xsrfToken, ${adapter.join(', ')} };\n`;
};
/** An entry with `createMarmeonApp` and `names` from `@marmeon/react`. */
export const appEntry = (...names: string[]) => entryOf('@marmeon/react', ['createMarmeonApp', ...names]);

/** An app without pages that renders a server-driven table (`useTable`) — on top of {@link appEntry}. */
export const tableEntry = (...extra: string[]) =>
  `${appEntry()}import { useTable } from '@marmeon/react/table';\n${extra.join('')}globalThis.__table = useTable;\n`;

/** The measured scenarios; `pnpm size` reports each. */
export const SCENARIOS = {
  /** The client core alone. */
  core: coreEntry(),
  /** An app without a single page (`createMarmeonApp`). */
  emptyApp: appEntry(),
  /** Pages with links and forms. */
  minimalApp: appEntry('Link', 'useForm', 'usePage', 'Head'),
  /** All of `@marmeon/react` — its main entry: subpaths with optional peers (`./table`, `./table-tanstack`) are not part of it. */
  everything: `import * as all from '@marmeon/react';\nglobalThis.__keep = all;\n`,
  /** An app without pages and the headless table (`@marmeon/react/table`: its own limit). */
  table: tableEntry(),
} as const;
export type Scenario = keyof typeof SCENARIOS;

/** Bytes as KB, to 0.01. */
export const kb =(bytes: number): number => Math.round((bytes / 1024) * 100) / 100;
