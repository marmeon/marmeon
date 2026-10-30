/**
 * `pnpm release:prepare` — turns the pull requests merged since the last tag into the next version: every published
 * `package.json`'s `version`, the same `## <version>` section on top of every `CHANGELOG.md` and, for a breaking release, the
 * heading of its `UPGRADING.md` section. It changes files only; the maintainer commits them as the release pull request.
 *
 *   pnpm release:prepare             # write the files and print the next steps
 *   pnpm release:prepare --dry-run   # print the version and the section, write nothing
 *   pnpm release:prepare --rc        # a release candidate, x.y.z-rc.N, of the version the labels ask for
 *   pnpm release:prepare --major     # from 0.x only: make 1.0.0 whatever the labels ask for (with --rc: 1.0.0-rc.1)
 *   pnpm release:prepare --replace   # the version the packages carry was staged and rejected: prepare the one after it (with --rc: the next candidate)
 *
 * It can run again for the same version as long as `v<version>` is not tagged: the section is made anew from the last tag to
 * `HEAD`, so a fix merged after the release pull request goes into a second, small one. A release is refused while a
 * deprecation names that version or an earlier one in "Removed in" — the version is settled first, so a candidate is refused for
 * what its release would be refused for. See CONTRIBUTING.md, "Pull requests and releases". Imports
 * nothing but `node:*` and the neighbouring scripts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './check-source.ts';
import { findDeprecations, removalIsAfter } from './deprecations.ts';
import { REPOSITORY } from './npm-trust.ts';
import { frameworkPackages } from './packages.ts';
import {
  type Bump,
  bumpFor,
  bumpVersion,
  CATEGORIES,
  compareVersions,
  formatReleaseBase,
  formatChangelog,
  isBreakingRelease,
  isPlainVersion,
  type Label,
  lineOf,
  maintenanceLine,
  MAIN,
  parseChangelog,
  parseReleaseBase,
  parseVersion,
  RELEASE_BASE,
  rcOf,
  releaseCommit,
  releaseOf,
  type Runner,
  spawnRunner,
  UNLABELLED,
  withRc,
} from './release-rules.ts';
import type { SourceFile } from './source-files.ts';

export interface Notes {
  /** The bullet lines (without their marker) per titled category. */
  readonly entries: Map<Label, string[]>;
  /** Pull requests GitHub could not sort into a category. */
  readonly unlabelled: string[];
  readonly contributors: string[];
  /** The whole `**Full Changelog**: …` line. */
  readonly fullChangelog?: string;
}

const NEW_CONTRIBUTORS = 'New Contributors';

/**
 * Reads the Markdown GitHub's `generate-notes` returns for the categories of `.github/release.yml`; anything else throws. Only the
 * comment line GitHub puts first is dropped: a pull request title may contain `<!--` or `-->` and must not delete lines around it.
 */
export function parseNotes(body: string): Notes {
  const entries = new Map<Label, string[]>();
  const unlabelled: string[] = [];
  const contributors: string[] = [];
  let fullChangelog: string | undefined;
  let target: string[] | undefined;
  let heading: string | undefined;
  for (const raw of body.replace(/^\s*<!--[^\n]*-->\s*\n/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const bullet = /^[*-] (.+)$/.exec(line);
    const section = /^(#{2,3}) (.+)$/.exec(line);
    if (section) {
      const [, hashes, title] = section as unknown as [string, string, string];
      heading = line;
      target = undefined;
      if (hashes === '##') {
        if (title === NEW_CONTRIBUTORS) target = contributors;
        else if (title !== "What's Changed") throw new Error(`Unexpected heading in the generated notes: "${line}".`);
      } else if (title === UNLABELLED) target = unlabelled;
      else {
        const category = CATEGORIES.find((candidate) => candidate.title === title);
        if (!category) throw new Error(`Unknown category in the generated notes: "${line}" — does .github/release.yml on the branch match scripts/release-rules.ts?`);
        const list: string[] = [];
        entries.set(category.label, list);
        target = list;
      }
    } else if (bullet) {
      if (!target) {
        throw new Error(`A pull request outside any category in the generated notes: "${line}"${heading ? ` (under "${heading}")` : ''} — is .github/release.yml pushed to the branch?`);
      }
      target.push(bullet[1]!);
    } else if (line.startsWith('**Full Changelog**:')) fullChangelog = line;
    else throw new Error(`Unexpected line in the generated notes: "${line}".`);
  }
  return { entries, unlabelled, contributors, fullChangelog };
}

/**
 * A pull request title is text: `<!--` in it would hide the rest of the changelog, so no raw `<` reaches the section. Inside a code
 * span (`<Form>`) it stays readable, unless the span holds a comment opener: a stray backtick may make the span a literal one.
 */
function escapeHtml(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 && !part.includes('<!--') ? part : part.replace(/</g, '&lt;')))
    .join('');
}

