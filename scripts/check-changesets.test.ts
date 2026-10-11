import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { frameworkPackages } from './packages.ts';
import { check, checkUpgrading, pendingBump, targetVersion, UPGRADING_ANCHORS } from './check-changesets.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directories: string[] = [];

/** A repository with nothing but this UPGRADING.md. */
function repositoryWith(upgrading: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'upgrading-'));
  directories.push(directory);
  writeFileSync(join(directory, 'UPGRADING.md'), upgrading);
  return directory;
}

const entry = (heading: string) => `#### ${heading}\n\n*Likelihood of impact: low.* What changed. The way back: none.\n`;

/** The page before the first release: a title and a paragraph, no section. */
const unreleased = '# Upgrading\n\nMarmeon has had no release yet, so there is nothing to upgrade from.\n';

/** The page once releases are out: 0.3.0 with a step of its own, 0.2.0 without. */
const released = (newest: string = entry('Low: a change of 0.3.0')) =>
  [
    '# Upgrading\n',
    'What changes for an app from one version to the next.\n',
    '## Upgrading to 0.3.0 from 0.2.0\n',
    newest,
    '### Background services\n',
    entry('Low: a change of a step of 0.3.0'),
    '## Upgrading to 0.2.0 from 0.1.0\n',
    entry('Medium: a change of 0.2.0'),
  ].join('\n');

const anchors = {
  '0.3.0': ['low-a-change-of-030', 'low-a-change-of-a-step-of-030'],
  '0.2.0': ['medium-a-change-of-020'],
} as const satisfies typeof UPGRADING_ANCHORS;

/** The problems found against those wanted — both in the message: Vitest shortens the lists in its own ("[ Array(1) ]"). */
function expectProblems(problems: readonly string[], wanted: readonly string[]): void {
  const list = (items: readonly string[]) => (items.length === 0 ? 'nothing' : items.join(' | '));
  expect(problems, `found: ${list(problems)} — wanted: ${list(wanted)}`).toEqual(wanted);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('checkUpgrading — before the first release', () => {
  it('passes the repository’s UPGRADING.md', () => {
    const problems = checkUpgrading(root, UPGRADING_ANCHORS, frameworkPackages(root)[0]?.manifest.version, pendingBump(root));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('asks for no entry while the page has no release section and the list is empty', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}), []);
  });

  it('names an entry that stands under no release', () => {
    expectProblems(checkUpgrading(repositoryWith(`${unreleased}\n${entry('Low: a change before any release')}`), {}), [
      'UPGRADING.md: #low-a-change-before-any-release stands under no release — an entry goes under its "## Upgrading to <version> from <version>"',
    ]);
  });

  it('still refuses a placeholder', () => {
    expectProblems(checkUpgrading(repositoryWith(`${unreleased}\n<!-- the entries of 0.2.0 -->\n`), {}), ['UPGRADING.md still has a placeholder or a comment']);
  });
});

describe('checkUpgrading — from the first release on', () => {
  it('passes every listed entry under its release — a step heading inside a release keeps the release as the section', () => {
    // The problems as the message too: Vitest shortens the list in its own ("[ Array(1) ]").
    const problems = checkUpgrading(repositoryWith(released()), anchors);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('switches on with the first release section: one the list does not know is named', () => {
    expectProblems(checkUpgrading(repositoryWith(released()), { '0.2.0': anchors['0.2.0'] }), [
      'UPGRADING.md has the section of 0.3.0, and scripts/check-changesets.ts lists none of its entries — add their anchors to UPGRADING_ANCHORS["0.3.0"]',
    ]);
  });

  it('names an entry that is missing, by its release', () => {
    expectProblems(checkUpgrading(repositoryWith(released(entry('Low: a change of 0.3.0, reworded'))), anchors), [
      'UPGRADING.md lacks an entry of 0.3.0: #low-a-change-of-030',
    ]);
  });

  it('names an entry that moved into another release', () => {
    const moved = released('').replace('## Upgrading to 0.2.0 from 0.1.0\n', `## Upgrading to 0.2.0 from 0.1.0\n\n${entry('Low: a change of 0.3.0')}`);
    expectProblems(checkUpgrading(repositoryWith(moved), anchors), ['UPGRADING.md: #low-a-change-of-030 (an entry of 0.3.0) is under 0.2.0']);
  });

  it('names a listed release whose section is gone', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), { '0.2.0': ['medium-a-change-of-020'] }), [
      'UPGRADING.md has no section "## Upgrading to 0.2.0 from …", which scripts/check-changesets.ts lists',
      'UPGRADING.md lacks an entry of 0.2.0: #medium-a-change-of-020',
    ]);
  });

  it('names an entry without its impact or its likelihood', () => {
    const vague = released().replace(entry('Medium: a change of 0.2.0'), '#### A change of 0.2.0\n\nWhat changed.\n');
    expectProblems(checkUpgrading(repositoryWith(vague), { ...anchors, '0.2.0': ['a-change-of-020'] }), [
      'UPGRADING.md: "#### A change of 0.2.0" — an entry starts with its impact (High:, Medium:, Low:)',
      'UPGRADING.md: #a-change-of-020 does not say its likelihood of impact',
    ]);
  });
});

