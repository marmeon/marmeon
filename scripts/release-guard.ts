/**
 * The first step of the release workflow: finds the release commit, checks it out, and refuses a run from the wrong ref or for a
 * version that is already tagged or on npm. Hands the commit, version, dist-tag and the draft's latest flag to the workflow.
 *
 * Side effect: `git checkout --detach <release commit>`. Every later step of the workflow works on that commit, not on the head of
 * the branch the workflow was started on, so a pull request merged after the release is never shipped unreviewed.
 *
 * Imports nothing but `node:*`, `./packages.ts` and `./release-rules.ts`: it runs before `pnpm install`, when no dependency of the
 * repository may run yet. The guards are a convenience; the gate is the 2FA approval of the staged release on npmjs.com.
 *
 *   node scripts/release-guard.ts            # GITHUB_REF_TYPE, GITHUB_REF_NAME and GITHUB_OUTPUT come from the workflow
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { frameworkPackages } from './packages.ts';
import { MAIN, maintenanceLine, parseVersion, releaseCommit, releaseSection, releaseTarget, spawnRunner, type Runner } from './release-rules.ts';

/** npm's error code for a package or version that does not exist (spelled so `check:source` does not read it as a decision number). */
const NOT_FOUND = `E${404}`;

/** The package whose `latest` dist-tag decides whether a release is the newest one. */
/** A full SHA-1 or SHA-256 object id: nothing else reaches the checkout or `$GITHUB_OUTPUT`. */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const LATEST_PACKAGE = '@marmeon/core';

export interface GuardContext {
  readonly root: string;
  /** `GITHUB_REF_TYPE`: `branch` or `tag`. */
  readonly refType: string | undefined;
  /** `GITHUB_REF_NAME`. */
  readonly branch: string | undefined;
  /** Runs git and npm in the repository. */
  readonly run: Runner;
}

export interface GuardResult {
  readonly problems: string[];
  readonly commit?: string;
  readonly version?: string;
  readonly distTag?: string;
  readonly markLatest?: boolean;
}

/** What `npm view --json` said: the parsed value, npm's error code, or neither (network failure, server error, broken output). */
type NpmAnswer = { kind: 'value'; value: unknown } | { kind: 'not-found' } | { kind: 'failed'; problem: string };

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function npmView(run: Runner, args: readonly string[]): NpmAnswer {
  const result = run('npm', ['view', ...args, '--json']);
  if (result.status === 0) {
    const value = jsonOf(result.stdout);
    return value === undefined ? { kind: 'failed', problem: `npm view ${args.join(' ')} printed no JSON: ${JSON.stringify(result.stdout.slice(0, 200))}` } : { kind: 'value', value };
  }
  // npm prints a failure as `{"error":{"code":…}}`, on stdout or stderr depending on its version.
  for (const text of [result.stdout, result.stderr]) {
    const error = (jsonOf(text) as { error?: { code?: unknown } } | undefined)?.error;
    if (error?.code === NOT_FOUND) return { kind: 'not-found' };
  }
  const detail = (result.stderr || result.stdout).trim().slice(0, 300);
  return { kind: 'failed', problem: `npm view ${args.join(' ')} failed (exit ${result.status ?? 'signal'})${detail ? `: ${detail}` : ''}` };
}

