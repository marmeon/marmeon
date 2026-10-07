import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PackageInfo {
  readonly name: string;
  /** Real path of the package directory (symlinks resolved, like Node does). */
  readonly dir: string;
  readonly json: PackageJson;
}

export interface PackageJson {
  name?: string;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  marmeon?: { providers?: string[] };
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

/** Finds a package the way Node does: `node_modules/<name>` in `fromDir` and every parent. */
export function findPackage(name: string, fromDir: string): PackageInfo | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      const realDir = realpathSync(dirname(candidate));
      return { name, dir: realDir, json: JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8')) };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Resolves `subpath` through a package's `exports` field — first match in the
 * object's key order, like Node. Subpath patterns (`./*`) are not supported yet.
 */
export function resolveExports(pkg: PackageInfo, subpath: string, conditions: readonly string[]): string | undefined {
  const { exports } = pkg.json;
  if (exports === undefined) {
    return subpath === '.' && pkg.json.main ? join(pkg.dir, pkg.json.main) : undefined;
  }

  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  const target = isSubpathMap ? (exports as Record<string, unknown>)[subpath] : subpath === '.' ? exports : undefined;
  const resolved = pickTarget(target, conditions);
  return resolved ? join(pkg.dir, resolved) : undefined;
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
  if (subpath === '.' && (pkg.json.types ?? pkg.json.typings)) return join(pkg.dir, (pkg.json.types ?? pkg.json.typings)!);
  const sibling = jsEntry.replace(/\.m?js$/, (ext) => (ext === '.mjs' ? '.d.mts' : '.d.ts'));
  return existsSync(sibling) ? sibling : undefined;
}

function pickTarget(target: unknown, conditions: readonly string[]): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickTarget(entry, conditions);
      if (picked) return picked;
    }
    return undefined;
  }
  if (typeof target === 'object' && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (condition === 'default' || conditions.includes(condition)) {
        const picked = pickTarget(value, conditions);
        if (picked) return picked;
      }
    }
  }
  return undefined;
}
