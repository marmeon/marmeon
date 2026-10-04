/**
 * `pnpm pack:check` — are the tarballs fit to publish (E156, E157, E158)? A part of `pnpm run ci`.
 *
 *   pnpm pack:check                          # clean build → pnpm pack of every package → the rules below → publint → attw
 *   node scripts/pack-check.ts --no-build    # the tarballs of the current dist/ (quicker; CI always builds clean)
 *   node scripts/pack-check.ts --keep        # leave the tarballs and their unpacked contents in $TMPDIR (the path is printed)
 *
 * The rules, per tarball (made with `pnpm pack` — only pnpm applies `publishConfig.exports`):
 *   - no tests, type tests, `__fixtures__`, `test-helpers` or build info — except in `stubs/`, which ships whole (the
 *     generators copy it into apps, tests included);
 *   - nothing in `dist/` without its source in `src/` (a leftover of an earlier build — `tsc -b` never deletes), and every
 *     source map's sources are in the tarball (declaration and source maps point to `src/`, which ships for them);
 *   - `LICENSE` (the root's, byte for byte — `pnpm license:sync`) and `README.md`;
 *   - the packed manifest without the `@bespokecore/source` condition and without `workspace:` ranges; every internal
 *     dependency (also optional peers) at exactly the package's own version (lockstep — the exact `0.0.0` peers exist nowhere else);
 *   - every `exports`/`bin` target in the tarball, none of them TypeScript source (Node does not strip types under node_modules);
 *   - the metadata: MIT, repository with the package's directory, `engines.node`, public access with provenance;
 * then publint (warnings count) and @arethetypeswrong/cli with the `esm-only` profile: the packages are ESM only and need
 * Node ≥ 26.10, so `node10` and `node16` from CommonJS are not checked (a `require()` of them is not supported).
 * Also: the root `tsconfig.json` references every package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';
import { frameworkPackages, packAll, type FrameworkPackage, type PackageManifest, type PackedPackage } from './packages.ts';
import { licenseDrift } from './sync-license.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_CONDITION = '@bespokecore/source';
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const;

/** Files no tarball carries: tests and what only they use, and the compiler's build info. */
const TEST_FILES: readonly [RegExp, string][] = [
  [/(^|\/)__fixtures__\//, 'a test fixture'],
  [/(^|\/)test-helpers\//, 'a test helper'],
  [/\.test\.[cm]?[jt]sx?(\.map)?$|\.test\.d\.[cm]?ts(\.map)?$/, 'a test'],
  [/\.type-test\./, 'a type test'],
  [/\.tsbuildinfo$/, 'build info'],
];

/** The problems of one unpacked tarball (`dir` = its `package/` directory). */
export function checkTarball(packed: PackedPackage, dir: string, pkg: FrameworkPackage, license: string): string[] {
  const problems: string[] = [];
  const files = new Set(packed.files);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest & Record<string, any>;

  // stubs/ are templates the generators copy into apps — tests included (make:auth writes the auth module's tests).
  for (const file of packed.files.filter((name) => !name.startsWith('stubs/'))) {
    const test = TEST_FILES.find(([pattern]) => pattern.test(file));
    if (test) problems.push(`${file} is ${test[1]} — exclude it in "files"`);
  }
  for (const file of filesUnder(join(pkg.dir, 'stubs'))) {
    const path = `stubs/${file}`;
    if (!files.has(path)) problems.push(`${path} is missing — the stubs ship whole (the generators copy them)`);
  }

  // Leftovers: a compiled file needs its source next to it (a renamed or deleted source leaves its output behind).
  for (const file of packed.files) {
    const compiled = /^dist\/(.+?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/.exec(file);
    if (compiled && !files.has(`src/${compiled[1]}.ts`) && !files.has(`src/${compiled[1]}.tsx`)) {
      problems.push(`${file} has no source in src/ — a leftover of an earlier build? (bespoke package:build --clean)`);
    }
  }
  for (const file of packed.files.filter((name) => name.endsWith('.map'))) {
    const map = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { sources?: string[]; sourceRoot?: string };
    for (const source of map.sources ?? []) {
      const target = posix.normalize(posix.join(posix.dirname(file), map.sourceRoot ?? '', source));
      if (!files.has(target)) problems.push(`${file} points to ${target}, which is not in the tarball`);
    }
  }

  if (!files.has('LICENSE')) problems.push('LICENSE is missing — pnpm license:sync');
  else if (readFileSync(join(dir, 'LICENSE'), 'utf8') !== license) problems.push('LICENSE is not the root LICENSE — pnpm license:sync');
  if (!files.has('README.md')) problems.push('README.md is missing');

  if (JSON.stringify(manifest).includes(SOURCE_CONDITION)) {
    problems.push(`the packed package.json still has the "${SOURCE_CONDITION}" condition — packed without pnpm, or publishConfig.exports is missing`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
      if (range.startsWith('workspace:')) problems.push(`${field}.${name} is "${range}" — a workspace range in a tarball`);
      else if (name.startsWith('@bespokecore/') && range !== manifest.version) {
        problems.push(`${field}.${name} is "${range}", not exactly ${manifest.version} — internal versions are exact (lockstep, workspace:*)`);
      }
    }
  }

  for (const [where, target] of exportTargets(manifest)) {
    const path = posix.normalize(target);
    if (!files.has(path)) problems.push(`${where} → ${target} is not in the tarball`);
    if (/\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path)) {
      problems.push(`${where} → ${target} is TypeScript source — Node does not strip types under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)`);
    }
  }

  const source = pkg.manifest as Record<string, any>;
  if (manifest.license !== 'MIT') problems.push(`license is ${JSON.stringify(manifest.license)}, not "MIT"`);
  if (manifest.repository?.directory !== `packages/${pkg.short}` || !String(manifest.repository?.url ?? '').includes('github.com/bespokecore/bespokecore')) {
    problems.push(`repository must name github.com/bespokecore/bespokecore with directory "packages/${pkg.short}"`);
  }
  if (manifest.engines?.node !== '>=26.10') problems.push('engines.node must be ">=26.10"');
  for (const field of ['description', 'keywords', 'homepage', 'bugs'] as const) if (!manifest[field]) problems.push(`${field} is missing`);
  if (source.publishConfig?.access !== 'public' || source.publishConfig?.provenance !== true) {
    problems.push('publishConfig needs "access": "public" and "provenance": true');
  }
  return problems;
}

/** The files below `dir`, relative to it, with forward slashes (none when it does not exist). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

/** Every file `exports` (all conditions) and `bin` point to, with where it is named. */
function exportTargets(manifest: Record<string, any>): [string, string][] {
  const targets: [string, string][] = [];
  const walk = (value: unknown, where: string) => {
    if (typeof value === 'string') targets.push([where, value]);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, `${where}["${key}"]`);
  };
  walk(manifest.exports, 'exports');
  if (typeof manifest.bin === 'string') targets.push(['bin', manifest.bin]);
  else walk(manifest.bin, 'bin');
  for (const field of ['main', 'types', 'module']) if (typeof manifest[field] === 'string') targets.push([field, manifest[field]]);
  return targets.filter(([, target]) => !target.includes('*'));
}

async function lint(packed: PackedPackage): Promise<string[]> {
  const buffer = readFileSync(packed.tarball);
  const tarball = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const { messages, pkg } = await publint({ pack: { tarball }, level: 'warning', strict: true });
  return messages.map((message) => `publint: ${formatMessage(message, pkg, { color: false }) ?? message.code}`);
}

function typesWrong(packed: PackedPackage): string[] {
  const result = spawnSync(
    join(root, 'node_modules/.bin/attw'),
    [packed.tarball, '--profile', 'esm-only', '--no-definitely-typed', '--format', 'ascii', '--no-emoji', '--no-color', '--no-summary'],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return [];
  return [`attw (esm-only) failed:\n${(result.stdout + result.stderr).trim().replace(/^/gm, '      ')}`];
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { 'no-build': { type: 'boolean' }, keep: { type: 'boolean' } } });
  const started = performance.now();
  const packages = frameworkPackages(root);
  const problems = new Map<string, string[]>();
  const report = (name: string, list: string[]) => list.length > 0 && problems.set(name, [...(problems.get(name) ?? []), ...list]);

  if (values['no-build'] !== true) {
    console.log('pack:check: bespoke package:build --clean');
    const build = spawnSync(process.execPath, [join(root, 'packages/cli/bin/bespoke.js'), 'package:build', '--clean', ...packages.map((pkg) => relative(root, pkg.dir))], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (build.status !== 0) {
      console.error(`pack:check: the clean build failed (exit ${build.status ?? build.signal}).`);
      return 1;
    }
  }

  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { references?: { path: string }[] };
  const referenced = new Set((tsconfig.references ?? []).map((reference) => posix.normalize(reference.path)));
  for (const pkg of packages) {
    if (existsSync(join(pkg.dir, 'tsconfig.json')) && !referenced.has(`packages/${pkg.short}`)) {
      report(pkg.name, [`the root tsconfig.json does not reference packages/${pkg.short}`]);
    }
  }
  for (const file of licenseDrift(root)) report(`@bespokecore/${file.split('/')[1]}`, [`${file} is missing or not the root LICENSE — pnpm license:sync`]);

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-pack-check-')));
  try {
    const packed = packAll(root, join(work, 'tarballs'));
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    const missing = packages.filter((pkg) => !packed.some((tarball) => tarball.name === pkg.name));
    for (const pkg of missing) report(pkg.name, ['pnpm pack made no tarball']);

    await Promise.all(
      packed.map(async (tarball) => {
        const pkg = packages.find((candidate) => candidate.name === tarball.name)!;
        const unpacked = join(work, 'unpacked', pkg.short);
        mkdirSync(unpacked, { recursive: true });
        const tar = spawnSync('tar', ['-xzf', tarball.tarball, '-C', unpacked]);
        if (tar.status !== 0) return report(pkg.name, [`could not unpack ${tarball.tarball}: ${tar.stderr}`]);
        report(pkg.name, checkTarball(tarball, join(unpacked, 'package'), pkg, license));
        report(pkg.name, await lint(tarball));
        report(pkg.name, typesWrong(tarball));
      }),
    );

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (problems.size === 0) {
      const files = packed.reduce((sum, tarball) => sum + tarball.files.length, 0);
      const bytes = packed.reduce((sum, tarball) => sum + readFileSync(tarball.tarball).byteLength, 0);
      console.log(`pack:check: ${packed.length} tarballs, ${files} files, ${(bytes / 1024).toFixed(0)} KB — all rules, publint and attw green (${seconds}s).`);
      return 0;
    }
    for (const [name, list] of [...problems].sort(([a], [b]) => a.localeCompare(b))) {
      console.error(`\n✗ ${name}`);
      for (const problem of list) console.error(`  • ${problem}`);
    }
    const count = [...problems.values()].reduce((sum, list) => sum + list.length, 0);
    console.error(`\npack:check: ${count} problem${count === 1 ? '' : 's'} in ${problems.size} package${problems.size === 1 ? '' : 's'} (${seconds}s).`);
    return 1;
  } finally {
    if (values.keep) console.log(`pack:check: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();

