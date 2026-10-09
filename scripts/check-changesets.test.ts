import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUpgrading, UPGRADING_ANCHORS } from './check-changesets.ts';

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

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('checkUpgrading — before the first release', () => {
  it('passes the repository’s UPGRADING.md', () => {
    const problems = checkUpgrading(root);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('asks for no entry while the page has no release section and the list is empty', () => {
    expect(checkUpgrading(repositoryWith(unreleased), {})).toEqual([]);
  });

  it('names an entry that stands under no release', () => {
    expect(checkUpgrading(repositoryWith(`${unreleased}\n${entry('Low: a change before any release')}`), {})).toEqual([
      'UPGRADING.md: #low-a-change-before-any-release stands under no release — an entry goes under its "## Upgrading to <version> from <version>"',
    ]);
  });

  it('still refuses a placeholder', () => {
    expect(checkUpgrading(repositoryWith(`${unreleased}\n<!-- the entries of 0.2.0 -->\n`), {})).toEqual(['UPGRADING.md still has a placeholder or a comment']);
  });
});

describe('checkUpgrading — from the first release on', () => {
  it('passes every listed entry under its release — a step heading inside a release keeps the release as the section', () => {
    // The problems as the message too: Vitest shortens the list in its own ("[ Array(1) ]").
    const problems = checkUpgrading(repositoryWith(released()), anchors);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('switches on with the first release section: one the list does not know is named', () => {
    expect(checkUpgrading(repositoryWith(released()), { '0.2.0': anchors['0.2.0'] })).toEqual([
      'UPGRADING.md has the section of 0.3.0, and scripts/check-changesets.ts lists none of its entries — add their anchors to UPGRADING_ANCHORS["0.3.0"]',
    ]);
  });

  it('names an entry that is missing, by its release', () => {
    expect(checkUpgrading(repositoryWith(released(entry('Low: a change of 0.3.0, reworded'))), anchors)).toEqual([
      'UPGRADING.md lacks an entry of 0.3.0: #low-a-change-of-030',
    ]);
  });

  it('names an entry that moved into another release', () => {
    const moved = released('').replace('## Upgrading to 0.2.0 from 0.1.0\n', `## Upgrading to 0.2.0 from 0.1.0\n\n${entry('Low: a change of 0.3.0')}`);
    expect(checkUpgrading(repositoryWith(moved), anchors)).toEqual(['UPGRADING.md: #low-a-change-of-030 (an entry of 0.3.0) is under 0.2.0']);
  });

  it('names a listed release whose section is gone', () => {
    expect(checkUpgrading(repositoryWith(unreleased), { '0.2.0': ['medium-a-change-of-020'] })).toEqual([
      'UPGRADING.md has no section "## Upgrading to 0.2.0 from …", which scripts/check-changesets.ts lists',
      'UPGRADING.md lacks an entry of 0.2.0: #medium-a-change-of-020',
    ]);
  });

  it('names an entry without its impact or its likelihood', () => {
    const vague = released().replace(entry('Medium: a change of 0.2.0'), '#### A change of 0.2.0\n\nWhat changed.\n');
    expect(checkUpgrading(repositoryWith(vague), { ...anchors, '0.2.0': ['a-change-of-020'] })).toEqual([
      'UPGRADING.md: "#### A change of 0.2.0" — an entry starts with its impact (High:, Medium:, Low:)',
      'UPGRADING.md: #a-change-of-020 does not say its likelihood of impact',
    ]);
  });
});
