/**
 * `marmeon discover`: reads the `.d.ts` files of installed packages with a `"marmeon"` field and writes `.marmeon/manifest*.json`
 * — the injection lists of their classes and their providers, dependencies first (docs/modules.md#discovery). One file per set
 * of resolution conditions; module paths are relative to the app, so transitive dependencies resolve. The manifest is read, not
 * imported: `node --watch` never sees it, so regenerating it never restarts a dev server.
 */
import { withCode, withoutCode } from '../error-codes.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DeclarationReader, type Location } from './declarations.ts';
import {
  exportedSubpaths,
  findPackage,
  resolveExports,
  resolveTypes,
  runtimeConditions,
  splitSpecifier,
  type PackageInfo,
} from './resolve.ts';

/** Bump when the manifest format changes, so old manifests are regenerated. */
const MANIFEST_VERSION = '3';
const UNRESOLVABLE = Symbol.for('marmeon.injection.unresolvable');
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];

export class DiscoveryError extends Error {
  override name = 'DiscoveryError';

  constructor(message: string) {
    super(withCode('K7', message));
  }
}

export interface DiscoverOptions {
  /** App root: where package.json and `.marmeon/` live. */
  root: string;
  /** Resolution conditions — must match the runtime. Defaults to this process's conditions. */
  conditions?: readonly string[];
}

export interface DiscoverySummary {
  readonly packages: readonly string[];
  readonly injectable: number;
  readonly unresolvable: number;
  readonly providers: number;
}

interface PublicRef {
  readonly url: string;
  readonly exportName: string;
}

/** `[module index, export name]` */
type ExportRef = readonly [number, string];

export interface Manifest {
  readonly version: string;
  readonly hash: string;
  readonly packages: readonly string[];
  /** Module files relative to the app root (`node_modules/.pnpm/…/dist/index.js`); everything else refers to them by index. */
  readonly modules: readonly string[];
  readonly injections: readonly (
    | { readonly class: ExportRef; readonly inject: readonly ExportRef[]; readonly package: string }
    | { readonly class: ExportRef; readonly unresolvable: string; readonly package: string }
  )[];
  readonly providers: readonly ExportRef[];
}

/** Builds the manifest data (without writing it). */
export function generateManifest({ root, conditions = runtimeConditions() }: DiscoverOptions): {
  manifest: Manifest;
  summary: DiscoverySummary;
} {
  const reader = new DeclarationReader();
  const modules: string[] = [];
  const moduleIndex = (url: string) => {
    // Kept relative to the app: the same manifest serves the app wherever it is copied to.
    const path = relative(root, fileURLToPath(url)).split(sep).join('/');
    const index = modules.indexOf(path);
    return index === -1 ? modules.push(path) - 1 : index;
  };
  const injections: Manifest['injections'][number][] = [];
  const providers: ExportRef[] = [];
  const names: string[] = [];

  for (const pkg of walkDependencies(root)) {
    const rootEntry = resolveExports(pkg, '.', conditions);
    names.push(pkg.name);

    // Resolved to TypeScript sources (a workspace package in development): the load
    // hook derives the injection lists there, so only the providers are recorded. The
    // module URL is the one the runtime resolves too, so nothing is loaded twice.
    if (rootEntry && /\.[cm]?tsx?$/.test(rootEntry)) {
      for (const provider of pkg.json.marmeon?.providers ?? []) {
        providers.push([moduleIndex(pathToFileURL(rootEntry).href), provider]);
      }
      continue;
    }

    const seen = new Set<string>();
    for (const subpath of exportedSubpaths(pkg)) {
      const jsEntry = resolveExports(pkg, subpath, conditions);
      const typesEntry = jsEntry && resolveTypes(pkg, subpath, jsEntry);
      if (!jsEntry || !typesEntry) continue;
      // Listed (and imported at boot) only when one of its classes is injected: a subpath without any — the React adapter's
      // `./table`, whose optional peer an app without tables does not install — is never loaded on the server.
      const module = () => moduleIndex(pathToFileURL(jsEntry).href);

      for (const [publicName, location] of reader.read(typesEntry).exports) {
        const params = reader.read(location.file).classes.get(location.name);
        const key = `${location.file}#${location.name}`;
        if (!params || seen.has(key)) continue;
        seen.add(key);

        const required = params.slice(0, firstOptional(params));
        if (required.length === 0) continue;

        const target: ExportRef = [module(), publicName];
        try {
          const inject = required.map((param): ExportRef => {
            const where = `${pkg.name}/${relative(pkg.dir, location.file)}:${param.line} — ${location.name}, parameter "${param.text}"`;
            if (!param.type) {
              throw new DiscoveryError(`Cannot inject ${where}: only classes and tokens can be injected.`);
            }
            const ref = resolveDependency(param.type, location, pkg, { reader, conditions, where });
            return [moduleIndex(ref.url), ref.exportName];
          });
          injections.push({ class: target, inject, package: pkg.name });
        } catch (error) {
          if (!(error instanceof DiscoveryError)) throw error;
          injections.push({ class: target, unresolvable: withoutCode(error.message), package: pkg.name });
        }
      }
    }

    for (const provider of pkg.json.marmeon?.providers ?? []) {
      const typesEntry = rootEntry && resolveTypes(pkg, '.', rootEntry);
      if (!rootEntry || !typesEntry || !reader.read(typesEntry).exports.has(provider)) {
        throw new DiscoveryError(`${pkg.name} lists provider "${provider}" in package.json, but its entry does not export it.`);
      }
      providers.push([moduleIndex(pathToFileURL(rootEntry).href), provider]);
    }
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    hash: manifestHash(root, conditions),
    packages: names,
    modules,
    injections,
    providers,
  };
  const unresolvable = injections.filter((entry) => 'unresolvable' in entry).length;
  return {
    manifest,
    summary: { packages: names, injectable: injections.length - unresolvable, unresolvable, providers: providers.length },
  };
}

