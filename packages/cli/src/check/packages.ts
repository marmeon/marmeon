import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXACT, FRAMEWORK_NAME, isFramework, PROTOCOL, readManifest, resolveFirst, resolveInstalled, type Manifest } from '../framework/manifest.ts';
import { reportOf, unrunReport, type CheckProblem } from './report.ts';
import { plainReason, type CheckRun } from './tools.ts';

const DOCS = 'docs/check.md#the-packages-check';

/** The most directories the strict walk follows unless `maxWalk` says otherwise. */
const MAX_WALK = 50_000;

/** A package in the tree of an app that cannot be judged: thrown by the strict walk, the caller refuses with the message. */
export class UnreadableTree extends Error {}

/**
 * How {@link problemsAgainst} looks. `transitive` follows every dependency of the app (its listed groups and, below them, dependencies, peers
 * and optionals) for a second copy, judging the first `package.json` Node would load. `strict` takes the app's own packages the same way from
 * the app's `node_modules` only, never from above it, and lists its `optionalDependencies` and `peerDependencies` too.
 */
export interface ProblemOptions {
  readonly transitive?: boolean;
  readonly strict?: boolean;
  /** The most directories the walk follows before it gives up with `UnreadableTree` (default 50 000). */
  readonly maxWalk?: number;
}

/**
 * What is wrong with the versions of `marmeon` and the `@marmeon/*` packages an app uses against the installed `referenceName` package
 * (see {@link packageProblems}). `undefined` without a `package.json` or an installed `referenceName` package; throws when `package.json` cannot be read.
 */
export function problemsAgainst(root: string, referenceName: '@marmeon/core' | 'marmeon', { transitive = false, strict = false, maxWalk = MAX_WALK }: ProblemOptions = {}): CheckProblem[] | undefined {
  if (!existsSync(join(root, 'package.json'))) return undefined;
  const app = readManifest(join(root, 'package.json'));
  if (!app) throw new Error('package.json could not be read');
  const listed = new Map<string, { readonly spec: string; readonly dev: boolean }>();
  for (const [dev, group] of [[true, app.devDependencies], ...(strict ? [[false, app.optionalDependencies] as const, [false, app.peerDependencies] as const] : []), [false, app.dependencies]] as const) {
    for (const [name, spec] of Object.entries(group ?? {})) if (isFramework(name) && typeof spec === 'string') listed.set(name, { spec, dev });
  }
  const installed = new Map<string, { readonly dir: string; readonly version: unknown }>();
  for (const name of listed.keys()) {
    const found = strict ? resolveFirst(root, name, root) : resolveInstalled(root, name);
    if (found) installed.set(name, { dir: found.dir, version: found.manifest?.version });
  }
  const reference = installed.get(referenceName);
  if (!reference) return undefined;

  const problems: CheckProblem[] = [];
  const wrong = new Set<string>();
  // A second copy by who holds it and in which version, so that the loops below and the walk report one copy once.
  const reported = new Set<string>();
  const copyKey = (holder: string, holderVersion: unknown, other: string, copyVersion: unknown) => `${holder}|${String(holderVersion)}|${other}|${String(copyVersion)}`;
  // Advice text only: the lockfile as make:docker finds it, npm only when there is no pnpm lockfile. (`detectPackageManager` decides what a command runs and refuses what it cannot tell.)
  const npm = !existsSync(join(root, 'pnpm-lock.yaml')) && existsSync(join(root, 'package-lock.json'));
  const install = (name: string) => `${npm ? 'npm install' : 'pnpm add'} -E ${listed.get(name)?.dev ? '-D ' : ''}${name}@${String(reference.version)}`;
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
    problems.push(problem('error', `${name} is ${String(version)}, the app's framework is ${reference.version} — install it in that version`, install(name)));
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
        reported.add(copyKey(name, version, other, found.manifest.version));
        problems.push(
          problem(
            'error',
            `${name} ${String(version)} uses ${other} ${String(found.manifest.version)}, a second copy next to the app's ${String(reference.version)} — install it in the app's version`,
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
      reported.add(copyKey(name, found.manifest.version, other, copy.manifest.version));
      problems.push(
        problem(
          'error',
          `${name} ${String(found.manifest.version)} uses ${other} ${String(copy.manifest.version)}, a second copy next to the app's ${String(reference.version)} — use a version of ${name} that depends on the app's, or override ${other} to ${String(reference.version)}`,
        ),
      );
    }
  }
  if (transitive) {
    // Everything the app installs, transitively (an explicit queue and the real directories seen, so a cycle ends and a deep tree cannot overflow the stack).
    const visited = new Set<string>();
    const manifests = new Map<string, Manifest | undefined>();
    const queue: { readonly dir: string; readonly name: string; readonly manifest: Manifest | undefined }[] = [{ dir: root, name: '', manifest: app }];
    for (let next = queue.shift(), steps = 0; next !== undefined; next = queue.shift()) {
      // No tree of an app is this big: a walk that gets here is going round in circles, and ends instead of hanging the terminal.
      if (++steps > maxWalk) throw new UnreadableTree('the dependencies of the app could not be followed to an end');
      const { dir, name, manifest } = next;
      // What the app installs for itself includes its devDependencies; below it only what an install of that package brings.
      const groups = [manifest?.dependencies, manifest?.peerDependencies, manifest?.optionalDependencies, ...(dir === root ? [manifest?.devDependencies] : [])];
      for (const group of groups) {
        for (const [other, spec] of Object.entries(group ?? {})) {
          if (typeof spec !== 'string') continue;
          // Not installed means Node cannot load it either (an optional dependency, a peer left out): there is nothing to judge.
          const found = resolveFirst(dir, other, dir === root && strict ? root : undefined, manifests);
          if (!found) continue;
          // A package no one can read is not judged by looking away: its dependencies could be anything.
          if (found.manifest === undefined || Array.isArray(found.manifest)) throw new UnreadableTree(`${relative(root, found.dir) || found.dir} has a package.json that cannot be read`);
          // The installed copy decides, by the name in its manifest as well as by the key that declared it (`"legacy": "npm:@marmeon/core@1.0.0"`).
          const realName = typeof found.manifest.name === 'string' ? found.manifest.name : other;
          if (dir !== root && (isFramework(other) || FRAMEWORK_NAME.test(realName)) && found.manifest.version !== reference.version) {
            const label = realName === other ? other : `${other} (${realName})`;
            const key = copyKey(name, manifest?.version, other, found.manifest.version);
            if (!reported.has(key)) {
              reported.add(key);
              const copy = typeof found.manifest.version === 'string' ? found.manifest.version : 'in a version that cannot be read';
              problems.push(problem('error', `${name} ${String(manifest?.version)} uses ${label} ${copy}, a second copy next to the app's ${String(reference.version)} — install it in the app's version`, install(other)));
            }
          }
          if (visited.has(found.dir)) continue;
          visited.add(found.dir);
          queue.push({ dir: found.dir, name: other, manifest: found.manifest });
        }
      }
    }
  }
  return problems;
}

/**
 * What is wrong with the versions of `marmeon` and the `@marmeon/*` packages an app uses: every package must be in the version of
 * `@marmeon/core` (a package pins its siblings exactly, so another version brings a second core) and be listed exactly, not as a
 * range. `undefined` without a `package.json` or an installed `@marmeon/core`; throws when `package.json` cannot be read. See docs/check.md#the-packages-check.
 */
export function packageProblems(root: string): CheckProblem[] | undefined {
  return problemsAgainst(root, '@marmeon/core');
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
