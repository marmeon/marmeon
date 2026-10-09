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

const anchors = {
  'Upgrading to 0.2.0': ['low-a-change-of-020'],
  'Ship-ready': ['low-a-ship-ready-change'],
  'Devtools and observability': ['low-a-devtools-hint'],
  'Background services': [],
} as const satisfies typeof UPGRADING_ANCHORS;

const guide = (newest: string = entry('Low: a change of 0.2.0')) =>
  [
    '# Upgrading\n',
    '## Upgrading to 0.2.0 from 0.1.0\n',
    newest,
    '## Upgrading to 0.1.0 from the development snapshots\n',
    '### Ship-ready: one version\n',
    entry('Low: a ship-ready change'),
    '### Devtools and observability\n',
    entry('Low: a devtools hint'),
    '### Background services\n',
  ].join('\n');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('checkUpgrading — every entry under its section', () => {
  it('passes the repository’s UPGRADING.md: every listed entry, each under its release or its step', () => {
    const problems = checkUpgrading(root);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('takes the release’s own heading as the section of an entry that stands under no step (0.2.0 has none)', () => {
    // The problems as the message too: Vitest shortens the list in its own ("[ Array(1) ]").
    const problems = checkUpgrading(repositoryWith(guide()), anchors);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('names an entry that is missing, by its section', () => {
    expect(checkUpgrading(repositoryWith(guide(entry('Low: a change of 0.2.0, reworded'))), anchors)).toEqual([
      'UPGRADING.md lacks an entry of "Upgrading to 0.2.0": #low-a-change-of-020',
    ]);
  });

  it('names an entry that moved into another section — a 0.2.0 entry under a step of 0.1.0', () => {
    const moved = guide('').replace('### Background services\n', `### Background services\n\n${entry('Low: a change of 0.2.0')}`);
    expect(checkUpgrading(repositoryWith(moved), anchors)).toEqual([
      'UPGRADING.md: #low-a-change-of-020 (an entry of "Upgrading to 0.2.0") is under "Background services", not "Upgrading to 0.2.0"',
    ]);
  });

  it('numbers the hints of the devtools step', () => {
    const missing = guide().replace(entry('Low: a devtools hint'), '');
    expect(checkUpgrading(repositoryWith(missing), anchors)).toEqual(['UPGRADING.md lacks the devtools hint 1: #low-a-devtools-hint']);
  });
});