/** Post-order walk over installed dependencies: a package's dependencies come before it. */
function walkDependencies(root: string): PackageInfo[] {
  const rootJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const seen = new Set<string>();
  const ordered: PackageInfo[] = [];

  // A package's peers are what the package depending on it provides (as a package manager resolves them) — looked up from
  // that dependent's directory, not the package's own: in a workspace a package's own node_modules also links its dev
  // dependencies, and an app with @marmeon/testing would otherwise discover every package testing is tested with.
  const visit = (pkg: PackageInfo, dependentDir: string) => {
    if (seen.has(pkg.dir)) return;
    seen.add(pkg.dir);
    for (const dep of [...Object.keys(pkg.json.dependencies ?? {}), ...Object.keys(pkg.json.optionalDependencies ?? {})]) {
      const found = findPackage(dep, pkg.dir);
      if (found) visit(found, pkg.dir);
    }
    for (const dep of Object.keys(pkg.json.peerDependencies ?? {})) {
      const found = findPackage(dep, dependentDir);
      if (found) visit(found, dependentDir);
    }
    if (pkg.json.marmeon) ordered.push(pkg);
  };

  // The app's dev dependencies count too — they are simply absent in production installs.
  for (const dep of [...dependencyNames(rootJson), ...Object.keys(rootJson.devDependencies ?? {})]) {
    const found = findPackage(dep, root);
    if (found) visit(found, root);
  }
  return ordered;
}

function dependencyNames(json: PackageInfo['json']): string[] {
  return [
    ...Object.keys(json.dependencies ?? {}),
    ...Object.keys(json.optionalDependencies ?? {}),
    ...Object.keys(json.peerDependencies ?? {}),
  ];
}

function firstOptional(params: readonly { optional: boolean }[]): number {
  const index = params.findIndex((param) => param.optional);
  return index === -1 ? params.length : index;
}

interface ResolveContext {
  readonly reader: DeclarationReader;
  readonly conditions: readonly string[];
  readonly where: string;
}

