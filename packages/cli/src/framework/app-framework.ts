import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { problemsAgainst, UnreadableTree } from '../check/packages.ts';
import { FRAMEWORK_NAME, isFramework, PROTOCOL, readManifest, resolveFirst } from './manifest.ts';
import { readPnpmWorkspace } from './pnpm-workspace.ts';
import { parseVersion, type Version } from './versions.ts';

const COMPARATOR = String.raw`(?:(?:<=|>=|<|>|=|\^|~) {0,2})?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const RANGE = String.raw`${COMPARATOR}(?: (?:- )?${COMPARATOR})*`;

/** A tarball by its name: it may look like a version (`1.0.0-rc.tgz`) but is a file. */
const TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;

/** What a registry resolves by version: comparators (a space may follow the operator) joined by single spaces or `||` (exact versions, `^`/`~` ranges, x-ranges, hyphen ranges), or a tag such as `latest`. No protocol, path, URL or flag. */
const REGISTRY_SPEC = new RegExp(String.raw`^(?:${RANGE}(?: {0,2}\|\| {0,2}${RANGE})*|[a-z][a-z0-9-]*)$`);

/** A `marmeon` or `@marmeon/*` package the app lists. */
export interface ListedPackage {
  readonly name: string;
  readonly spec: string;
  readonly group: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
  /** The version found in `node_modules`, or `undefined` when it is not installed. */
  readonly installed: string | undefined;
}

export type FrameworkRefusal = 'no-manifest' | 'unreadable' | 'no-framework' | 'not-installed' | 'not-from-registry' | 'mixed';

/**
 * The outcome of {@link readFrameworkState}. `message` and `fix` carry text from the app's manifests and `node_modules`, so a command
 * prints them through its output (`escapeControl`), never raw.
 */
export type FrameworkState =
  | { readonly ok: true; readonly version: Version; readonly packages: ListedPackage[] }
  | { readonly ok: false; readonly reason: FrameworkRefusal; readonly message: string; /** What the developer can do about it. */ readonly fix?: string; readonly packages: ListedPackage[] };

const GROUPS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'] as const;

/** The framework package a key of an overrides or patch field names: `name`, `name@range`, `parent>name`, `path/name` (yarn). */
function namesFramework(key: string): boolean {
  return key.split('>').some((raw) => {
    const segment = raw.trim();
    // The range starts at the first `@` that is not the scope's and does not follow a `/` (`name@npm:@scope/x@1`, `name@github:user/repo`).
    let cut = segment.length;
    for (let at = 1; at < segment.length; at++) {
      if (segment[at] === '@' && segment[at - 1] !== '/') {
        cut = at;
        break;
      }
    }
    // The last package of a path (`**/name`, `parent/@scope/name`).
    const tokens = segment.slice(0, cut).trim().split('/');
    const last = tokens.length >= 2 && tokens[tokens.length - 2]!.startsWith('@') ? tokens.slice(-2).join('/') : tokens[tokens.length - 1]!;
    return isFramework(last);
  });
}

/** Whether `value` (the object of an overrides field, however deep) changes a framework package: a key that names one, or an `npm:` alias of one. */
function overridesFramework(value: unknown): boolean {
  if (typeof value === 'string') {
    const alias = value.trim();
    return alias.startsWith('npm:') && namesFramework(alias.slice(4));
  }
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, inner]) => namesFramework(key) || overridesFramework(inner));
}

/** Whether the keys of `value` (a `patchedDependencies` object) include a framework package. */
const patchesFramework = (value: unknown): boolean => typeof value === 'object' && value !== null && Object.keys(value).some(namesFramework);

/**
 * The framework version of the app in `root`, when it is unambiguous: every `marmeon` and `@marmeon/*` package the app lists (in
 * `dependencies`, `optionalDependencies`, `devDependencies` or `peerDependencies`) is installed in the app's own `node_modules/` (never from
 * above it) in one version, no second copy of one is installed through anything the app installs (its listed packages and,
 * transitively, their dependencies, peers and optionals, judged by the first `package.json` Node would load), each is listed with a spec a
 * registry resolves, and no override or patch changes that. Otherwise the refusal says why. The reference is the installed
 * `@marmeon/core`, else the installed `marmeon` (which must bring that very `@marmeon/core`).
 */
