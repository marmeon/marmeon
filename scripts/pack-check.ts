/**
 * `pnpm pack:check` — are the tarballs fit to publish? A part of `pnpm run ci`. The rules in full: CONTRIBUTING.md, "Pull requests
 * and releases". Tarballs are made with `pnpm pack`: only pnpm applies `publishConfig.exports`.
 *
 *   pnpm pack:check                          # clean build → pnpm pack of every package → the rules → publint → attw
 *   node scripts/pack-check.ts --no-build    # the tarballs of the current dist/ (quicker; CI always builds clean)
 *   node scripts/pack-check.ts --keep        # leave the tarballs and their unpacked contents in $TMPDIR (the path is printed)
 *
 * No tests or build info (`stubs/` and `template/` ship whole), no `dist/` file without its source, `LICENSE` byte for byte, no
 * `@marmeon/source` condition or `workspace:` range, internal dependencies at the exact own version, every `exports`/`bin` target
 * present and not TypeScript, no file naming the private record (rule 7 of `check:source`); `create-marmeon`: no dependencies.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';
import { privateRecordHits, privateRecordWhy, type SourceFile } from './check-source.ts';
import { checkDriverRule, frameworkPackages, packAll, type FrameworkPackage, type PackageManifest, type PackedPackage } from './packages.ts';
import { licenseDrift } from './sync-license.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_CONDITION = '@marmeon/source';
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

  // stubs/ and template/ are copied into apps — tests included (make:auth writes the auth module's tests, create-marmeon the app's).
  for (const file of packed.files.filter((name) => !name.startsWith('stubs/') && !name.startsWith('template/'))) {
    const test = TEST_FILES.find(([pattern]) => pattern.test(file));
    if (test) problems.push(`${file} is ${test[1]} — exclude it in "files"`);
  }
  for (const part of ['stubs', 'template']) {
    for (const file of filesUnder(join(pkg.dir, part))) {
      const path = `${part}/${file}`;
      if (!files.has(path)) problems.push(`${path} is missing — ${part}/ ships whole (it is copied into apps)`);
    }
  }
  if (pkg.short === 'create-marmeon') problems.push(...checkScaffolder(packed, dir, manifest));

  // Leftovers: a compiled file needs its source next to it (a renamed or deleted source leaves its output behind).
  for (const file of packed.files) {
    const compiled = /^dist\/(.+?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/.exec(file);
    if (compiled && !files.has(`src/${compiled[1]}.ts`) && !files.has(`src/${compiled[1]}.tsx`)) {
      problems.push(`${file} has no source in src/ — a leftover of an earlier build? (marmeon package:build --clean)`);
    }
  }
  for (const file of packed.files.filter((name) => name.endsWith('.map'))) {
    const map = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { sources?: string[]; sourceRoot?: string };
    for (const source of map.sources ?? []) {
      const target = posix.normalize(posix.join(posix.dirname(file), map.sourceRoot ?? '', source));
      if (!files.has(target)) problems.push(`${file} points to ${target}, which is not in the tarball`);
    }
  }

  // A dotenv file ships only when "files" names it (pnpm 13 refuses others): never by a directory entry that happens to hold one.
  const listed = new Set(((pkg.manifest as Record<string, unknown>).files as string[] | undefined) ?? []);
  for (const file of packed.files.filter((name) => /(^|\/)\.env(\.(?!example$)[^/]+)?$/.test(name))) {
    if (!listed.has(file)) problems.push(`${file} is a dotenv file "files" does not name — list it on purpose, or leave it out (pnpm 13 refuses to pack it)`);
  }

  if (!files.has('LICENSE')) problems.push('LICENSE is missing — pnpm license:sync');
  else if (readFileSync(join(dir, 'LICENSE'), 'utf8') !== license) problems.push('LICENSE is not the root LICENSE — pnpm license:sync');
  if (!files.has('README.md')) problems.push('README.md is missing');
  if (!files.has('CHANGELOG.md')) problems.push('CHANGELOG.md is missing — add it to "files"');

  if (JSON.stringify(manifest).includes(SOURCE_CONDITION)) {
    problems.push(`the packed package.json still has the "${SOURCE_CONDITION}" condition — packed without pnpm, or publishConfig.exports is missing`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
      if (range.startsWith('workspace:')) problems.push(`${field}.${name} is "${range}" — a workspace range in a tarball`);
      else if ((name.startsWith('@marmeon/') || name === 'marmeon') && range !== manifest.version) {
        problems.push(`${field}.${name} is "${range}", not exactly ${manifest.version} — internal versions are exact (lockstep, workspace:*)`);
      }
    }
  }

  // The driver rule: which third-party library is a dependency, an optional peer or a shared peer.
  for (const problem of checkDriverRule(pkg.short, manifest)) problems.push(problem);
  for (const hit of privateRecordInTarball(packed, dir)) {
    problems.push(`${hit} — no references to the private record (${privateRecordWhy(hit)})`);
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
  if (manifest.repository?.directory !== `packages/${pkg.short}` || !String(manifest.repository?.url ?? '').includes('github.com/marmeon/marmeon')) {
    problems.push(`repository must name github.com/marmeon/marmeon with directory "packages/${pkg.short}"`);
  }
  if (manifest.engines?.node !== '>=26.10') problems.push('engines.node must be ">=26.10"');
  for (const field of ['description', 'keywords', 'homepage', 'bugs'] as const) if (!manifest[field]) problems.push(`${field} is missing`);
  if (source.publishConfig?.access !== 'public' || source.publishConfig?.provenance !== true) {
    problems.push('publishConfig needs "access": "public" and "provenance": true');
  }
  return problems;
}

/** Rule 7 of `pnpm check:source` over every text file of an unpacked tarball (`dir`) — `<package>/<path>:line: what: text`. */
export function privateRecordInTarball(packed: Pick<PackedPackage, 'name' | 'files'>, dir: string): string[] {
  const files: SourceFile[] = [];
  for (const path of packed.files) {
    const bytes = readFileSync(join(dir, path));
    if (!bytes.subarray(0, 8000).includes(0)) files.push({ path: `${packed.name}/${path}`, text: bytes.toString('utf8') });
  }
  return privateRecordHits(files);
}