/** Resolves a constructor parameter type, as written in `location.file`, to a public runtime export. */
function resolveDependency(type: string, location: Location, pkg: PackageInfo, context: ResolveContext): PublicRef {
  const { reader, conditions, where } = context;
  const [root, member] = type.split('.');
  const file = reader.read(location.file);

  let declared: Location | undefined;
  let home = pkg;

  if (file.values.has(root!) && !member) {
    declared = { file: location.file, name: root! };
  } else {
    const imported = file.imports.get(root!);
    if (!imported) throw new DiscoveryError(`Cannot inject ${where}: "${root}" is not imported or declared.`);
    if (imported.typeOnly) {
      throw new DiscoveryError(`Cannot inject ${where}: "${root}" is imported with "import type" — it has no runtime value.`);
    }
    const name = imported.imported === '*' ? member : imported.imported;
    if (!name) throw new DiscoveryError(`Cannot inject ${where}: a namespace itself cannot be injected.`);

    if (imported.from.startsWith('.')) {
      const target = reader.relativeTarget(location.file, imported.from);
      declared = target ? reader.read(target).exports.get(name) : undefined;
    } else {
      const { name: packageName, subpath } = splitSpecifier(imported.from);
      const found = findPackage(packageName, pkg.dir); // from the OWNER's directory
      if (!found) throw new DiscoveryError(`Cannot inject ${where}: package "${packageName}" is not installed.`);
      home = found;
      const js = resolveExports(home, subpath, conditions);
      const types = js && resolveTypes(home, subpath, js);
      declared = types ? reader.read(types).exports.get(name) : undefined;
    }
  }

  if (!declared || !reader.read(declared.file).values.has(declared.name)) {
    throw new DiscoveryError(`Cannot inject ${where}: "${type}" is only a type — the package needs to export a token for it.`);
  }

  const ref = publicRef(home, declared, reader, conditions);
  if (!ref) {
    throw new DiscoveryError(`Cannot inject ${where}: "${type}" is not exported by ${home.name}, so it cannot be imported from outside.`);
  }
  return ref;
}