export function readFrameworkState(root: string, { maxWalk }: { readonly maxWalk?: number } = {}): FrameworkState {
  const file = join(root, 'package.json');
  const refuse = (reason: FrameworkRefusal, message: string, fix?: string, packages: ListedPackage[] = []): FrameworkState => ({ ok: false, reason, message, ...(fix === undefined ? {} : { fix }), packages });
  if (!existsSync(file)) return refuse('no-manifest', 'there is no package.json here', "run this in the app's root, next to its package.json");
  const app = readManifest(file) as Record<string, unknown> | undefined;
  if (!app || Array.isArray(app)) return refuse('unreadable', 'package.json could not be read', 'correct package.json so that it is one JSON object');

  const packages: ListedPackage[] = [];
  const peerSpecs: { name: string; spec: string }[] = [];
  for (const group of GROUPS) {
    const entries = app[group];
    if (entries === undefined) continue;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return refuse('unreadable', `"${group}" in package.json is not an object`, `make "${group}" an object of package names and versions`, packages);
    for (const [name, spec] of Object.entries(entries)) {
      if (!isFramework(name)) {
        // A framework package installed under another name (`"legacy": "npm:@marmeon/core@1.0.0"`) is not in lockstep with the app's.
        const alias = resolveFirst(root, name, root);
        if (typeof alias?.manifest?.name === 'string' && FRAMEWORK_NAME.test(alias.manifest.name)) {
          return refuse('not-from-registry', `${name} is installed as ${alias.manifest.name}, a framework package under another name`, 'list the framework package under its own name, from the registry', packages);
        }
        continue;
      }
      if (!FRAMEWORK_NAME.test(name)) return refuse('unreadable', `package.json lists "${name}", which is not the name of a framework package`, 'remove it, or correct the name', packages);
      if (typeof spec !== 'string') return refuse('unreadable', `${name} has no version in package.json`, `list ${name} with an exact version from the registry`, packages);
      const before = packages.find((listed) => listed.name === name);
      if (before) {
        // A peer range beside the pin of a package's own repository is no contradiction: the peer spec is only validated, the other listing is judged.
        if (group === 'peerDependencies') {
          peerSpecs.push({ name, spec });
          continue;
        }
        if (before.spec !== spec) return refuse('unreadable', `${name} is listed as "${before.spec}" in ${before.group} and as "${spec}" in ${group}`, `list ${name} once, or with the same version in both`, packages);
        continue;
      }
      // The first package.json Node would load, whatever it says.
      const found = resolveFirst(root, name, root);
      if (found && typeof found.manifest?.version !== 'string') return refuse('unreadable', `the installed ${name} has no readable version in its package.json`, 'reinstall it from the registry', packages);
      packages.push({ name, spec, group, installed: found?.manifest?.version as string | undefined });
    }
  }
  if (packages.length === 0) return refuse('no-framework', 'package.json lists neither marmeon nor an @marmeon package', 'run this in a Marmeon app');

  for (const { name, spec } of [...packages, ...peerSpecs]) {
    if (PROTOCOL.test(spec) || TARBALL.test(spec) || !REGISTRY_SPEC.test(spec)) return refuse('not-from-registry', `${name} is listed as "${spec}", which is not a version from a registry`, `list an exact version of ${name} from the registry`, packages);
  }
  const pnpm = (typeof app.pnpm === 'object' && app.pnpm !== null ? app.pnpm : {}) as { overrides?: unknown; patchedDependencies?: unknown };
  const PATCH_FIX = 'remove the patch before you add or upgrade framework packages';
  if (patchesFramework(pnpm.patchedDependencies) || patchesFramework(app.patchedDependencies)) {
    return refuse('not-from-registry', 'package.json patches a framework package', PATCH_FIX, packages);
  }
  if (overridesFramework(app.overrides) || overridesFramework(app.resolutions) || overridesFramework(pnpm.overrides)) {
    return refuse('not-from-registry', 'an override in package.json changes a framework package', 'remove the override, so that every framework package comes from the registry in one version', packages);
  }
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  if (existsSync(workspaceFile)) {
    const workspace = readPnpmWorkspace(workspaceFile);
    if (!workspace.readable) return refuse('unreadable', 'pnpm-workspace.yaml could not be read', `rewrite line ${workspace.line} of pnpm-workspace.yaml in block style with plain or quoted scalars, or take it out`, packages);
    if (workspace.patchedDependencies.some(namesFramework)) return refuse('not-from-registry', 'pnpm-workspace.yaml patches a framework package', PATCH_FIX, packages);
    if (workspace.overrides.some(({ key, value }) => namesFramework(key) || overridesFramework(value))) return refuse('not-from-registry', 'an override in pnpm-workspace.yaml changes a framework package', 'remove the override, so that every framework package comes from the registry in one version', packages);
  }

  const missing = packages.filter((listed) => listed.installed === undefined);
  if (missing.length > 0) {
    const names = missing.map((listed) => listed.name).join(', ');
    return refuse('not-installed', `${names} ${missing.length === 1 ? 'is' : 'are'} not installed`, "run your package manager's install, then try again", packages);
  }

  const core = packages.find((listed) => listed.name === '@marmeon/core');
  const reference = core ?? packages.find((listed) => listed.name === 'marmeon');
  if (!reference) return refuse('no-framework', 'package.json lists neither marmeon nor @marmeon/core', 'run this in a Marmeon app', packages);
  const referenceVersion = reference.installed!;
  const version = parseVersion(referenceVersion);
  if (!version) return refuse('unreadable', `the installed ${reference.name} has the version "${referenceVersion}", which is not an exact version`, 'reinstall it from the registry', packages);

  const mixed = (messages: string[]) => refuse('mixed', messages.join('; '), "install every Marmeon package in the app's version", packages);
  if (core === undefined) {
    // The CLI runs on the core `marmeon` brings; it must be that very version.
    const brought = resolveFirst(resolveFirst(root, 'marmeon', root)!.dir, '@marmeon/core')?.manifest?.version;
    if (brought !== referenceVersion) {
      return mixed([`marmeon ${referenceVersion} uses @marmeon/core ${typeof brought === 'string' ? brought : '(not installed or not readable)'}, not its own version`]);
    }
  }
  let problems;
  try {
    problems = problemsAgainst(root, core ? '@marmeon/core' : 'marmeon', { transitive: true, strict: true, ...(maxWalk === undefined ? {} : { maxWalk }) });
  } catch (error) {
    if (error instanceof UnreadableTree) return refuse('unreadable', error.message, 'reinstall the package, or remove it', packages);
    return refuse('unreadable', 'package.json could not be read', 'correct package.json so that it is one JSON object', packages);
  }
  if (problems === undefined) return mixed(['the versions of the framework packages could not be compared']);
  const errors = problems.filter((problem) => problem.severity === 'error');
  if (errors.length > 0) return mixed(errors.map((problem) => problem.message));
  return { ok: true, version, packages };
}
