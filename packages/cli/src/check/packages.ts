import { existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findPackage } from '@marmeon/core/internal';
import { EXACT, FRAMEWORK_NAME, isFramework, PROTOCOL, readManifest, resolveFirst, resolveInstalled, type Manifest } from '../framework/manifest.ts';
import { reportOf, unrunReport, type CheckProblem } from './report.ts';
import { plainReason, type CheckRun } from './tools.ts';

/** A version as the text of a finding shows it: only one a registry serves, since the manifest it comes from is not the app's. */
const shown = (version: unknown): string => (typeof version === 'string' && EXACT.test(version) ? version : 'in a version that cannot be read');

/** A name from a manifest: as it is when it holds only the characters of a package name, otherwise quoted with every character beyond printable ASCII escaped (an allow-list, so no line break, control or direction character reaches the output). */
const plain = (name: string): string =>
  /^[\w.@/~-]+$/.test(name) ? name : JSON.stringify(name).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const DOCS = 'docs/check.md#the-packages-check';

/** The most directories the strict walk follows unless `maxWalk` says otherwise. */
const MAX_WALK = 50_000;

/** A path inside a `node_modules` folder: where a package manager installs a package from a registry. */
const NODE_MODULES = /(^|[\\/])node_modules([\\/]|$)/;

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
    problems.push(problem('error', `${name} is ${shown(version)}, the app's framework is ${shown(reference.version)} — install it in that version`, install(name)));
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
        if (!FRAMEWORK_NAME.test(other) || PROTOCOL.test(spec)) continue;
        const found = resolveInstalled(dir, other);
        if (!found || found.manifest.version === version) continue;
        reported.add(copyKey(name, version, other, found.manifest.version));
        problems.push(
          problem(
            'error',
            `${name} ${shown(version)} uses ${other} ${shown(found.manifest.version)}, a second copy next to the app's ${shown(reference.version)} — install it in the app's version`,
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
      if (!found || !FRAMEWORK_NAME.test(other) || PROTOCOL.test(spec)) continue;
      const copy = resolveInstalled(found.dir, other);
      if (!copy || copy.manifest.version === reference.version) continue;
      reported.add(copyKey(name, found.manifest.version, other, copy.manifest.version));
      problems.push(
        problem(
          'error',
          `${name} ${shown(found.manifest.version)} uses ${other} ${shown(copy.manifest.version)}, a second copy next to the app's ${shown(reference.version)} — use a version of ${name} that depends on the app's, or override ${other} to ${shown(reference.version)}`,
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
          if (found.manifest === undefined || Array.isArray(found.manifest)) throw new UnreadableTree(`${plain(relative(root, found.dir) || found.dir)} has a package.json that cannot be read`);
          // The installed copy decides, by the name in its manifest as well as by the key that declared it (`"legacy": "npm:@marmeon/core@1.0.0"`).
          const realName = typeof found.manifest.name === 'string' ? found.manifest.name : other;
          if (dir !== root && (isFramework(other) || FRAMEWORK_NAME.test(realName)) && found.manifest.version !== reference.version) {
            const label = realName === other ? plain(other) : `${plain(other)} (${plain(realName)})`;
            const key = copyKey(name, manifest?.version, other, found.manifest.version);
            if (!reported.has(key)) {
              reported.add(key);
              problems.push(problem('error', `${plain(name)} ${shown(manifest?.version)} uses ${label} ${shown(found.manifest.version)}, a second copy next to the app's ${shown(reference.version)} — install it in the app's version`, install(other)));
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

const COPIES_DOCS = 'docs/package-publishing.md#one-copy-of-a-framework-package';

/**
 * A package of someone else the app lists (dependencies and devDependencies) whose `@marmeon/*` of `dependencies` or `peerDependencies`, resolved from that
 * package's real directory, is another directory than the one the app resolves the same name to, in the same version (whatever the range says, `workspace:` included).
 * A copy in another version is a warning here only where {@link problemsAgainst} does not judge the key (one that is only a peer, or has a protocol range); elsewhere
 * it is the error that function reports. The CLI `marmeon` is left out, it is types only. Nothing where {@link problemsAgainst} gives `undefined` (the app does not list
 * an installed `@marmeon/core`). A key that is not the name of a framework package is skipped. Throws when `package.json` cannot be read.
 */
function copyProblems(root: string): CheckProblem[] {
  if (problemsAgainst(root, '@marmeon/core') === undefined) return [];
  const app = readManifest(join(root, 'package.json'));
  if (!app) throw new Error('package.json could not be read');
  const problems: CheckProblem[] = [];
  const reported = new Set<string>();
  for (const name of Object.keys({ ...app.dependencies, ...app.devDependencies })) {
    if (isFramework(name)) continue;
    const found = resolveInstalled(root, name);
    if (!found) continue;
    const declared = typeof found.manifest.dependencies === 'object' && found.manifest.dependencies !== null ? found.manifest.dependencies : {};
    const peers = typeof found.manifest.peerDependencies === 'object' && found.manifest.peerDependencies !== null ? found.manifest.peerDependencies : {};
    for (const other of [...Object.keys(declared), ...Object.keys(peers)]) {
      if (!FRAMEWORK_NAME.test(other) || other === 'marmeon' || reported.has(`${name}|${other}`)) continue;
      const copy = resolveInstalled(found.dir, other);
      const mine = resolveInstalled(root, other);
      if (!copy || !mine || copy.dir === mine.dir) continue;
      const same = copy.manifest.version === mine.manifest.version;
      // Another version of a package that `problemsAgainst` judges (an exact range in `dependencies`) is its error, reported once there.
      const range = declared[other];
      if (!same && typeof range === 'string' && !PROTOCOL.test(range)) continue;
      reported.add(`${name}|${other}`);
      problems.push({
        severity: 'warning',
        message: same ? `${name} resolves another copy of ${other} (the same version, other peers)` : `${name} resolves its own copy of ${other} ${shown(copy.manifest.version)}, the app has ${shown(mine.manifest.version)}`,
        file: 'package.json',
        fix: "align the peers' versions, then pnpm dedupe",
        docs: COPIES_DOCS,
        rule: 'marmeon(packages)',
      });
    }
  }
  return problems;
}

/**
 * What is wrong with the versions of `marmeon` and the `@marmeon/*` packages an app uses: every package must be in the version of
 * `@marmeon/core` (a package pins its siblings exactly, so another version brings a second core) and be listed exactly, not as a
 * range. A warning besides: a package of someone else resolves its own copy of an `@marmeon/*` package that no error above reports (`workspace:` ranges included).
 * `undefined` without a `package.json` or an installed `@marmeon/core`; throws when `package.json` cannot be read. See docs/check.md#the-packages-check.
 */
export function packageProblems(root: string): CheckProblem[] | undefined {
  const problems = problemsAgainst(root, '@marmeon/core');
  return problems && [...problems, ...copyProblems(root)];
}

const asAdvice = (problems: readonly CheckProblem[]): string[] => problems.map((problem) => (problem.fix === undefined ? problem.message : `${problem.message}: ${problem.fix}`));

/**
 * The findings of {@link packageProblems} as lines of advice (`message: fix`) for `marmeon dev` and a failed start; none when all is well or the packages cannot be read.
 * `'copies'` gives only the second copies (also one in another version that no error reports), `'versions'` all the others.
 */
export function packageAdvice(root: string, only?: 'copies' | 'versions'): string[] {
  try {
    return asAdvice(only === 'copies' ? copyProblems(root) : only === 'versions' ? (problemsAgainst(root, '@marmeon/core') ?? []) : (packageProblems(root) ?? []));
  } catch {
    return [];
  }
}

/** A valid npm package name, as `findPackage` reads one (older ones have capitals). */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** Whether `dir` lies inside a `node_modules` folder below the part of its path it shares with `root` (the app may itself be checked out under one). */
function installedBelow(root: string, dir: string): boolean {
  const base = root.split(sep);
  const parts = dir.split(sep);
  let shared = 0;
  while (shared < base.length && shared < parts.length && base[shared] === parts[shared]) shared++;
  return NODE_MODULES.test(parts.slice(shared).join('/'));
}

/**
 * Every second copy of one `@marmeon/*` package in the installed tree an app reaches, as lines of advice in the form of {@link packageAdvice}'s: a copy is a
 * directory the walk resolves `name` to (by its key or by the `name` of the installed manifest, so an alias counts) other than the one {@link findPackage}
 * gives the app, the copy the app loads. The walk starts at the app's `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` and follows
 * the `dependencies`, `optionalDependencies` and `peerDependencies` of every package it finds (and the `devDependencies` of one that lies outside every
 * `node_modules`, a workspace package), each resolved from that package's real directory as Node does and whatever its version; a package is visited once
 * per real directory. Reads the disk when called. None when the tree holds one copy.
 * Unlike {@link packageAdvice} it never looks away: it throws {@link UnreadableTree} when a `package.json` of the app or of an installed package cannot be read,
 * when the app has no copy of `name` or when the walk exceeds `maxWalk` directories, so a caller that must be sure refuses.
 */
export function secondCopies(root: string, name: `@marmeon/${string}`, maxWalk = MAX_WALK): string[] {
  // The walk starts at the real path of the app, so a root that is a symlink (a deploy's `current`) resolves as its packages do; the app's own copy is the one
  // found from the root as given, which is what tinker loads.
  let base: string;
  try {
    base = realpathSync.native(root);
  } catch {
    throw new UnreadableTree('the directory of the app cannot be read');
  }
  const app = readManifest(join(base, 'package.json'));
  if (!app) throw new UnreadableTree('the package.json of the app cannot be read');
  let mine: ReturnType<typeof findPackage>;
  try {
    mine = findPackage(name, root);
  } catch (error) {
    throw new UnreadableTree(`the app's copy of ${name} cannot be read (${error instanceof Error ? plain(error.message) : 'unknown error'})`);
  }
  if (!mine) throw new UnreadableTree(`the app's copy of ${name} was not found`);
  const mineVersion = (mine.json as { version?: unknown }).version;
  const lines: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const manifests = new Map<string, Manifest | undefined>();
  const queue: { readonly dir: string; readonly label: string; readonly manifest: Manifest }[] = [{ dir: base, label: 'the app', manifest: app }];
  for (let next = queue.shift(), steps = 0; next !== undefined; next = queue.shift()) {
    if (++steps > maxWalk) throw new UnreadableTree('the dependencies of the app could not be followed to an end');
    const { dir, label, manifest } = next;
    // A package outside every `node_modules` (a workspace package, a `link:` or `file:` one) is installed in place, and its devDependencies with it, which Node loads as well.
    const inPlace = dir === base || !installedBelow(base, dir);
    const groups = [
      ['dependencies', manifest.dependencies],
      ['optionalDependencies', manifest.optionalDependencies],
      ['peerDependencies', manifest.peerDependencies],
      ...(inPlace ? [['devDependencies', manifest.devDependencies] as const] : []),
    ] as const;
    for (const [groupName, group] of groups) {
      if (typeof group !== 'object' || group === null) continue;
      for (const [key, spec] of Object.entries(group)) {
        // A key that is no package name never reaches the file system (`../../x`).
        if (!PACKAGE_NAME.test(key)) continue;
        // Not installed means Node cannot load it either (an optional dependency, a peer left out): there is nothing to judge.
        const found = resolveFirst(dir, key, undefined, manifests);
        if (!found) continue;
        const where = plain(relative(base, found.dir) || found.dir);
        if (found.manifest === undefined || Array.isArray(found.manifest)) throw new UnreadableTree(`${where} has a package.json that cannot be read`);
        const realName = typeof found.manifest.name === 'string' ? found.manifest.name : key;
        if ((key === name || realName === name) && found.dir !== mine.dir && !seen.has(`${label}|${found.dir}`)) {
          seen.add(`${label}|${found.dir}`);
          const own = `${label} resolves its own copy of ${name} ${shown(found.manifest.version)}, the app has ${shown(mineVersion)}`;
          if (key !== name) lines.push(`${label} lists ${name} a second time as ${JSON.stringify(plain(key))} — list it once`);
          else if (groupName === 'dependencies' && typeof spec === 'string' && EXACT.test(spec)) lines.push(`${own}: use a version of ${label} that depends on the app's, or override ${name} to ${shown(mineVersion)}`);
          else lines.push(`${own}: align the peers' versions, then pnpm dedupe`);
        }
        if (visited.has(found.dir)) continue;
        visited.add(found.dir);
        queue.push({ dir: found.dir, label: plain(typeof found.manifest.name === 'string' ? found.manifest.name : key), manifest: found.manifest });
      }
    }
  }
  return lines;
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