/** Finds the public subpath + export name under which a declaration is importable. */
function publicRef(pkg: PackageInfo, declared: Location, reader: DeclarationReader, conditions: readonly string[]): PublicRef | undefined {
  for (const subpath of exportedSubpaths(pkg)) {
    const js = resolveExports(pkg, subpath, conditions);
    const types = js && resolveTypes(pkg, subpath, js);
    if (!js || !types) continue;
    for (const [exportName, location] of reader.read(types).exports) {
      if (location.file === declared.file && location.name === declared.name) {
        return { url: pathToFileURL(js).href, exportName };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Freshness & loading
// ---------------------------------------------------------------------------

/** Node's own conditions — present in every process; the others are the ones a manifest file is named after. */
const NODE_CONDITIONS = new Set(['node', 'import', 'module-sync', 'node-addons', 'default', 'require']);
/** What happens when `.marmeon/` cannot be written: a read-only image, a locked-down directory. */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Changes whenever installed dependencies or resolution conditions change. */
export function manifestHash(root: string, conditions: readonly string[]): string {
  // Resolution depends on the *set* of conditions, not their order or repetition.
  const hash = createHash('sha256').update(MANIFEST_VERSION).update([...new Set(conditions)].sort().join('\0'));
  hash.update(readFileSync(join(root, 'package.json')));
  const lockfile = findLockfile(root);
  if (lockfile) hash.update(readFileSync(lockfile));
  return hash.digest('hex').slice(0, 16);
}

function findLockfile(root: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of LOCKFILES) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The manifest of one set of conditions: `.marmeon/manifest.json` with Node's own (published packages, production),
 * `.marmeon/manifest.source.json` with `@marmeon/source` (the monorepo), `manifest.<conditions>.json` for any other set.
 */
export function manifestPath(root: string, conditions: readonly string[] = runtimeConditions()): string {
  // `@marmeon/source` reads as `source`; Vitest adds `development`: `manifest.development+source.json`.
  const own = [...new Set(conditions.filter((condition) => !NODE_CONDITIONS.has(condition)))].map((condition) =>
    condition === '@marmeon/source' ? 'source' : condition.replace(/[^\w.-]+/g, '_'),
  );
  return join(root, '.marmeon', own.length === 0 ? 'manifest.json' : `manifest.${own.sort().join('+')}.json`);
}

/** Writes the manifest of the given (or this process's) conditions — what `marmeon discover` and `marmeon build` run. */
export function writeManifest(options: DiscoverOptions): DiscoverySummary & { readonly path: string } {
  const conditions = options.conditions ?? runtimeConditions();
  const result = regenerate({ ...options, conditions });
  if (result.unwritable) throw result.unwritable;
  return { ...result.summary, path: manifestPath(options.root, conditions) };
}

/**
 * Generates and writes the manifest atomically: a temporary file renamed into place.
 * Several processes may regenerate at once (the dev server, `marmeon` commands, test
 * workers) — a reader must never see a half-written file. A directory that cannot be
 * written is no failure here: the manifest is returned with the error.
 */
function regenerate(options: DiscoverOptions): { manifest: Manifest; summary: DiscoverySummary; unwritable?: NodeJS.ErrnoException } {
  const conditions = options.conditions ?? runtimeConditions();
  const result = generateManifest({ ...options, conditions });
  const path = manifestPath(options.root, conditions);
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(result.manifest, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    if (!UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    rmSync(temporary, { force: true });
    return { ...result, unwritable: error as NodeJS.ErrnoException };
  }
  return result;
}

export interface DiscoveredPackages {
  /** Service provider classes of discovered packages, dependencies first. */
  readonly providers: readonly (new (...args: any[]) => unknown)[];
  readonly packages: readonly string[];
  /** Whether the manifest was (re)generated during this call. */
  readonly regenerated: boolean;
  /**
   * Set when the manifest was out of date and `.marmeon/` could not be written: the packages were discovered in memory —
   * once per process, the app logs it (run `marmeon build` or `marmeon discover` where it can write, e.g. in the image's build stage).
   */
  readonly warning?: string;
}

/**
 * The discovered packages' modules, by URL, once per process. Node keeps a module by its URL anyway; under a module runner (Vitest)
 * every `import()` of a module it already ran is still a round trip to its server — and tests boot an app per test (under
 * load that made `createTestApp` take seconds). A failed import is not kept (a pruned install is discovered again, below).
 */
const packageModules = new Map<string, Promise<Record<string, any>>>();
function importPackage(url: string): Promise<Record<string, any>> {
  let module = packageModules.get(url);
  if (!module) {
    module = import(url) as Promise<Record<string, any>>;
    packageModules.set(url, module);
    module.catch(() => packageModules.delete(url));
  }
  return module;
}

/** Manifest files a warning was given for — once per process, not once per app (tests boot many). */
const warned = new Set<string>();

/**
 * Loads the manifest — regenerating it first if dependencies or conditions changed,
 * so `pnpm add some-package` needs no extra step — and applies it: injection lists
 * are attached to package classes, provider classes are returned.
 */
export async function loadDiscoveredPackages(options: DiscoverOptions & { force?: boolean }): Promise<DiscoveredPackages> {
  const conditions = options.conditions ?? runtimeConditions();
  const path = manifestPath(options.root, conditions);
  const expected = manifestHash(options.root, conditions);
  let unwritable: NodeJS.ErrnoException | undefined;
  const discover = () => {
    const result = regenerate({ root: options.root, conditions });
    unwritable ??= result.unwritable;
    return result.manifest;
  };

  let manifest = readManifest(path);
  let regenerated = options.force === true || manifest?.hash !== expected || manifest.version !== MANIFEST_VERSION;
  // Use what was just generated — re-reading the file could see another process's write.
  if (regenerated) manifest = discover();

  const load = (current: Manifest) =>
    Promise.all(current.modules.map((file) => importPackage(pathToFileURL(resolvePath(options.root, file)).href)));
  let modules: Record<string, any>[];
  try {
    modules = await load(manifest!);
  } catch (error) {
    // A package the manifest lists is gone while package.json and the lockfile stayed — a production install without the dev
    // dependencies (`pnpm install --prod`, a pruned image) next to a manifest written with them (@marmeon/devtools).
    // Discover again from what is installed, once.
    if (regenerated || (error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    manifest = discover();
    regenerated = true;
    modules = await load(manifest);
  }
  const resolve = ([module, name]: ExportRef) => modules[module]![name];

  for (const entry of manifest!.injections) {
    const target = resolve(entry.class);
    // Own lists win: an explicit `static inject` or one embedded by `marmeon package:build`.
    if (Object.hasOwn(target, 'inject')) continue;
    if ('inject' in entry) target.inject = entry.inject.map(resolve);
    else target[UNRESOLVABLE] ??= entry.unresolvable;
  }

  let warning: string | undefined;
  if (unwritable && !warned.has(path)) {
    warned.add(path);
    warning =
      `${relative(options.root, path)} is out of date and .marmeon/ cannot be written (${unwritable.code}): the packages were discovered in memory, ` +
      'on every start. Run `marmeon build` (or `marmeon discover`) where the app can write — in a Docker image, in its build stage.';
  }
  return { providers: manifest!.providers.map(resolve), packages: manifest!.packages, regenerated, ...(warning ? { warning } : {}) };
}

function readManifest(path: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}
