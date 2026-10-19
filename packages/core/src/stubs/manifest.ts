import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok } from '../result.ts';
import type { Result } from '../result.ts';

/**
 * The file in an app's root that says where the copied template files came from: per set the package and its version, and per
 * file the template it was copied from and the hash of what was written. The framework owns it — do not edit it by hand. See
 * docs/starter-kit.md#what-the-auth-module-holds.
 */
export const STUB_MANIFEST = 'marmeon-stubs.json';

/** One copied file: the template's path inside the package, and `stubHash()` of the bytes written to the app. */
export interface StubFile {
  readonly stub: string;
  readonly sha256: string;
}

/** The files one package copied from one template directory, and the version of the package that copied them. */
export interface StubSet {
  readonly package: string;
  readonly version: string;
  readonly files: Readonly<Record<string, StubFile>>;
}

/** The content of `marmeon-stubs.json`: sets by key `<package>:<template directory>`. */
export interface StubManifest {
  readonly format: 1;
  readonly sets: Readonly<Record<string, StubSet>>;
}

/** Why the manifest could not be used: `newer` was written by a later Marmeon, `invalid` is no manifest this reader knows. */
export interface StubManifestProblem {
  readonly kind: 'newer' | 'invalid';
  readonly message: string;
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** `sha256:<hex>` of the contents with `\r\n` read as `\n`, so a checkout with converted line endings counts as unchanged. */
export function stubHash(contents: string | Uint8Array): string {
  // latin1 maps every byte to one character and back, so binary files pass through unchanged.
  const text = typeof contents === 'string' ? contents : Buffer.from(contents).toString('latin1');
  const bytes = Buffer.from(text.replaceAll('\r\n', '\n'), typeof contents === 'string' ? 'utf8' : 'latin1');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// Relative, POSIX, no `.` or `..`: a later `stubs:diff` writes to these paths, so a manifest must not be able to point outside the app.
function safePath(path: unknown): path is string {
  return typeof path === 'string' && path !== '' && !path.startsWith('/') && !/[\\\0]/.test(path) && !path.split('/').some((part) => part === '.' || part === '..' || part === '');
}

const problem = (kind: StubManifestProblem['kind'], message: string) => err<StubManifestProblem['kind'], StubManifestProblem>({ kind, message });
const invalid = (message: string) => problem('invalid', message);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A set is `<package>:<template directory>`; the directory is a path like the others.
function checkSet(key: string, name: unknown, version: unknown): string | undefined {
  if (typeof name !== 'string' || !PACKAGE.test(name)) return `the set "${key}" has no valid package name`;
  if (typeof version !== 'string' || !VERSION.test(version)) return `the set "${key}" has no valid version`;
  if (!key.startsWith(`${name}:`) || !safePath(key.slice(name.length + 1))) return `the set "${key}" is not keyed <package>:<template directory>`;
  return undefined;
}

// A key this reader does not know is a later format: adding one is a new format, and older readers refuse it.
const unknownKey = (value: Record<string, unknown>, known: readonly string[]) => Object.keys(value).find((key) => !known.includes(key));

function parseSet(key: string, value: unknown): StubSet | string {
  if (!isRecord(value) || !isRecord(value.files)) return `the set "${key}" needs package, version and files`;
  const problem = checkSet(key, value.package, value.version);
  if (problem) return problem;
  const extra = unknownKey(value, ['package', 'version', 'files']);
  if (extra) return `the set "${key}" has the unknown key "${extra}"`;
  const files: Record<string, StubFile> = {};
  for (const [path, entry] of Object.entries(value.files)) {
    if (!safePath(path)) return `the set "${key}" lists the path ${JSON.stringify(path)}, which is not a relative path inside the app`;
    if (!isRecord(entry) || !safePath(entry.stub)) return `${path} in "${key}" has no valid template path`;
    if (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) return `${path} in "${key}" has no valid sha256`;
    const unknown = unknownKey(entry, ['stub', 'sha256']);
    if (unknown) return `${path} in "${key}" has the unknown key "${unknown}"`;
    files[path] = { stub: entry.stub, sha256: entry.sha256 };
  }
  return { package: value.package as string, version: value.version as string, files };
}

/**
 * Reads `marmeon-stubs.json` of an app: `ok(undefined)` without the file. A manifest of a newer format, a missing format, broken JSON
 * and any path that leaves the app are errors; the file stays as it is.
 */
export function readStubManifest(root: string): Result<StubManifest | undefined, StubManifestProblem> {
  const file = join(root, STUB_MANIFEST);
  if (!existsSync(file)) return ok(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return invalid(`${STUB_MANIFEST} is not valid JSON.`);
  }
  if (!isRecord(parsed) || typeof parsed.format !== 'number') return invalid(`${STUB_MANIFEST} has no format.`);
  if (parsed.format > 1) return problem('newer', `${STUB_MANIFEST} was written by a newer Marmeon — update the packages.`);
  if (parsed.format !== 1) return invalid(`${STUB_MANIFEST} has format ${parsed.format}, which this Marmeon does not know.`);
  if (!isRecord(parsed.sets)) return invalid(`${STUB_MANIFEST} has no sets.`);
  const extra = unknownKey(parsed, ['format', 'sets']);
  if (extra) return invalid(`${STUB_MANIFEST} has the unknown key "${extra}".`);
  const sets: Record<string, StubSet> = {};
  for (const [key, value] of Object.entries(parsed.sets)) {
    const set = parseSet(key, value);
    if (typeof set === 'string') return invalid(`${STUB_MANIFEST}: ${set}.`);
    sets[key] = set;
  }
  return ok({ format: 1, sets });
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

/**
 * Records a set in `marmeon-stubs.json`: replaces the set under `key` entirely, keeps the others and hashes the files as they lie in
 * the app now. Nothing is written when the manifest cannot be read. The JSON is deterministic (keys sorted, two spaces, a final newline).
 */
export function recordStubSet(
  root: string,
  key: string,
  set: { readonly package: string; readonly version: string; readonly files: readonly { readonly path: string; readonly stub: string }[] },
): Result<void, StubManifestProblem> {
  const current = readStubManifest(root);
  if (!current.ok) return current;
  const keyProblem = checkSet(key, set.package, set.version);
  if (keyProblem) return invalid(`${keyProblem}.`);
  const files: Record<string, StubFile> = {};
  for (const { path, stub } of set.files) {
    if (!safePath(path) || !safePath(stub)) return invalid(`${JSON.stringify(path)} from ${JSON.stringify(stub)} is not a relative path.`);
    files[path] = { stub, sha256: stubHash(readFileSync(join(root, path))) };
  }
  const manifest: StubManifest = {
    format: 1,
    sets: { ...current.value?.sets, [key]: { package: set.package, version: set.version, files } },
  };
  writeFileSync(join(root, STUB_MANIFEST), `${JSON.stringify(sorted(manifest), null, 2)}\n`);
  return ok();
}
