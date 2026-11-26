import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { withCode } from '../error-codes.ts';
import { isInside } from './contain.ts';

export interface PackageInfo {
  readonly name: string;
  /** Real path of the package directory (symlinks resolved, like Node does). */
  readonly dir: string;
  readonly json: PackageJson;
}

/** A package `findPackage` read: with the digest of the bytes of the `package.json` its `json` was parsed from. */
export type FoundPackage = PackageInfo & { readonly digest: string };

export interface PackageJson {
  name?: string;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  /** Foreign input: read it through `marmeonField()`. */
  marmeon?: unknown;
}

/**
 * The conditions Node applies to ESM imports in *this* process: its defaults plus
 * every `--conditions` / `-C` flag. Discovery must resolve exactly like the runtime,
 * otherwise a package loads twice and token identity breaks.
 */
export function runtimeConditions(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): string[] {
  const args = [...execArgv, ...nodeOptions.split(/\s+/).filter(Boolean)];
  const user: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const inline = /^(?:--conditions|-C)=(.+)$/.exec(arg);
    if (inline) user.push(inline[1]!);
    else if ((arg === '--conditions' || arg === '-C') && args[i + 1]) user.push(args[++i]!);
  }
  return [...user, 'node', 'import', 'module-sync', 'node-addons'];
}

/** Splits `@scope/name/sub/path` into the package name and the `./sub/path` subpath. */
export function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const length = specifier.startsWith('@') ? 2 : 1;
  const rest = parts.slice(length).join('/');
  return { name: parts.slice(0, length).join('/'), subpath: rest ? `./${rest}` : '.' };
}

/**
 * `text` with every control, format, line- and paragraph-separator character written as `\uXXXX`, so text from a file
 * of someone else cannot redraw a terminal, hide a link (OSC 8) or reorder what is shown (U+202E).
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    const code = char.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** A valid npm package name (older ones have capitals) — never a path, so a name from a manifest cannot walk out of `node_modules`. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** Finds a package the way Node does: `node_modules/<name>` in `fromDir` and every parent. */
export function findPackage(name: string, fromDir: string): PackageInfo | undefined {
  return findFoundPackage(name, fromDir);
}

/**
 * Whether `dir` may be a root above the app: not writable by everyone (so not `/tmp`, where anyone can plant a marker), and owned by the
 * user of the process, by root or by `owner` (the owner of the app: a deploy user owns the code, another user runs the service). The same
 * rule as `trusted` in `@marmeon/database`, plus `owner`. Windows has no `getuid`, and its `mode` says nothing about who may write, so
 * there the check passes.
 */
export function trusted(dir: string, owner?: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    const { mode, uid } = statSync(dir);
    if (mode & 0o002) return false;
    const me = process.getuid?.();
    return me === undefined || uid === me || uid === 0 || uid === owner;
  } catch {
    return false;
  }
}

function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** The folder that holds the outermost `node_modules` `dir` lies in; `dir` itself when it lies in none. */
function installRoot(dir: string): string {
  let top = dir;
  for (let at = dir; dirname(at) !== at; at = dirname(at)) if (basename(at) === 'node_modules') top = dirname(at);
  return top;
}

/** What {@link lookupPackage} found, or why it did not: the folder the way up stopped at, and whether the name is installed above the bound. */
export interface PackageLookup {
  readonly found?: FoundPackage;
  /** The way up ended at this folder, which everyone can write to or another user owns. */
  readonly stoppedAt?: string;
  /** Not found, but a package of that name lies in a `node_modules` beyond the bound. */
  readonly above?: boolean;
  /** The lookup started outside the limit: it looked only in the install tree of the start, up to `installedAt`. */
  readonly outside?: boolean;
  /** The last folder the lookup looked in; set only for a start outside the limit. */
  readonly installedAt?: string;
}

/** Whether a `node_modules/<name>` lies in `dir` or a parent of it: looked at, never read. */
function installedFrom(name: string, dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules', name, 'package.json'))) return true;
    if (dirname(at) === at) return false;
  }
}

function readPackage(name: string, candidate: string): FoundPackage {
  let found: string;
  let json: unknown;
  let bytes: Buffer;
  try {
    found = realpathSync.native(dirname(candidate));
    bytes = readFileSync(join(found, 'package.json'));
    json = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(withCode('K7', `The package.json of ${name} (${candidate}) cannot be read as JSON: ${printable(cause instanceof Error ? cause.message : String(cause))}`), { cause });
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(withCode('K7', `The package.json of ${name} (${candidate}) is not a JSON object.`));
  }
  return { name, dir: found, json: json as PackageInfo['json'], digest: createHash('sha256').update(bytes).digest('hex') };
}

/** Where discovery looks: the app, and the workspace root above it that no lookup passes. */
export interface LookupBound {
  /** Real path of the app folder. */
  readonly app: string;
  /** Real path of the workspace root: the app or a folder above it, vetted where it is computed. */
  readonly limit: string;
}