/**
 * `create-marmeon`: no dependencies — the first thing a stranger runs pulls in nothing else; its template carries no
 * `.env` and no `APP_KEY` with a value (each app gets its own).
 */
function checkScaffolder(packed: PackedPackage, dir: string, manifest: Record<string, any>): string[] {
  const problems: string[] = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const list = manifest[field] as Record<string, string> | string[] | undefined;
    const names = Array.isArray(list) ? list : Object.keys(list ?? {});
    if (names.length > 0) problems.push(`${field}: ${names.join(', ')} — create-marmeon has no dependencies (prompts over node:readline)`);
  }
  for (const file of packed.files.filter((name) => name.startsWith('template/'))) {
    if (/(^|\/)\.env$/.test(file)) problems.push(`${file} is a .env — the template never carries one (the app's .env is written with a fresh APP_KEY)`);
    else if (/^APP_KEY=\S/m.test(readFileSync(join(dir, file), 'utf8'))) problems.push(`${file} sets APP_KEY — the template leaves it empty (each app gets a fresh key)`);
  }
  if (!packed.files.includes('template/base/_package.json')) problems.push('template/base/_package.json is missing — pnpm template:sync');
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

/** The stylesheets a package exports (`@marmeon/react/styles.css`) — no types to check there; publint checks that they ship. */
export function stylesheetEntrypoints(manifest: Record<string, unknown>): string[] {
  const exports = manifest.exports;
  if (typeof exports !== 'object' || exports === null) return [];
  return Object.keys(exports).filter((key) => key.endsWith('.css'));
}

function typesWrong(packed: PackedPackage, manifest: Record<string, unknown>): string[] {
  const stylesheets = stylesheetEntrypoints(manifest);
  const result = spawnSync(
    join(root, 'node_modules/.bin/attw'),
    [
      packed.tarball,
      ...['--profile', 'esm-only', '--no-definitely-typed', '--format', 'ascii', '--no-emoji', '--no-color', '--no-summary'],
      ...(stylesheets.length > 0 ? ['--exclude-entrypoints', ...stylesheets] : []),
    ],
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
    console.log('pack:check: marmeon package:build --clean');
    const build = spawnSync(process.execPath, [join(root, 'packages/cli/bin/marmeon.js'), 'package:build', '--clean', ...packages.map((pkg) => relative(root, pkg.dir))], {
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
  for (const file of licenseDrift(root)) {
    const pkg = packages.find((candidate) => candidate.short === file.split('/')[1]);
    report(pkg?.name ?? file, [`${file} is missing or not the root LICENSE — pnpm license:sync`]);
  }

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-pack-check-')));
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
        // attw checks what importing the package resolves to — a package that only has a bin (create-marmeon) has nothing to import.
        const packedManifest = JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8')) as Record<string, unknown>;
        if (['exports', 'main', 'types', 'module'].some((field) => field in packedManifest)) report(pkg.name, typesWrong(tarball, packedManifest));
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