/** Runs every check; collects the problems it can after the checkout, and stops early where later checks would be meaningless. */
export function guard({ root, refType, branch, run }: GuardContext): GuardResult {
  if (refType !== 'branch' || branch === undefined || branch === '') {
    return { problems: [`The workflow was started on a ${refType ?? 'unknown'} ref; start it from main or from a maintenance branch such as 0.1.x or 1.x.`] };
  }
  if (branch !== MAIN && maintenanceLine(branch) === undefined) {
    return { problems: [`Branch ${branch} cannot release: start the workflow from main or from a maintenance branch such as 0.1.x or 1.x.`] };
  }

  const shallow = run('git', ['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') {
    return { problems: ['The clone is shallow or its state is unknown: the release commit needs the history (checkout with fetch-depth: 0).'] };
  }
  let commit: string;
  try {
    commit = releaseCommit(run);
  } catch (error) {
    return { problems: [(error as Error).message] };
  }
  if (!COMMIT_ID.test(commit)) return { problems: [`"${commit}" is not a commit id.`] };
  const checkout = run('git', ['checkout', '--quiet', '--detach', commit]);
  if (checkout.status !== 0) return { problems: [`Could not check out the release commit ${commit}: ${checkout.stderr.trim() || `exit ${checkout.status}`}`] };

  // From here on the working tree is the release commit's.
  const problems: string[] = [];
  const packages = frameworkPackages(root);
  const versions = [...new Set(packages.map((pkg) => pkg.manifest.version))];
  if (versions.length !== 1) {
    const byVersion = versions.map((found) => `${found}: ${packages.filter((pkg) => pkg.manifest.version === found).map((pkg) => pkg.name).join(', ')}`);
    return { problems: [`The packages do not share one version — ${byVersion.join('; ')}.`], commit };
  }
  const version = versions[0]!;
  if (!parseVersion(version)) return { problems: [`"${version}" is not a plain x.y.z version; prereleases are not released.`], commit };

  try {
    releaseSection(root, version);
  } catch (error) {
    problems.push((error as Error).message);
  }

  const tag = run('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${version}`]);
  if (tag.status === 0) {
    problems.push(
      `v${version} exists — nothing was prepared since it (pnpm release:prepare), or this version was staged already: approve or reject it on npmjs.com; a rejected version is replaced by the next patch.`,
    );
  } else if (tag.status !== 2) {
    problems.push(`Could not look up tag v${version} on origin (exit ${tag.status ?? 'signal'}): ${tag.stderr.trim()}`);
  }

  for (const pkg of packages) {
    const answer = npmView(run, [`${pkg.name}@${version}`, 'version']);
    if (answer.kind === 'failed') problems.push(answer.problem);
    else if (answer.kind === 'value') {
      problems.push(answer.value === version ? `${pkg.name}@${version} is already on npm.` : `${pkg.name}@${version}: npm answered ${JSON.stringify(answer.value)}, expected "not found" or "${version}".`);
    }
  }

  let latest: string | undefined;
  const latestAnswer = npmView(run, [LATEST_PACKAGE, 'dist-tags.latest']);
  if (latestAnswer.kind === 'failed') problems.push(latestAnswer.problem);
  else if (latestAnswer.kind === 'value' && typeof latestAnswer.value !== 'string') problems.push(`${LATEST_PACKAGE}'s latest dist-tag is ${JSON.stringify(latestAnswer.value)}, not a version.`);
  else if (latestAnswer.kind === 'value') latest = latestAnswer.value as string;
  if (problems.length > 0 || latestAnswer.kind === 'failed') return { problems, commit, version };

  const target = releaseTarget({ branch, version, latest });
  if (!target.ok) return { problems: [target.problem], commit, version };
  return { problems, commit, version, distTag: target.distTag, markLatest: target.markLatest };
}

/** The lines the workflow reads from `$GITHUB_OUTPUT`; only a guard without problems has any. */
export function outputLines(result: GuardResult): string[] {
  if (result.problems.length > 0 || !result.commit || !result.version || !result.distTag || result.markLatest === undefined) return [];
  return [`commit=${result.commit}`, `version=${result.version}`, `dist-tag=${result.distTag}`, `latest=${result.markLatest}`];
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error('✗ GITHUB_OUTPUT is not set: this script runs inside the release workflow.');
    process.exit(1);
  }
  const run = spawnRunner(root);
  const result = guard({ root, refType: process.env.GITHUB_REF_TYPE, branch: process.env.GITHUB_REF_NAME, run });
  const lines = outputLines(result);
  if (result.problems.length > 0 || lines.length === 0) {
    for (const problem of result.problems.length > 0 ? result.problems : ['The guard produced no output.']) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  appendFileSync(outputFile, `${lines.join('\n')}\n`);
  const subject = run('git', ['log', '-1', '--format=%h %s', result.commit!]).stdout.trim();
  console.log(`release-guard: releasing ${result.version} from ${subject} with dist-tag ${result.distTag}${result.markLatest ? ' (marked latest)' : ''}.`);
}