/** A repository with this UPGRADING.md and one changeset per given bump. */
function repositoryWithChangesets(upgrading: string, bumps: readonly string[]): string {
  const directory = repositoryWith(upgrading);
  mkdirSync(join(directory, '.changeset'));
  bumps.forEach((bump, index) => writeFileSync(join(directory, '.changeset', `change-${index}.md`), `---\n'@marmeon/core': ${bump}\n---\n\nA change.\n`));
  return directory;
}

const section = (heading: string, body = entry('Low: a change of 0.2.0')) => `${unreleased}\n${heading}\n\n${body}`;

describe('checkUpgrading — the headings', () => {
  const wanted = (heading: string) => `UPGRADING.md: "${heading}" — a release's section is headed exactly "## Upgrading to <x.y.z> from <x.y.z>"`;

  it('refuses a section without its "from"', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## Upgrading to 0.2.0')), {}), [
      wanted('## Upgrading to 0.2.0'),
      'UPGRADING.md: #low-a-change-of-020 stands under no release — an entry goes under its "## Upgrading to <version> from <version>"',
    ]);
  });

  it('refuses a section one level too deep', () => {
    expectProblems(checkUpgrading(repositoryWith(section('### Upgrading to 0.2.0 from 0.1.0')), {}), [
      wanted('### Upgrading to 0.2.0 from 0.1.0'),
      'UPGRADING.md: #low-a-change-of-020 stands under no release — an entry goes under its "## Upgrading to <version> from <version>"',
    ]);
  });

  it('refuses a lower-case heading', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## upgrading to 0.2.0 from 0.1.0', '')), {}), [wanted('## upgrading to 0.2.0 from 0.1.0')]);
  });

  it('refuses a version that is no x.y.z', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## Upgrading to 0.2 from 0.1', '')), {}), [wanted('## Upgrading to 0.2 from 0.1')]);
  });

  it('keeps an ordinary step heading inside a release', () => {
    const page = section('## Upgrading to 0.2.0 from 0.1.0', `### Upgrading the session table\n\n${entry('Low: a change of 0.2.0')}`);
    expectProblems(checkUpgrading(repositoryWith(page), { '0.2.0': ['low-a-change-of-020'] }), []);
  });

  it('keeps the page title', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.1.0'), []);
  });
});

