/**
 * `bespoke discover` — Composer's dump-autoload plus Laravel's package:discover.
 *
 * Walks the installed packages that opt in with a `"bespoke"` field in their
 * package.json, reads the `.d.ts` files they ship, and writes `.bespoke/manifest.json`:
 * - injection lists for their exported classes (from the constructor signatures),
 * - their service providers, in dependency order.
 *
 * Module references in the manifest are absolute (like Composer's classmap), so
 * dependencies the app cannot import itself — transitive ones under pnpm — resolve.
 *
 * The manifest is data (JSON), applied by {@link loadDiscoveredPackages}. Being read
 * rather than imported, it is never watched by `node --watch`, so regenerating it can
 * never restart a dev server.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const MANIFEST_VERSION = '2';
const UNRESOLVABLE = Symbol.for('bespokecore.injection.unresolvable');
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];

export class DiscoveryError extends Error {
  override name = 'DiscoveryError';
}

export interface DiscoverOptions {
  /** App root: where package.json and `.bespoke/` live. */
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
  /** Absolute module URLs; everything else refers to them by index. */
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
    const index = modules.indexOf(url);
    return index === -1 ? modules.push(url) - 1 : index;
  };
  const injections: Manifest['injections'][number][] = [];
  const providers: ExportRef[] = [];
  const names: string[] = [];

  for (const pkg of walkDependencies(root)) {
    const rootEntry = resolveExports(pkg, '.', conditions);
    // Resolved to TypeScript sources (a workspace package in development):
    // the load hook injects those, and importing them here would be a second copy.
    if (rootEntry && /\.[cm]?tsx?$/.test(rootEntry)) continue;
    names.push(pkg.name);

    const seen = new Set<string>();
    for (const subpath of exportedSubpaths(pkg)) {
      const jsEntry = resolveExports(pkg, subpath, conditions);
      const typesEntry = jsEntry && resolveTypes(pkg, subpath, jsEntry);
      if (!jsEntry || !typesEntry) continue;
      const module = moduleIndex(pathToFileURL(jsEntry).href);

      for (const [publicName, location] of reader.read(typesEntry).exports) {
        const params = reader.read(location.file).classes.get(location.name);
        const key = `${location.file}#${location.name}`;
        if (!params || seen.has(key)) continue;
        seen.add(key);

        const required = params.slice(0, firstOptional(params));
        if (required.length === 0) continue;

        const target: ExportRef = [module, publicName];
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
          injections.push({ class: target, unresolvable: error.message, package: pkg.name });
        }
      }
    }

    for (const provider of pkg.json.bespoke?.providers ?? []) {
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

  const visit = (pkg: PackageInfo) => {
    if (seen.has(pkg.dir)) return;
    seen.add(pkg.dir);
    for (const dep of dependencyNames(pkg.json)) {
      const found = findPackage(dep, pkg.dir);
      if (found) visit(found);
    }
    if (pkg.json.bespoke) ordered.push(pkg);
  };

  // Like Composer, the app's dev dependencies count too — they are simply absent in production installs.
  for (const dep of [...dependencyNames(rootJson), ...Object.keys(rootJson.devDependencies ?? {})]) {
    const found = findPackage(dep, root);
    if (found) visit(found);
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

export function manifestPath(root: string): string {
  return join(root, '.bespoke', 'manifest.json');
}

/** Writes `.bespoke/manifest.json` (what `bespoke discover` runs). */
export function writeManifest(options: DiscoverOptions): DiscoverySummary {
  const conditions = options.conditions ?? runtimeConditions();
  const { manifest, summary } = generateManifest({ ...options, conditions });
  const path = manifestPath(options.root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return summary;
}

export interface DiscoveredPackages {
  /** Service provider classes of discovered packages, dependencies first. */
  readonly providers: readonly (new (...args: any[]) => unknown)[];
  readonly packages: readonly string[];
  /** Whether the manifest was (re)generated during this call. */
  readonly regenerated: boolean;
}

/**
 * Loads the manifest — regenerating it first if dependencies or conditions changed,
 * so `pnpm add some-package` needs no extra step — and applies it: injection lists
 * are attached to package classes, provider classes are returned.
 */
export async function loadDiscoveredPackages(options: DiscoverOptions & { force?: boolean }): Promise<DiscoveredPackages> {
  const conditions = options.conditions ?? runtimeConditions();
  const path = manifestPath(options.root);
  const expected = manifestHash(options.root, conditions);

  let manifest = readManifest(path);
  const regenerated = options.force === true || manifest?.hash !== expected || manifest.version !== MANIFEST_VERSION;
  if (regenerated) {
    writeManifest({ root: options.root, conditions });
    manifest = readManifest(path)!;
  }

  const modules = await Promise.all(manifest!.modules.map((url) => import(url) as Promise<Record<string, any>>));
  const resolve = ([module, name]: ExportRef) => modules[module]![name];

  for (const entry of manifest!.injections) {
    const target = resolve(entry.class);
    // Own lists win: an explicit `static inject` or one embedded by `bespoke package:build`.
    if (Object.hasOwn(target, 'inject')) continue;
    if ('inject' in entry) target.inject = entry.inject.map(resolve);
    else target[UNRESOLVABLE] ??= entry.unresolvable;
  }

  return { providers: manifest!.providers.map(resolve), packages: manifest!.packages, regenerated };
}

function readManifest(path: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}