/** The Markdown under `## <version>`: the categories in `CATEGORIES` order, then the new contributors and the compare link. */
export function sectionBody(notes: Notes): string {
  const blocks: string[] = [];
  for (const category of CATEGORIES) {
    const lines = notes.entries.get(category.label);
    if (category.title !== undefined && lines && lines.length > 0) blocks.push(`### ${category.title}\n\n${lines.map((line) => `- ${escapeHtml(line)}`).join('\n')}`);
  }
  if (notes.contributors.length > 0) blocks.push(`### New contributors\n\n${notes.contributors.map((line) => `- ${escapeHtml(line)}`).join('\n')}`);
  if (notes.fullChangelog) blocks.push(notes.fullChangelog);
  return blocks.join('\n\n');
}

export interface PrepareOptions {
  readonly root: string;
  readonly run: Runner;
  readonly dryRun: boolean;
  /** Make a release candidate, `x.y.z-rc.N`, instead of the release. */
  readonly rc?: boolean;
  /** Make 1.0.0 from a 0.x release, whatever the labels ask for. */
  readonly major?: boolean;
  /** The untagged version the packages carry was staged and rejected: prepare the one after it, with its CHANGELOG section removed. */
  readonly replace?: boolean;
  /** The repository's files, read for the deprecations; defaults to what git lists in `root`. */
  readonly files?: () => Iterable<SourceFile>;
  readonly log: (line: string) => void;
}

export interface Prepared {
  readonly version: string;
  /** The last release (not a candidate) the version builds on. */
  readonly previous: string;
  /** The tag the notes start from: `previous`, or the last candidate when this is a further one. */
  readonly since: string;
  readonly bump: Bump;
  readonly section: string;
}

const UPGRADING_HEADING = /^## Upgrading to (\d+\.\d+\.\d+) from (\d+\.\d+\.\d+)[ \t]*$/gm;

/** `Title by @user in https://…/pull/12` → `#12 Title`; a line of another shape stays as it is. */
function pullRequest(line: string): string {
  const match = /^(.*) by @\S+ in \S*\/pull\/(\d+)$/.exec(line);
  // `--`, `<` and `>` in a title would end or open an HTML comment early.
  return (match ? `#${match[2]} ${match[1]}` : line).replace(/-{2,}/g, '-').replace(/</g, '&lt;').replace(/>/g, '');
}