describe('checkUpgrading — bound to the version', () => {
  const page = section('## Upgrading to 0.2.0 from 0.1.0');
  const listed = { '0.2.0': ['low-a-change-of-020'] };

  it('refuses a section above the version the changesets make', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## Upgrading to 0.3.0 from 0.2.0')), { '0.3.0': listed['0.2.0'] }, '0.1.0', 'minor'), [
      'UPGRADING.md has a section for 0.3.0, but the packages are at 0.1.0 and the changesets make 0.2.0',
      'the changesets make 0.2.0, a breaking release — UPGRADING.md needs its section "## Upgrading to 0.2.0 from 0.1.0"',
    ]);
  });

  it('refuses a section above the version without a changeset', () => {
    expectProblems(checkUpgrading(repositoryWith(page), listed, '0.1.0'), ['UPGRADING.md has a section for 0.2.0, but the packages are at 0.1.0']);
  });

  it('refuses a section that does not go up', () => {
    const problems = checkUpgrading(repositoryWith(section('## Upgrading to 0.1.0 from 0.1.0')), { '0.1.0': listed['0.2.0'] });
    expectProblems(problems, ['UPGRADING.md: "## Upgrading to 0.1.0 from 0.1.0" — a release upgrades from a lower version to a higher one']);
  });

  it('needs the section of a pending minor', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.1.0', 'minor'), [
      'the changesets make 0.2.0, a breaking release — UPGRADING.md needs its section "## Upgrading to 0.2.0 from 0.1.0"',
    ]);
  });

  it('needs the section of a pending minor to start from the current version', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## Upgrading to 0.2.0 from 0.0.9')), listed, '0.1.0', 'minor'), [
      'UPGRADING.md: the section of 0.2.0 upgrades from 0.0.9, but the packages are at 0.1.0 — "## Upgrading to 0.2.0 from 0.1.0"',
    ]);
  });

  it('needs entries listed for the section of a pending minor', () => {
    expectProblems(checkUpgrading(repositoryWith(page), { '0.2.0': [] }, '0.1.0', 'minor'), [
      'the changesets make 0.2.0, a breaking release — scripts/check-changesets.ts lists none of its entries: UPGRADING_ANCHORS["0.2.0"]',
    ]);
  });

  it('passes a pending minor with its section and entries', () => {
    expectProblems(checkUpgrading(repositoryWith(page), listed, '0.1.0', 'minor'), []);
  });

  it('asks nothing of a pending patch', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.1.0', 'patch'), []);
  });

  it('asks nothing of a pending minor from 1.0 on', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '1.0.0', 'minor'), []);
  });

  it('needs the section of a pending major from 1.0 on', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '1.2.0', 'major'), [
      'the changesets make 2.0.0, a breaking release — UPGRADING.md needs its section "## Upgrading to 2.0.0 from 1.2.0"',
    ]);
  });
});

describe('prereleases', () => {
  it('refuses a prerelease version', () => {
    const problems = checkUpgrading(repositoryWith(unreleased), {}, '0.2.0-beta.0', 'minor');
    expectProblems(problems, ['the packages are at 0.2.0-beta.0 — prerelease versions are not supported by this check: the sections of UPGRADING.md cannot be bound to them']);
  });

  it('refuses Changesets pre mode', () => {
    const repository = repositoryWithChangesets(unreleased, []);
    writeFileSync(join(repository, '.changeset', 'pre.json'), '{}');
    expectProblems(checkUpgrading(repository, {}, '0.1.0'), [
      'the packages are at 0.1.0 in Changesets pre mode — prerelease versions are not supported by this check: the sections of UPGRADING.md cannot be bound to them',
    ]);
  });
});

describe('check', () => {
  it('hands the version and the pending bump to the upgrade guide check', () => {
    const repository = repositoryWithChangesets(unreleased, ['minor']);
    mkdirSync(join(repository, 'packages/core'), { recursive: true });
    writeFileSync(join(repository, 'packages/core/package.json'), JSON.stringify({ name: '@marmeon/core', version: '0.1.0' }));
    expect(check(repository)).toContain('the changesets make 0.2.0, a breaking release — UPGRADING.md needs its section "## Upgrading to 0.2.0 from 0.1.0"');
  });
});

describe('pendingBump and targetVersion', () => {
  it('finds the highest bump of the changesets', () => {
    expect(pendingBump(repositoryWithChangesets(unreleased, ['patch', 'minor', 'patch']))).toBe('minor');
    expect(pendingBump(repositoryWithChangesets(unreleased, ['patch']))).toBe('patch');
  });

  it('finds none without changesets', () => {
    expect(pendingBump(repositoryWith(unreleased))).toBeUndefined();
    expect(pendingBump(repositoryWithChangesets(unreleased, []))).toBeUndefined();
  });

  it('makes the version of a bump', () => {
    expect(targetVersion('0.1.4', 'minor')).toBe('0.2.0');
    expect(targetVersion('0.1.4', 'patch')).toBe('0.1.5');
    expect(targetVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(targetVersion('0.1.4', undefined)).toBe('0.1.4');
  });
});