/**
 * {@link findFoundPackage} with the reason for a miss. With a `bound` the way up ends at its `limit` (compared by real path): a name that
 * is not installed nearer is not found above the app's workspace. The app, what lies in it and the folders from it up to the limit are
 * not checked on the way: the app's install tree is the app's, and the folders above it are vetted where the limit is computed. Any other
 * folder the way leads through (a package linked from elsewhere in the workspace) must pass `trusted`, with the owner of the app as an
 * owner too. A start outside the limit (a package of a store elsewhere, a linked one) looks only in its own install tree: up to the
 * folder of its outermost `node_modules`, or just its own `node_modules` when it lies in none.
 */
export function lookupPackage(name: string, fromDir: string, bound?: LookupBound): PackageLookup {
  if (!PACKAGE_NAME.test(name)) return {};
  if (bound === undefined) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return { found: readPackage(name, candidate) };
      if (dirname(dir) === dir) return {};
    }
  }
  const start = realDir(fromDir);
  const { app, limit } = bound;
  const inside = start === limit || isInside(limit, start);
  const last = inside ? limit : installRoot(start);
  let owner: number | undefined;
  try {
    owner = statSync(app).uid;
  } catch {}
  const vetted = (dir: string) =>
    dir === app ||
    isInside(app, dir) ||
    (isInside(dir, app) && (dir === limit || isInside(limit, dir))) ||
    // The install tree of the workspace is the workspace's own: the `.pnpm` store, the hoisted packages.
    (inside && (dir === join(limit, 'node_modules') || isInside(join(limit, 'node_modules'), dir)));
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir !== start && !vetted(dir) && !trusted(dir, owner)) return { stoppedAt: dir, above: installedFrom(name, dir), ...(inside ? {} : { outside: true, installedAt: last }) };
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return { found: readPackage(name, candidate) };
    if (dir === last || dirname(dir) === dir) return { above: installedFrom(name, dirname(dir)), ...(inside ? {} : { outside: true, installedAt: last }) };
  }
}

/** {@link findPackage} with the digest of the `package.json` it parsed: discovery hashes those bytes, not a second read. Takes the `bound` of {@link lookupPackage}. */
export function findFoundPackage(name: string, fromDir: string, bound?: LookupBound): FoundPackage | undefined {
  return lookupPackage(name, fromDir, bound).found;
}

/**
 * Resolves `subpath` through a package's `exports` field — first match in the
 * object's key order, like Node. Subpath patterns (`./*`) are not supported yet.
 */
export function resolveExports(pkg: PackageInfo, subpath: string, conditions: readonly string[]): string | undefined {
  const resolved = selectExportsTarget(pkg, subpath, conditions);
  // `resolve`, not `join`: an absolute target stays absolute, so the containment check sees it instead of reading it as relative.
  return resolved ? resolve(pkg.dir, resolved) : undefined;
}

/** The target `exports` selects for `subpath` under `conditions`, as written in the file: not resolved, not normalized. */
export function selectExportsTarget(pkg: PackageInfo, subpath: string, conditions: readonly string[]): string | undefined {
  const { exports } = pkg.json;
  if (exports === undefined) {
    return subpath === '.' && typeof pkg.json.main === 'string' && pkg.json.main ? pkg.json.main : undefined;
  }

  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  const target = isSubpathMap ? (exports as Record<string, unknown>)[subpath] : subpath === '.' ? exports : undefined;
  return pickTarget(target, conditions, pkg.name, 0);
}

/** All explicit subpaths a package exports (`.`, `./testing`, …). */
export function exportedSubpaths(pkg: PackageInfo): string[] {
  const { exports } = pkg.json;
  if (typeof exports === 'object' && exports !== null && !Array.isArray(exports)) {
    const keys = Object.keys(exports).filter((key) => key.startsWith('.') && !key.includes('*'));
    if (keys.length > 0) return keys;
  }
  return ['.'];
}

/** The declaration file for a subpath: the `types` condition, or the `.d.ts` next to the JS entry. */
export function resolveTypes(pkg: PackageInfo, subpath: string, jsEntry: string): string | undefined {
  const viaCondition = resolveExports(pkg, subpath, ['types']);
  if (viaCondition?.endsWith('.d.ts') || viaCondition?.endsWith('.d.mts')) return viaCondition;
  const declared = pkg.json.types ?? pkg.json.typings;
  if (subpath === '.' && typeof declared === 'string' && declared) return resolve(pkg.dir, declared);
  const sibling = jsEntry.replace(/\.m?js$/, (ext) => (ext === '.mjs' ? '.d.mts' : '.d.ts'));
  return existsSync(sibling) ? sibling : undefined;
}

/** How deep `exports` may nest conditions and fallback lists: real packages use a handful of levels, a hostile one would overflow the stack. */
const MAX_EXPORTS_DEPTH = 32;

function pickTarget(target: unknown, conditions: readonly string[], packageName: string, depth: number): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null) return undefined;
  if (depth >= MAX_EXPORTS_DEPTH) {
    throw new Error(withCode('K7', `The "exports" of ${packageName} nest deeper than ${MAX_EXPORTS_DEPTH} levels, so its entry cannot be resolved.`));
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickTarget(entry, conditions, packageName, depth + 1);
      if (picked) return picked;
    }
    return undefined;
  }
  for (const [condition, value] of Object.entries(target)) {
    if (condition === 'default' || conditions.includes(condition)) {
      const picked = pickTarget(value, conditions, packageName, depth + 1);
      if (picked) return picked;
    }
  }
  return undefined;
}
