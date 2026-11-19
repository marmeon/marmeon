import { CommandArgumentsError } from '@marmeon/core';
import type { PackageManagerName, PackageManagerProcess } from './package-manager.ts';
import { breaksBetween, compareVersions, parseVersion, type Version } from './versions.ts';

/** What `--to` asked for: the `latest` tag, an exact version, or another dist-tag. */
export type TargetRequest = { readonly kind: 'latest' } | { readonly kind: 'version'; readonly version: Version } | { readonly kind: 'tag'; readonly tag: string };

const TAG = /^[a-z][a-z0-9-]*$/;

/** The request `--to=<value>` makes. Nothing but an exact version or a plain tag name passes: a range, a path or a spec is refused with exit 2. */
export function parseTarget(value: string | undefined): TargetRequest {
  if (value === undefined || value === 'latest') return { kind: 'latest' };
  const version = parseVersion(value);
  // Build metadata is valid semver, but an install spec with it is not worth the risk.
  if (version && !value.includes('+')) return { kind: 'version', version };
  if (TAG.test(value)) return { kind: 'tag', tag: value };
  throw new CommandArgumentsError('Pass --to=<version> (an exact version such as 1.2.0) or --to=<tag> (such as next).');
}

/**
 * `explicit` is true only for an exact version the developer typed (`--to=1.2.0`). A tag, `next` included, is chosen by the registry, and
 * `latest` is the default, so neither is explicit. It unlocks one thing: skipping the confirmation of a breaking move when there is no terminal.
 */
export type ResolvedTarget = { readonly ok: true; readonly version: Version; readonly explicit: boolean } | { readonly ok: false; readonly message: string };

interface RegistryAnswer {
  readonly tags: ReadonlyMap<string, string>;
  readonly versions: ReadonlySet<string>;
}

/** The answer of `<pm> view marmeon dist-tags versions --json` (pnpm and npm print the same shape), or `undefined` for any other. npm prints a bare string for `versions` when the package has a single version: that is refused. */
function readAnswer(stdout: string): RegistryAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { 'dist-tags': tags, versions } = value as Record<string, unknown>;
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags) || !Array.isArray(versions)) return undefined;
  const entries = Object.entries(tags);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
  if (!versions.every((entry) => typeof entry === 'string')) return undefined;
  return { tags: new Map(entries), versions: new Set(versions as string[]) };
}

/**
 * The version `request` names. An exact version needs no registry call (the install fails when it does not exist); `latest` and a tag are
 * read from the registry through the package manager. The registry's answer is untrusted: the version it names must be exact, a `latest`
 * must be no prerelease, and the version must be one the registry lists. A refusal is a message that suggests `--to=<version>`.
 */
export async function resolveTarget(request: TargetRequest, pm: PackageManagerName, process: PackageManagerProcess, root: string): Promise<ResolvedTarget> {
  if (request.kind === 'version') {
    if (request.version.text.includes('+')) return { ok: false, message: `"${request.version.text}" is not an exact version without build metadata. Pass --to=<version> without the part after "+".` };
    return { ok: true, version: request.version, explicit: true };
  }
  const tag = request.kind === 'latest' ? 'latest' : request.tag;
    const fallback = 'Pass --to=<version> to name the version yourself.';
  let result: { code: number; stdout: string };
  try {
    result = await process.run(pm, ['view', 'marmeon', 'dist-tags', 'versions', '--json'], { cwd: root, interactive: false, stdout: 'capture' });
  } catch (error) {
    return { ok: false, message: `${pm} could not look up marmeon (${error instanceof Error ? error.message : 'it failed'}). ${fallback}` };
  }
  if (result.code !== 0) return { ok: false, message: `${pm} view marmeon failed with exit code ${result.code}. ${fallback}` };
  const answer = readAnswer(result.stdout);
  if (!answer) return { ok: false, message: `${pm} view marmeon did not answer with the dist-tags and versions of the package. ${fallback}` };
  const named = answer.tags.get(tag);
  if (named === undefined) return { ok: false, message: `The registry has no "${tag}" tag for marmeon. ${fallback}` };
  const version = parseVersion(named);
  if (!version || named.includes('+')) return { ok: false, message: `The registry's "${tag}" tag for marmeon is not an exact version. ${fallback}` };
  if (tag === 'latest' && version.prerelease.length > 0) return { ok: false, message: `The registry's "latest" tag for marmeon is a prerelease. ${fallback}` };
  if (!answer.versions.has(named)) return { ok: false, message: `The registry's "${tag}" tag for marmeon names a version it does not list. ${fallback}` };
  return { ok: true, version, explicit: false };
}

/**
 * What a move is. `breaking` gates only the confirmation (another major, or another minor while the major is 0), never whether the guide is
 * shown: the command shows every section {@link upgradeGuide} returns.
 */
export type Jump = { readonly kind: 'downgrade' } | { readonly kind: 'same' } | { readonly kind: 'move'; readonly breaking: boolean };

/**
 * What moving the framework packages to `to` is, judged from the versions of every listed framework package (`installed`, at least one).
 * A package above `to` makes it a downgrade. The move is breaking from the lowest version, which is also where the upgrade guide starts.
 * It is `same` only when every package is already at `to`; a mix is a move, so `--to` repairs it.
 */
export function decideJump(installed: readonly Version[], to: Version): Jump {
  const [first, ...rest] = installed;
  if (!first) throw new Error('decideJump needs at least one installed version');
  let [lowest, highest] = [first, first];
  for (const version of rest) {
    if (compareVersions(version, lowest) < 0) lowest = version;
    if (compareVersions(version, highest) > 0) highest = version;
  }
  if (compareVersions(to, highest) < 0) return { kind: 'downgrade' };
  if (compareVersions(to, lowest) === 0) return { kind: 'same' };
  return { kind: 'move', breaking: breaksBetween(lowest, to) };
}
