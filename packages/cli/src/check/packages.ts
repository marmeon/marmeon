import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { reportOf, unrunReport, type CheckProblem } from './report.ts';
import { plainReason, type CheckRun } from './tools.ts';

const DOCS = 'docs/check.md#the-packages-check';

/** A version a registry serves, not a range or a tag: `1.0.0`, `1.0.0-rc.1`. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `workspace:*`, `file:…`, `link:…`, `catalog:`, `npm:…`: a package that is not looked up by version. */
const PROTOCOL = /^[a-z]+:/;

interface Manifest {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const isFramework = (name: string): boolean => name === 'marmeon' || name.startsWith('@marmeon/');

function readManifest(file: string): Manifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof manifest === 'object' && manifest !== null ? (manifest as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** The installed package `name` as `from` (the app's root or a package's real directory) resolves it: `node_modules/<name>` there or in a parent. */
function resolveInstalled(from: string, name: string): { readonly dir: string; readonly manifest: Manifest } | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    // pnpm keeps the dependencies of a package beside it (`…/node_modules/@marmeon/core` next to `…/node_modules/@marmeon/storage`).
    const candidates = [join(dir, 'node_modules', name), ...(basename(dir) === 'node_modules' ? [join(dir, name)] : [])];
    for (const candidate of candidates) {
      if (!existsSync(join(candidate, 'package.json'))) continue;
      const real = realpathSync(candidate);
      const manifest = readManifest(join(real, 'package.json'));
      if (manifest?.version !== undefined) return { dir: real, manifest };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * What is wrong with the versions of `marmeon` and the `@marmeon/*` packages an app uses: every package must be in the version of
 * `@marmeon/core` (a package pins its siblings exactly, so another version brings a second core) and be listed exactly, not as a
 * range. `undefined` without a `package.json` or an installed `@marmeon/core`; throws when `package.json` cannot be read. See docs/check.md#the-packages-check.
 */
export function packageProblems(root: string): CheckProblem[] | undefined {
  if (!existsSync(join(root, 'package.json'))) return undefined;
  const app = readManifest(join(root, 'package.json'));
  if (!app) throw new Error('package.json could not be read');
  const listed = new Map<string, { readonly spec: string; readonly dev: boolean }>();
  for (const [dev, group] of [[true, app.devDependencies], [false, app.dependencies]] as const) {
    for (const [name, spec] of Object.entries(group ?? {})) if (isFramework(name) && typeof spec === 'string') listed.set(name, { spec, dev });
  }
  const installed = new Map<string, { readonly dir: string; readonly version: string }>();
  for (const name of listed.keys()) {
    const found = resolveInstalled(root, name);
    if (found) installed.set(name, { dir: found.dir, version: found.manifest.version! });
  }
  const reference = installed.get('@marmeon/core');
  if (!reference) return undefined;

  const problems: CheckProblem[] = [];
  const wrong = new Set<string>();
  // The app's package manager, by its lockfile as make:docker finds it: npm only when it has no pnpm lockfile.
  const npm = !existsSync(join(root, 'pnpm-lock.yaml')) && existsSync(join(root, 'package-lock.json'));
  const install = (name: string) => `${npm ? 'npm install' : 'pnpm add'} -E ${listed.get(name)?.dev ? '-D ' : ''}${name}@${reference.version}`;
  const problem = (severity: CheckProblem['severity'], message: string, fix?: string): CheckProblem => ({
    severity,
    message,
    file: 'package.json',
    ...(fix === undefined ? {} : { fix }),
    docs: DOCS,
    rule: 'marmeon(packages)',
  });
  for (const [name, { version }] of installed) {
    if (version === reference.version) continue;
    wrong.add(name);
    problems.push(problem('error', `${name} is ${version}, the app's framework is ${reference.version} — install it in that version`, install(name)));
  }
  for (const [name, { spec }] of listed) {
    if (!installed.has(name) || wrong.has(name) || PROTOCOL.test(spec) || EXACT.test(spec)) continue;
    problems.push(problem('warning', `${name} is listed as "${spec}" — pin it exactly, or the next install may pick a version the other @marmeon packages do not match`, install(name)));
  }
  // A package in the app's version pins the others to it; when one resolves to another version, a second copy is installed.
  for (const [name, { dir, version }] of installed) {
    if (wrong.has(name)) continue;
    const manifest = readManifest(join(dir, 'package.json'));
    for (const group of [manifest?.dependencies, manifest?.peerDependencies]) {
      for (const [other, spec] of Object.entries(group ?? {})) {
        if (!isFramework(other) || PROTOCOL.test(spec)) continue;
        const found = resolveInstalled(dir, other);
        if (!found || found.manifest.version === version) continue;
        problems.push(
          problem(
            'error',
            `${name} ${version} uses ${other} ${found.manifest.version}, a second copy next to the app's ${reference.version} — install it in the app's version`,
            install(other),
          ),
        );
      }
    }
  }
  // A package of someone else that declares an @marmeon package exactly brings its own copy when the version differs.
  for (const name of Object.keys({ ...app.dependencies, ...app.devDependencies })) {
    if (isFramework(name)) continue;
    const found = resolveInstalled(root, name);
    for (const [other, spec] of Object.entries(found?.manifest.dependencies ?? {})) {
      if (!found || !isFramework(other) || PROTOCOL.test(spec)) continue;
      const copy = resolveInstalled(found.dir, other);
      if (!copy || copy.manifest.version === reference.version) continue;
      problems.push(
        problem(
          'error',
          `${name} ${found.manifest.version} uses ${other} ${copy.manifest.version}, a second copy next to the app's ${reference.version} — use a version of ${name} that depends on the app's, or override ${other} to ${reference.version}`,
        ),
      );
    }
  }
  return problems;
}

/** The findings of {@link packageProblems} as lines of advice (`message: fix`) for `marmeon dev` and a failed start; none when all is well or the packages cannot be read. */
export function packageAdvice(root: string): string[] {
  try {
    return (packageProblems(root) ?? []).map((problem) => (problem.fix === undefined ? problem.message : `${problem.message}: ${problem.fix}`));
  } catch {
    return [];
  }
}

/** `packageProblems` as a check: `skipped` when the app has no installed framework package to compare. */
export function packagesCheck(root: string): CheckRun {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const problems = packageProblems(root);
    if (problems === undefined) return { report: unrunReport('packages', 'skipped', 'no @marmeon/core installed', ms()) };
    return { report: reportOf('packages', problems, ms()) };
  } catch (error) {
    return { report: unrunReport('packages', 'error', `the packages could not be read: ${plainReason(error, root)}`, ms()) };
  }
}
