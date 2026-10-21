import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withCode } from '../error-codes.ts';

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
  if (!PACKAGE_NAME.test(name)) return undefined;
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      let realDir: string;
      let json: unknown;
      try {
        realDir = realpathSync(dirname(candidate));
        json = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8'));
      } catch (cause) {
        throw new Error(withCode('K7', `The package.json of ${name} (${candidate}) cannot be read as JSON: ${printable(cause instanceof Error ? cause.message : String(cause))}`), { cause });
      }
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error(withCode('K7', `The package.json of ${name} (${candidate}) is not a JSON object.`));
      }
      return { name, dir: realDir, json: json as PackageInfo['json'] };
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
    return subpath === '.' && typeof pkg.json.main === 'string' && pkg.json.main ? resolve(pkg.dir, pkg.json.main) : undefined;
  }

  const isSubpathMap =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  const target = isSubpathMap ? (exports as Record<string, unknown>)[subpath] : subpath === '.' ? exports : undefined;
  const resolved = pickTarget(target, conditions, pkg.name, 0);
  // `resolve`, not `join`: an absolute target stays absolute, so the containment check sees it instead of reading it as relative.
  return resolved ? resolve(pkg.dir, resolved) : undefined;
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