/** Prepares the release of the pull requests merged since the last tag; throws an `Error` saying what to do when it must not. */
export function prepare({ root, run, dryRun, rc = false, major = false, replace = false, files = () => repositoryFiles(root), log }: PrepareOptions): Prepared {
  const git = (...args: string[]) => run('git', args);
  const fail = (message: string): never => {
    throw new Error(message);
  };

  if (git('status', '--porcelain').stdout.trim() !== '') fail('The working tree is not clean: commit or stash your changes first.');
  const branch = git('branch', '--show-current').stdout.trim();
  const branchLine = maintenanceLine(branch);
  if (branch !== MAIN && branchLine === undefined) fail(`Releases are prepared on main or on a maintenance branch such as 0.1.x, not on "${branch}".`);
  const fetched = git('fetch', 'origin', '--tags');
  if (fetched.status !== 0) fail(`git fetch origin --tags failed: ${fetched.stderr.trim()}`);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const remote = git('rev-parse', `origin/${branch}`);
  if (remote.status !== 0 || remote.stdout.trim() !== head) {
    fail(`HEAD is not origin/${branch}: pull or push first — the release notes are generated from the pushed branch.`);
  }

  if (replace && major) fail('--replace prepares the version after the rejected one; --major would pick another: use one of them.');
  if (major && branchLine !== undefined) fail(`--major makes 1.0.0 from main; ${branch} releases its own line only.`);
  const described = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', 'v*-rc.*');
  const previous = described.status === 0 ? described.stdout.trim().slice(1) : '';
  if (!parseVersion(previous) || rcOf(previous) !== undefined) {
    fail(`No release tag v<x.y.z> is reachable from ${branch}${described.stderr ? `: ${described.stderr.trim()}` : ''}.`);
  }
  if (major && !previous.startsWith('0.')) fail(`--major makes 1.0.0 from a 0.x release, not from ${previous}: from 1.0 on the labels decide.`);
  // The last tag of any kind: a candidate tagged since the release is what the next candidate (or the release) follows.
  const describedAny = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  const lastTag = describedAny.status === 0 ? describedAny.stdout.trim().slice(1) : previous;
  if (!parseVersion(lastTag)) fail(`The last tag "v${lastTag}" is not a v<x.y.z> or v<x.y.z-rc.N> version.`);
  // Candidates already tagged for a release above `previous`: the release they lead to is the target of this run.
  const taggedSeries = rcOf(lastTag) !== undefined && compareVersions(lastTag, previous) > 0 ? { target: releaseOf(lastTag), last: rcOf(lastTag)! } : undefined;
  if (rc && branchLine !== undefined) fail(`Release candidates are made on main: they go out under one dist-tag, and ${branch} would move it below main's.`);
  let since = rc ? lastTag : previous;

  const packages = frameworkPackages(root);
  const versions = new Set(packages.map((pkg) => pkg.manifest.version));
  if (versions.size !== 1) fail(`The packages do not share one version: ${[...versions].join(', ')}.`);
  const current = [...versions][0]!;
  if (!parseVersion(current)) fail(`The packages' version "${current}" is not an x.y.z or x.y.z-rc.N version.`);
  const order = compareVersions(current, lastTag);
  if (order < 0) fail(`The packages are at ${current}, below the last tag v${lastTag}.`);
  if (order > 0) {
    const tagged = git('ls-remote', '--tags', 'origin', `refs/tags/v${current}`);
    if (tagged.status !== 0) fail(`Could not ask origin for the tag v${current}: ${tagged.stderr.trim()}`);
    if (tagged.stdout.trim() !== '') fail(`v${current} is tagged on origin, but ${branch} does not reach it: git fetch origin --tags, or merge the branch that released it.`);
  }

  if (replace) {
    if (order <= 0) fail(`Nothing to replace: the packages are at ${current}, which is tagged (v${lastTag} is the last tag). --replace is for a version that was staged and rejected before it got its tag.`);
    if (rc && rcOf(current) === undefined) fail(`--replace --rc replaces a candidate, but the packages carry the release ${current}: leave out --rc to replace the release.`);
    if (!rc && rcOf(current) !== undefined) fail(`The packages carry the candidate ${current}: use --replace --rc to replace it.`);
  }
  // A rejected candidate is not tagged, so the series cannot be read from the tags: it is the one the packages carry.
  const series = replace ? (rc ? { target: releaseOf(current), last: rcOf(current)! } : undefined) : taggedSeries;

  const generate = (tag: string): Notes => {
    const result = run('gh', [
      'api', '--method', 'POST', `repos/${REPOSITORY}/releases/generate-notes`,
      '-f', `tag_name=v${tag}`, '-f', `target_commitish=${branch}`, '-f', `previous_tag_name=v${since}`, '--jq', '.body',
    ]);
    if (result.status !== 0) fail(`gh api generate-notes failed: ${result.stderr.trim()}`);
    return parseNotes(result.stdout);
  };
  /** Refuses what the notes cannot ship; returns the bump they ask for. */
  const judge = (candidate: Notes) => {
    if (candidate.unlabelled.length > 0) {
      fail(`Label these pull requests (breaking, feature, fix, docs or internal) and run this again:\n${candidate.unlabelled.map((line) => `  - ${line}`).join('\n')}`);
    }
    const found = candidate.entries.get('breaking') ?? [];
    if (![...candidate.entries.values()].some((lines) => lines.length > 0)) fail(`Nothing to release since v${since}: no merged pull request carries a release label.`);
    if (branchLine !== undefined && found.length > 0) {
      fail(`${branch} releases ${branchLine} fixes only, but these pull requests are breaking:\n${found.map((line) => `  - ${line}`).join('\n')}`);
    }
    return bumpFor(previous, { breaking: found.length > 0, feature: (candidate.entries.get('feature') ?? []).length > 0 });
  };
  const guess = bumpVersion(previous, 'patch');
  let notes = generate(guess);
  const asked = judge(notes);
  // What the labels ask for, unless --major or the candidates already tagged settle it: those stay on their release.
  const labelled = bumpVersion(previous, asked);
  // Candidates that cannot lead to what --major or the labels now ask for are replaced: the version starts over, their sections stay.
  const outgrown = series !== undefined && (major ? series.target !== '1.0.0' : compareVersions(labelled, series.target) > 0);
  const live = outgrown ? undefined : series;
  // A rejected release can never be staged again: the target is at least the patch after it.
  const afterRejected = replace && !rc && compareVersions(labelled, bumpVersion(current, 'patch')) < 0 ? bumpVersion(current, 'patch') : labelled;
  let target = major ? '1.0.0' : live ? live.target : afterRejected;
  // Packages above the last tag were prepared (or replaced) already: a plain run never goes back below them.
  const untagged = order > 0;
  // Within a line only: a release prepared too high by a mislabelled pull request must come down when the label is fixed. (A
  // replacement that labels pushed to a new line and that was then relabelled down returns to the old line's version.)
  if (untagged && !rc && !major && lineOf(target) === lineOf(releaseOf(current)) && compareVersions(target, releaseOf(current)) < 0) target = releaseOf(current);
  const carried = untagged && rcOf(current) !== undefined && releaseOf(current) === target ? rcOf(current)! : 1;
  const version = rc ? withRc(target, Math.max(live ? live.last + 1 : 1, carried)) : target;
  // The first candidate of a release has the notes since the release, not since a replaced candidate; so has the candidate that
  // replaces a rejected one of another release than the tagged candidates lead to.
  const restarted = rc && since !== previous && (!live || (replace && taggedSeries?.target !== live.target));
  if (restarted) since = previous;
  const bump: Bump = target.split('.')[0] !== previous.split('.')[0] ? 'major' : target.split('.')[1] !== previous.split('.')[1] ? 'minor' : 'patch';
  if (branchLine !== undefined && lineOf(version) !== branchLine) fail(`${version} is not a ${branchLine} version: ${branch} releases its own line only.`);
  // The compare link in the notes names the tag the release will get; a pull request labelled in between must not change the answer.
  if (version !== guess || restarted) {
    notes = generate(version);
    if (judge(notes) !== asked) fail('The labels changed while the notes were generated: run this again.');
  }
  const due = findDeprecations(files()).filter((found) => found.removeIn !== undefined && !removalIsAfter(found.removeIn, version));
  if (due.length > 0) {
    fail(
      `These deprecations are due in ${version}:\n${due.map((found) => `  - ${found.path}:${found.line}: ${found.text}`).join('\n')}\n` +
        'Remove them (and their deprecated() calls) with an entry in the upgrade guide, or move their "Removed in" to the next breaking release.',
    );
  }
  const breaking = notes.entries.get('breaking') ?? [];
  const features = notes.entries.get('feature') ?? [];
  if (git('tag', '--list', `v${version}`).stdout.trim() !== '') {
    fail(`v${version} is already tagged (a maintenance release of that line?): git fetch origin --tags, merge or rebase the branch that released it, then run this again.`);
  }
  const body = sectionBody(notes);

  // A candidate gets no upgrade guide heading: its release does.
  const breakingRelease = isBreakingRelease(version);
  const upgradingFile = join(root, 'UPGRADING.md');
  const upgrading = existsSync(upgradingFile) ? readFileSync(upgradingFile, 'utf8') : undefined;
  let hasUpgradingSection = false;
  let upgradingBase = upgrading;
  let renamed: string | undefined;
  for (const match of upgrading?.matchAll(UPGRADING_HEADING) ?? []) {
    if (match[1] === releaseOf(version)) hasUpgradingSection = true;
    else if (replace && match[1] === releaseOf(current)) {
      // The rejected release never shipped: its guide section moves to the version that replaces it.
      upgradingBase = upgrading!.replace(match[0], `## Upgrading to ${releaseOf(version)} from ${match[2]}`);
      renamed = match[1];
      hasUpgradingSection = true;
    } else if (compareVersions(match[1]!, previous) > 0) {
      fail(`UPGRADING.md has "${match[0]}", but this preparation makes ${version}: move its entries into the section of ${version} by hand, then delete it.`);
    }
  }

  const changelogs = packages.map((pkg) => {
    const file = join(pkg.dir, 'CHANGELOG.md');
    return { pkg, file, changelog: parseChangelog(existsSync(file) ? readFileSync(file, 'utf8') : `# ${pkg.name}\n\n`) };
  });
  const existing = changelogs.map(({ changelog }) => changelog.sections.find((section) => section.version === version)?.body.trim());
  const baseFile = join(root, RELEASE_BASE);
  const baseText = formatReleaseBase(version, head);
  if (existing.every((text) => text === body)) {
    // The same notes: only a base that no merged release commit has used yet is worth a new release pull request.
    const recorded = existsSync(baseFile) ? parseReleaseBase(readFileSync(baseFile, 'utf8')) : undefined;
    let ready = false;
    try {
      ready = recorded?.version === version && git('rev-parse', `${releaseCommit(run)}^1`).stdout.trim() === recorded.commit;
    } catch {
      // No release commit yet: nothing is ready.
    }
    if (ready) fail(`Nothing new since the last preparation of ${version} — the release commit on ${branch} is ready: start the Release workflow.`);
  }

  const unreachable =
    branch === MAIN
      ? git('tag', '--list', 'v[0-9]*', '--no-merged', 'HEAD').stdout.split('\n').map((tag) => tag.trim()).filter((tag) => isPlainVersion(tag.slice(1)))
      : [];

  const results = changelogs.map(({ pkg, file, changelog }) => {
    const sections = changelog.sections.filter((section) => compareVersions(section.version, lastTag) <= 0);
    const ending = changelog.sections[0]?.ending ?? '\n';
    for (const tag of unreachable) {
      if (sections.some((section) => section.version === tag.slice(1))) continue;
      const shown = git('show', `${tag}:packages/${pkg.short}/CHANGELOG.md`);
      const found = shown.status === 0 ? parseChangelog(shown.stdout).sections.find((section) => section.version === tag.slice(1)) : undefined;
      if (found) sections.push(found);
    }
    sections.push({ version, ending, body: `${ending}${body}${ending}` });
    sections.sort((a, b) => compareVersions(b.version, a.version));
    const normalised = sections.map((section, index) =>
      index < sections.length - 1 && !/\n\r?\n$/.test(section.body) ? { ...section, body: `${section.body.replace(/\s*$/, '')}${ending}${ending}` } : section,
    );
    return { pkg, file, text: formatChangelog({ title: changelog.title, sections: normalised }) };
  });

  let upgradingText: string | undefined = upgradingBase !== upgrading ? upgradingBase : undefined;
  if (breakingRelease && !hasUpgradingSection) {
    const placeholder =
      breaking.length > 0
        ? `<!-- One entry per breaking pull request: ${breaking.map(pullRequest).join(', ')} — then list their anchors in UPGRADING_ANCHORS of scripts/check-release.ts. -->`
        : `<!-- No pull request since v${previous} is labelled breaking. Write the entries an app needs to upgrade (impact, before → after, the way back) — then list their anchors in UPGRADING_ANCHORS of scripts/check-release.ts. -->`;
    const section = `## Upgrading to ${version} from ${previous}\n\n${placeholder}\n\n`;
    const text = upgradingBase ?? '# Upgrading\n\n';
    const first = text.search(/^## Upgrading to /m);
    upgradingText = first === -1 ? `${text.replace(/\s*$/, '\n')}\n${section.trimEnd()}\n` : `${text.slice(0, first)}${section}${text.slice(first)}`;
  }

  const why =
    bump === 'major' && breaking.length === 0
      ? 'a major release, and no merged pull request is breaking'
      : breaking.length > 0
        ? `breaking: ${breaking.map(pullRequest).join(', ')}`
        : features.length > 0
          ? 'no breaking pull request'
          : 'fixes and documentation only';
  if (outgrown) {
    log(`The candidates since v${previous} (up to v${lastTag}) were for ${series!.target}; ${major ? '--major' : 'the labels'} ask for ${target}, so they are replaced: their changelog sections stay.`);
  }
  if (replace) log(`${current} was staged and rejected, so ${version} replaces it: its changelog sections are dropped.`);
  log(`Version ${version} (${bump}; ${why}), from v${previous}${since !== previous ? `, notes since the candidate v${since}` : ''}.`);
  log(`\n## ${version}\n\n${body}\n`);
  if (dryRun) {
    log('Dry run: nothing written.');
    return { version, previous, since, bump, section: body };
  }

  if (version !== current) {
    for (const { pkg } of changelogs) {
      const file = join(pkg.dir, 'package.json');
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
    }
  }
  for (const { file, text } of results) writeFileSync(file, text);
  mkdirSync(dirname(baseFile), { recursive: true });
  writeFileSync(baseFile, baseText);
  if (upgradingText !== undefined) writeFileSync(upgradingFile, upgradingText);
  if (renamed !== undefined) {
    log(`The heading of ${renamed} in UPGRADING.md is now ${releaseOf(version)}: rename UPGRADING_ANCHORS["${renamed}"] in scripts/check-release.ts to "${releaseOf(version)}".`);
  }
  log(`Wrote ${version} to ${packages.length} package.json files and CHANGELOGs${upgradingText !== undefined ? ' and the heading in UPGRADING.md' : ''}.`);
  if (upgradingText !== undefined && renamed === undefined) {
    log(`Replace the placeholder under it with ${breaking.length > 0 ? 'one entry per breaking pull request' : 'the entries an app needs'} and list their anchors in UPGRADING_ANCHORS of scripts/check-release.ts.`);
  }
  log(
    [
      ...(replace ? [`First reject the packages of ${current} that were staged on npmjs.com, if that is not done yet: a staged version can never be staged again.`] : []),
      `Recorded ${head} in ${RELEASE_BASE}: the release pull request must be merged before anything else lands on ${branch}, or run this again.`,
      `Next (a new release pull request; it carries the label internal, so it is no line of the notes itself):`,
      `  git switch -c release-${version}`,
      '  git add -A',
      `  git commit -m "Release ${version}"`,
      '  pnpm run ci',
      `  git push -u origin release-${version}`,
      `  gh pr create --base ${branch} --title "Release ${version}" --label internal --body "Release ${version}"`,
      `Updating an open release pull request instead: git switch -C release-${version}, git add -A, git commit, pnpm run ci, then`,
      `  git push --force-with-lease -u origin release-${version}   # no gh pr create`,
      'When the version changed since the open pull request (for example 0.1.3 to 0.2.0), close the old release pull request and open a new one.',
    ].join('\n'),
  );
  return { version, previous, since, bump, section: body };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    prepare({
      root,
      run: spawnRunner(root),
      dryRun: process.argv.includes('--dry-run'),
      rc: process.argv.includes('--rc'),
      major: process.argv.includes('--major'),
      replace: process.argv.includes('--replace'),
      log: (line) => console.log(line),
    });
  } catch (error) {
    console.error(`release-prepare: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
