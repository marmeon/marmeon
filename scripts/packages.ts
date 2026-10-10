/**
 * The framework's packages and their tarballs — shared by `pack:check`, `pack:smoke` and `license:sync`.
 *
 * Tarballs are always made with **pnpm** (`pnpm pack`): only pnpm applies `publishConfig.exports` (the exports without the
 * `@marmeon/source` condition) and turns `workspace:*` into the exact version; `npm pack` would ship the source condition.
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
  /** `@marmeon/<short>` — or one of the two unscoped ones: the CLI `marmeon` (`packages/cli`) and `create-marmeon`. */
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

/** How a package lists a third-party library under the driver rule. */
export type DriverKind = 'dependency' | 'optional peer' | 'peer';

/**
 * The driver rule, per package — `pack:check` holds the packed manifests to it, a test in `scripts/ci.test.ts` the sources:
 *   1. a package that wraps exactly one third-party driver and is useless without it lists it in `dependencies`, at a caret range
 *      of the tested major (`@marmeon/redis` → `redis`); decided exception: `nodemailer` in `@marmeon/mail`;
 *   2. a package with several drivers (usually with a built-in one) keeps the third-party ones as optional peers — its error names the
 *      exact install command with the major (`pnpm add pg@^8`);
 *   3. a library whose instance or types the app must share (the OpenTelemetry API, React, Vite) is a peer — and no framework package
 *      lists it as a dependency: a second copy would be a second instance.
 */
export const DRIVER_RULE: Readonly<Record<string, Readonly<Record<string, DriverKind>>>> = {
  redis: { redis: 'dependency' },
  // The engine under `rules`: internal, never re-exported — the app installs nothing for its validation.
  validation: { valibot: 'dependency' },
  mail: { nodemailer: 'dependency', mjml: 'optional peer' },
  storage: { '@aws-sdk/client-s3': 'optional peer', '@aws-sdk/s3-request-presigner': 'optional peer', '@aws-sdk/s3-presigned-post': 'optional peer' },
  database: { pg: 'optional peer' },
  otel: { '@opentelemetry/api': 'peer' },
  server: { vite: 'peer' },
  vite: { vite: 'peer' },
  react: { react: 'peer', 'react-dom': 'peer', '@tanstack/react-table': 'optional peer' },
};

/** Libraries the app and the framework must share one instance of (rule 3): a dependency of no framework package. */
export const SHARED_LIBRARIES: readonly string[] = ['@opentelemetry/api', 'react', 'react-dom', 'vite'];

/** What breaks the driver rule in one package's manifest (`short` = its directory under `packages/`). */
export function checkDriverRule(short: string, manifest: Record<string, any>): string[] {
  const problems: string[] = [];
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  const peers = (manifest.peerDependencies ?? {}) as Record<string, string>;
  const optional = (name: string) => (manifest.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined)?.[name]?.optional === true;
  for (const [library, kind] of Object.entries(DRIVER_RULE[short] ?? {})) {
    if (kind === 'dependency') {
      if (!dependencies[library]) problems.push(`${library} must be a dependency (the one driver this package wraps — the app installs nothing else)`);
      else if (!/^\^\d+\.\d+\.\d+$/.test(dependencies[library])) problems.push(`dependencies.${library} is "${dependencies[library]}" — a caret range of the tested major (^6.2.1)`);
      if (dependencies[library] && peers[library]) problems.push(`${library} is a dependency and a peer — one or the other`);
      continue;
    }
    if (dependencies[library]) {
      problems.push(
        kind === 'peer'
          ? `${library} must stay a peer, not a dependency — the app and the framework share one instance; a dependency installs a second copy`
          : `${library} must stay an optional peer, not a dependency — one of several drivers; every app would install it`,
      );
    }
    if (!peers[library]) problems.push(`${library} must be a${kind === 'optional peer' ? 'n optional' : ''} peer of this package`);
    else if (kind === 'optional peer' && !optional(library)) problems.push(`${library} must be an optional peer (peerDependenciesMeta) — the app installs it only for that driver`);
  }
  for (const library of SHARED_LIBRARIES) {
    if (dependencies[library]) problems.push(`${library} is a dependency — the app and the framework must share one instance of it: a peer`);
  }
  return problems;
}
