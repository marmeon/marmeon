/**
 * The framework's packages and their tarballs — shared by `pack:check`, `pack:smoke` and `license:sync`.
 *
 * Tarballs are always made with **pnpm** (`pnpm pack`): only pnpm applies `publishConfig.exports` (the exports without the
 * `@bespokecore/source` condition) and turns `workspace:*` into the exact version; `npm pack` would ship the source condition.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly [field: string]: unknown;
}

export interface FrameworkPackage {
  /** `@bespokecore/<short>` */
  readonly name: string;
  /** The directory name under `packages/`. */
  readonly short: string;
  readonly dir: string;
  readonly manifest: PackageManifest;
}

/** Every published package of the repository: `packages/*` with a `package.json` that is not private. */
export function frameworkPackages(root: string): FrameworkPackage[] {
  const packages = join(root, 'packages');
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packages, entry.name, 'package.json')))
    .map((entry) => {
      const dir = join(packages, entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest;
      return { name: manifest.name, short: entry.name, dir, manifest };
    })
    .filter((pkg) => pkg.manifest.private !== true)
    .sort((a, b) => a.short.localeCompare(b.short));
}

export interface PackedPackage {
  readonly name: string;
  readonly version: string;
  /** Absolute path of the `.tgz`. */
  readonly tarball: string;
  /** Paths inside the tarball, relative to its `package/` directory. */
  readonly files: readonly string[];
}

/** `pnpm pack` of every framework package into `destination` (one pnpm process); throws with pnpm's output on failure. */
export function packAll(root: string, destination: string): PackedPackage[] {
  const result = spawnSync('pnpm', ['--recursive', '--filter', './packages/*', 'pack', '--pack-destination', destination, '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`pnpm pack failed (exit ${result.status ?? result.signal}):\n${result.stderr}${result.stdout}`);
  type Packed = { name: string; version: string; filename: string; files: { path: string }[] };
  const output = JSON.parse(result.stdout) as Packed | Packed[];
  return (Array.isArray(output) ? output : [output])
    .map((pkg) => ({ name: pkg.name, version: pkg.version, tarball: pkg.filename, files: pkg.files.map((file) => file.path).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
