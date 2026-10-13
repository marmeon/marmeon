import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { frameworkPackages } from './packages.ts';
import { check, checkLabelWorkflow, checkReleaseConfig, checkUpgrading, checkWorkflow, pendingBump, runScripts, targetVersion, UPGRADING_ANCHORS } from './check-changesets.ts';

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

describe('checkWorkflow — the release run', () => {
  const real = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const draft = /gh release create .*--draft.*/.exec(real)![0];
  /** Where the release job starts: everything before it is the workflow's top and the staging job. */
  const cut = real.indexOf('\n  release:\n');

  /** A repository with this release.yml and the real package.json (or this one). */
  function repositoryWithWorkflow(workflow: string, packageJson: string = readFileSync(join(root, 'package.json'), 'utf8')): string {
    const directory = repositoryWith(unreleased);
    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(join(directory, '.github/workflows/release.yml'), workflow);
    writeFileSync(join(directory, 'package.json'), packageJson);
    return directory;
  }

  /** The real workflow with `from` replaced — a mutation that did not change anything is a broken test, not a pass. */
  function mutated(from: string | RegExp, to: string, part: 'file' | 'stage' | 'release' = 'file'): string {
    const [start, end] = part === 'file' ? [0, real.length] : part === 'stage' ? [0, cut] : [cut, real.length];
    const result = real.slice(0, start) + real.slice(start, end).replace(from, to) + real.slice(end);
    expect(result, `the mutation of ${String(from)} changed nothing`).not.toBe(real);
    return result;
  }
  const problemsOf = (workflow: string) => checkWorkflow(repositoryWithWorkflow(workflow)).join('\n');

  /** The real workflow's steps by their first line, to move or drop them. */
  const step = (first: string) => {
    const start = real.indexOf(first);
    expect(start, `no step starts with ${first}`).toBeGreaterThanOrEqual(0);
    const to = [real.indexOf('\n      # ', start + 1), real.indexOf('\n      - ', start + 1), real.indexOf('\n\n  release:', start + 1)].filter((index) => index > 0).sort((a, b) => a - b)[0] ?? real.length;
    return real.slice(start, to + 1);
  };
  const guardStep = '      - id: guard\n        run: node scripts/release-guard.ts\n';
  const installStep = '      - run: pnpm install --frozen-lockfile\n';
  const stagingStep = step('      - name: stage the packages');
  const tagStep = step('      - name: tag the release commit');
  const draftStep = step('      - name: draft the GitHub release');

  it('passes the repository’s workflow', () => {
    expectProblems(checkWorkflow(repositoryWithWorkflow(real)), []);
  });

  describe('the draft', () => {
    it('refuses a release that is not a draft', () => {
      const line = draft.replace(' --draft', '');
      expectProblems(checkWorkflow(repositoryWithWorkflow(real.replace(draft, line))), [
        `release.yml: "${line.trim()}" creates a public GitHub Release — only a draft (--draft): the maintainer publishes it after approving on npm`,
        'release.yml: the job "release" drafts the GitHub release (gh release create … --draft)',
      ]);
    });

    it('refuses a release whose command continues on the next line without the flag', () => {
      const split = real.replace(draft, 'gh release create "v$VERSION" \\\n            --verify-tag');
      expect(problemsOf(split)).toContain('creates a public GitHub Release');
    });

    it('refuses --draft=false, also as a second flag', () => {
      expect(problemsOf(real.replace(draft, draft.replace(' --draft', ' --draft=false')))).toContain('creates a public GitHub Release');
      expect(problemsOf(real.replace(draft, draft.replace(' --draft', ' --draft --draft=false')))).toContain('creates a public GitHub Release');
    });

    it('refuses gh release edit --draft=false, gh api and a release action', () => {
      expect(problemsOf(`${real}          gh release edit "v$VERSION" --draft=false\n`)).toContain('publishes a GitHub Release');
      expect(problemsOf(`${real}          gh api repos/x/y/releases -f draft=false\n`)).toContain('calls gh api');
      expect(problemsOf(`${real}          gh api user\n`)).toContain('calls gh api');
      expect(problemsOf(`${real}      - uses: softprops/action-gh-release@v2\n`)).toContain('a release action');
    });

    it('lets only the release job tag and draft', () => {
      const withDraft = real.replace(draftStep, '').replace(stagingStep, `${stagingStep}${draftStep}`);
      expect(problemsOf(withDraft)).toContain('the job "stage" tags or drafts the release');
      const withTag = real.replace(tagStep, '').replace(stagingStep, `${stagingStep}${tagStep}`);
      expect(problemsOf(withTag)).toContain('the job "stage" tags or drafts the release');
    });

    it('wants the tag first, then the draft', () => {
      const swapped = real.replace(tagStep, '').replace(draftStep, `${draftStep}${tagStep}`);
      expect(problemsOf(swapped)).toContain('tags the release commit, then drafts');
      expect(problemsOf(real.replace(draftStep, ''))).toContain('tags the release commit, then drafts');
    });

    it('wants --verify-tag, no --target and the staging job’s latest flag', () => {
      expect(problemsOf(mutated(' --verify-tag', ''))).toContain('drafts with --verify-tag and without --target');
      expect(problemsOf(mutated(' --verify-tag', ' --verify-tag --target main'))).toContain('drafts with --verify-tag and without --target');
      expect(problemsOf(mutated(' --latest="$LATEST"', ''))).toContain('--latest="$LATEST"');
      expect(problemsOf(mutated('LATEST: ${{ needs.stage.outputs.latest }}', 'LATEST: true'))).toContain('--latest="$LATEST"');
    });
  });

  describe('the trigger and the whole file', () => {
    it('refuses every trigger but workflow_dispatch', () => {
      expect(problemsOf(mutated('on:\n  workflow_dispatch:\n', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n'))).toContain('"on:" holds push, workflow_dispatch');
      expect(problemsOf(mutated('on:\n  workflow_dispatch:\n', 'on:\n  pull_request_target:\n'))).toContain('"on:" holds pull_request_target');
      expect(problemsOf(mutated('on:\n  workflow_dispatch:\n', 'on: push\n'))).toContain('"on:" holds no block of events');
      expect(problemsOf(mutated('on:\n  workflow_dispatch:\n', 'on: [push, workflow_dispatch]\n'))).toContain('"on:" holds no block of events');
    });

    it('refuses a secret anywhere', () => {
      expect(problemsOf(mutated('LATEST: ${{ needs.stage.outputs.latest }}', 'LATEST: ${{ needs.stage.outputs.latest }}\n          X: ${{ secrets.NPM_TOKEN }}'))).toContain('a secret');
      expect(problemsOf(mutated('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'))).toContain('a secret');
    });

    it('refuses an expression inside a run script, inline or in a block', () => {
      expect(problemsOf(mutated('run: node scripts/release-guard.ts', 'run: echo ${{ github.ref_name }}'))).toContain('an expression inside a run script');
      expect(problemsOf(mutated('test "$(git rev-parse HEAD)" = "$COMMIT"', 'echo "${{ github.ref_name }}"', 'release'))).toContain('an expression inside a run script');
    });

    it('refuses a push of anything but the tag, however the command is chained', () => {
      const push = 'push origin "refs/tags/v$VERSION"';
      for (const to of ['push origin --tags', 'push origin main', `${push} --mirror`, `${push} && git push origin main`, `${push}; git push origin main`, `${push} || git push --all`]) {
        expect(problemsOf(mutated(push, to)), to).toContain('a push is only the');
      }
      expect(problemsOf(mutated(push, `${push}\n          echo x | git push origin main`))).toContain('a push is only the');
    });

    it('refuses a cache in either job', () => {
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          cache: pnpm', 'stage'))).toContain('a cache');
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          cache: pnpm', 'release'))).toContain('a cache');
      expect(problemsOf(mutated(installStep, `      - uses: actions/cache@v4\n${installStep}`))).toContain('a cache');
    });

    it('refuses defaults: and shell:', () => {
      expect(problemsOf(mutated('\njobs:\n', '\ndefaults:\n  run:\n    shell: sh\n\njobs:\n'))).toContain('"defaults:" or "shell:"');
      expect(problemsOf(mutated(installStep, '      - run: pnpm install --frozen-lockfile\n        shell: bash\n'))).toContain('"defaults:" or "shell:"');
    });

    it('wants a third-party action pinned by its SHA, an action of actions/* may stay on a tag', () => {
      expect(problemsOf(mutated(/pnpm\/action-setup@[0-9a-f]{40}/, 'pnpm/action-setup@v6.1.0'))).toContain('is not pinned to a commit');
      expect(problemsOf(mutated(/pnpm\/action-setup@[0-9a-f]{40}/, 'pnpm/action-setup@main'))).toContain('is not pinned to a commit');
    });

    it('refuses a write permission but contents and id-token', () => {
      expect(problemsOf(mutated('      contents: write', '      contents: write\n      pull-requests: write'))).toContain('"pull-requests: write"');
      expect(problemsOf(mutated('      id-token: write', '      id-token: write\n      packages: write'))).toContain('"packages: write"');
    });

    it('lets only the two known jobs write: contents in the job after the staging, id-token in the staging job', () => {
      expect(problemsOf(mutated('      contents: read\n', '      contents: write\n', 'stage'))).toContain('the job "stage" asks for "contents: write"');
      expect(problemsOf(`${real}\n  third:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: echo\n`)).toContain('the job "third" asks for "contents: write"');
      expect(problemsOf(`${real}\n  third:\n    runs-on: ubuntu-latest\n    permissions:\n      pull-requests: write\n    steps:\n      - run: echo\n`)).toContain('the job "third" asks for "pull-requests: write"');
      expect(problemsOf(mutated('      contents: write', '      contents: write\n      id-token: write'))).toContain('the job "release" has "id-token: write" but stages nothing');
      expect(problemsOf(mutated('      id-token: write', '', 'stage'))).toContain('without "id-token: write"');
    });

    it('keeps the default read-only', () => {
      expect(problemsOf(mutated('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'))).toContain('default "permissions:"');
    });

    it('wants the job after the staging to depend on it', () => {
      expect(problemsOf(mutated('    needs: stage\n', ''))).toContain('0 jobs run after the staging job');
      expect(problemsOf(mutated('    needs: stage\n', ''))).toContain('github.token without a release job');
    });

    it('wants exactly one staging job, on a GitHub-hosted runner, after pack:check, with the script of pnpm stage publish', () => {
      expect(problemsOf(`${real}\n  again:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run release:stage\n`)).toContain('2 jobs stage the packages');
      expect(problemsOf(mutated('    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n', 'stage'))).toContain('must run on a GitHub-hosted runner');
      expect(problemsOf(mutated('pnpm run ci --only build,pack:check,check-changesets', 'pnpm run ci --only build'))).toContain('runs pack:check before it stages');
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      manifest.scripts['release:stage'] = 'pnpm publish -r';
      expect(checkWorkflow(repositoryWithWorkflow(real, JSON.stringify(manifest))).join('\n')).toContain('"release:stage" is');
    });

    it('refuses npm publish, a plain pnpm publish and a token', () => {
      expect(problemsOf(mutated('pnpm run release:stage', 'npm publish && pnpm run release:stage'))).toContain('"npm publish"');
      expect(problemsOf(mutated('pnpm run release:stage', 'pnpm publish -r && pnpm run release:stage'))).toContain('a plain "pnpm publish"');
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          registry-url: https://registry.npmjs.org'))).toContain('registry-url');
    });

    it('refuses a dist-tag in the release:stage script — it would override the guard’s', () => {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      manifest.scripts['release:stage'] += ' --tag next';
      expect(checkWorkflow(repositoryWithWorkflow(real, JSON.stringify(manifest))).join('\n')).toContain('"release:stage" sets --tag');
    });

    it('refuses an if: or continue-on-error: on a step or on a job', () => {
      expect(problemsOf(mutated('      - id: guard\n', '      - id: guard\n        if: false\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('      - id: guard\n', '      - id: guard\n        continue-on-error: true\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('    timeout-minutes: 30\n', '    timeout-minutes: 30\n    if: github.ref == \'refs/heads/main\'\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    if: always()\n'))).toContain('"if:" or "continue-on-error:"');
    });

    it('wants every checkout without persisted credentials', () => {
      expect(problemsOf(mutated(/ {10}persist-credentials: false.*\n/, '', 'stage'))).toContain('the job "stage" checks out without "persist-credentials: false"');
      expect(problemsOf(mutated(/ {10}persist-credentials: false.*\n/, '', 'release'))).toContain('the job "release" checks out without "persist-credentials: false"');
    });
  });

  describe('the staging job: the guard and the release commit', () => {
    it('wants the guard step', () => {
      expect(problemsOf(mutated(guardStep, ''))).toContain('has no step "node scripts/release-guard.ts" with the id "guard"');
      expect(problemsOf(mutated(guardStep, '      - run: node scripts/release-guard.ts\n'))).toContain('has no step "node scripts/release-guard.ts" with the id "guard"');
      expect(problemsOf(mutated(guardStep, '      - id: guard\n        run: node scripts/release-guard.ts --force\n'))).toContain('has no step "node scripts/release-guard.ts"');
    });

    it('refuses the guard only in a comment', () => {
      expect(problemsOf(mutated(guardStep, '      # - id: guard\n      #   run: node scripts/release-guard.ts\n'))).toContain('has no step "node scripts/release-guard.ts"');
    });

    it('refuses the guard in another job', () => {
      expect(problemsOf(`${mutated(guardStep, '')}\n  other:\n    runs-on: ubuntu-latest\n    steps:\n${guardStep}`)).toContain('has no step "node scripts/release-guard.ts"');
    });

    it('wants the guard before the install, the checks and the staging', () => {
      expect(problemsOf(mutated(guardStep, '').replace(installStep, `${installStep}${guardStep}`))).toContain('pnpm install must come after the guard');
      expect(problemsOf(mutated(guardStep, '').replace(stagingStep, `${stagingStep}${guardStep}`))).toContain('pnpm install must come after the guard');
    });

    it('wants staging after pack:check', () => {
      const check = step('      - run: pnpm run ci --only');
      expect(problemsOf(real.replace(check, '').replace(stagingStep, `${stagingStep}${check}`))).toContain('staging must come after pack:check');
      expect(problemsOf(real.replace(check, ''))).toContain('pack:check must come after pnpm install');
    });

    it('refuses a script before the guard', () => {
      expect(problemsOf(mutated(guardStep, `      - run: node scripts/other.ts\n${guardStep}`))).toContain('runs a script before the guard');
    });

    it('refuses a checkout, a switch or a reset after the guard', () => {
      const commands = ['git checkout main', 'git switch main', 'git reset --hard origin/main', 'git -C . checkout main', 'git restore .', 'git pull', 'git merge origin/main', 'git worktree add ../x main', 'git stash', 'git read-tree HEAD', 'git apply x.patch', 'git am x.patch'];
      for (const command of commands) {
        expect(problemsOf(mutated(installStep, `      - run: ${command}\n${installStep}`)), command).toContain('checks out or moves the tree after the guard');
      }
      expect(problemsOf(mutated(installStep, `      - uses: actions/checkout@v5\n${installStep}`))).toContain('checks out or moves the tree after the guard');
      expect(problemsOf(mutated(installStep, `      - run: |\n          echo hi\n          git checkout main\n${installStep}`))).toContain('checks out or moves the tree after the guard');
    });

    it('allows only run steps after the guard', () => {
      expect(problemsOf(mutated(installStep, `      - uses: actions/setup-node@v5\n${installStep}`))).toContain('uses an action after the guard');
    });

    it('wants the checkout with the whole history', () => {
      expect(problemsOf(mutated(/ {10}fetch-depth: 0.*\n/, ''))).toContain('"fetch-depth: 0"');
      expect(problemsOf(mutated(/ {10}fetch-depth: 0.*\n/, '          fetch-depth: 1\n'))).toContain('"fetch-depth: 0"');
    });

    it('wants the staging step exactly: HEAD is the release commit, the tree is clean, the guard’s dist-tag', () => {
      const wanted = 'stages with exactly';
      expect(problemsOf(mutated('          test "$(git rev-parse HEAD)" = "$COMMIT"\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          status=$(git status --porcelain)\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          test -z "$status"\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          test -z "$status"\n', '          test -z "$(git status --porcelain)"\n', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(' --tag "$DIST_TAG"', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(' --no-git-checks', ' --no-git-checks --force', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('DIST_TAG: ${{ steps.guard.outputs.dist-tag }}', 'DIST_TAG: latest'))).toContain('takes DIST_TAG and COMMIT');
      expect(problemsOf(mutated('COMMIT: ${{ steps.guard.outputs.commit }}', 'COMMIT: ${{ github.sha }}'))).toContain('takes DIST_TAG and COMMIT');
    });

    it('wants the guard’s commit, version and latest as outputs', () => {
      for (const key of ['commit', 'version', 'latest']) {
        expect(problemsOf(mutated(`      ${key}: \${{ steps.guard.outputs.${key} }}\n`, '', 'stage')), key).toContain(`hands the guard's "${key}" on`);
      }
    });
  });

  describe('the release job', () => {
    it('starts with the release commit’s checkout', () => {
      expect(problemsOf(mutated('          ref: ${{ needs.stage.outputs.commit }}\n', '', 'release'))).toContain('starts by checking out the release commit');
      expect(problemsOf(mutated('ref: ${{ needs.stage.outputs.commit }}', 'ref: main', 'release'))).toContain('starts by checking out the release commit');
      expect(problemsOf(mutated('ref: ${{ needs.stage.outputs.commit }}', 'ref: ${{ github.sha }}', 'release'))).toContain('starts by checking out the release commit');
    });

    it('installs nothing and uses nothing but actions/* — setup-node without a cache', () => {
      const setup = '      - uses: actions/setup-node@v5\n        with:\n          node-version-file: .nvmrc\n';
      const afterSetup = (step: string) => mutated(setup, `${setup}${step}`, 'release');
      expect(problemsOf(afterSetup('      - run: pnpm install --frozen-lockfile\n'))).toContain('installs or runs a package');
      expect(problemsOf(afterSetup('      - run: npx something\n'))).toContain('installs or runs a package');
      expect(problemsOf(afterSetup('      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413\n'))).toContain('the job "release" uses pnpm/action-setup');
      expect(problemsOf(afterSetup('      - uses: actions/cache@v4\n'))).toContain('the job "release" uses actions/cache@v4');
      expect(problemsOf(afterSetup('      - uses: actions/checkout@v5\n        with:\n          persist-credentials: false\n'))).toContain('the job "release" uses actions/checkout@v5');
    });

    it('has exactly four steps: the checkout, setup-node, the tag, the draft', () => {
      const wanted = 'has exactly four steps';
      expect(problemsOf(mutated(tagStep, `      - run: node scripts/build.ts\n${tagStep}`))).toContain(wanted);
      expect(problemsOf(`${real}      - run: node scripts/build.ts\n`)).toContain(wanted);
      expect(problemsOf(mutated(tagStep, `${tagStep}      - run: echo hi\n`))).toContain(wanted);
    });

    it('refuses a move of the tree', () => {
      expect(problemsOf(mutated(tagStep, `      - run: git checkout main\n${tagStep}`))).toContain('the job "release" moves the tree');
    });

    it('wants the tag step to assert HEAD, tag "$COMMIT" from the staging job and mask the encoded token', () => {
      expect(problemsOf(mutated('          test "$(git rev-parse HEAD)" = "$COMMIT"\n', '', 'release'))).toContain('asserts that HEAD is "$COMMIT"');
      expect(problemsOf(mutated('"v$VERSION" -m "v$VERSION" "$COMMIT"', '"v$VERSION" -m "v$VERSION"'))).toContain('tags "$COMMIT"');
      expect(problemsOf(mutated('COMMIT: ${{ needs.stage.outputs.commit }}', 'COMMIT: ${{ github.sha }}', 'release'))).toContain('tags "$COMMIT"');
      expect(problemsOf(mutated('          echo "::add-mask::$encoded"\n', ''))).toContain('masks the encoded token');
    });

    it('wants contents: write', () => {
      expect(problemsOf(mutated('      contents: write # the tag and the draft GitHub Release\n', '      contents: read\n'))).toContain('needs "contents: write"');
    });
  });

  describe('the write token', () => {
    const token = 'GH_TOKEN: ${{ github.token }}';

    it('reaches the tag and draft steps only', () => {
      expect(problemsOf(mutated(installStep, `${installStep.trimEnd()}\n        env:\n          ${token}\n`))).toContain('github.token outside the release job\'s tag and draft steps');
      expect(problemsOf(mutated(stagingStep, stagingStep.replace('        env:\n', `        env:\n          ${token}\n`)))).toContain('github.token outside');
      expect(problemsOf(mutated('      - uses: actions/setup-node@v5\n        with:\n          node-version-file: .nvmrc\n', `      - uses: actions/setup-node@v5\n        env:\n          ${token}\n        with:\n          node-version-file: .nvmrc\n`, 'release'))).toContain('github.token outside');
    });

    it('is no job-level or workflow-level env', () => {
      expect(problemsOf(mutated('    timeout-minutes: 10\n', `    timeout-minutes: 10\n    env:\n      ${token}\n`))).toContain('github.token outside');
      expect(problemsOf(mutated('    timeout-minutes: 30\n', `    timeout-minutes: 30\n    env:\n      ${token}\n`))).toContain('github.token outside');
      expect(problemsOf(mutated('\npermissions:\n  contents: read\n', `\nenv:\n  ${token}\n\npermissions:\n  contents: read\n`))).toContain('github.token outside');
    });
  });
});

describe('checkLabelWorkflow — the release label check', () => {
  const real = readFileSync(join(root, '.github/workflows/pr-label.yml'), 'utf8');

  function repositoryWithLabelWorkflow(workflow: string): string {
    const directory = repositoryWith(unreleased);
    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(join(directory, '.github/workflows/pr-label.yml'), workflow);
    return directory;
  }
  /** The real workflow with `from` replaced — a mutation that did not change anything is a broken test, not a pass. */
  function mutated(from: string, to: string): string {
    const result = real.replace(from, to);
    expect(result, `the mutation of ${from} changed nothing`).not.toBe(real);
    return result;
  }
  const problemsOf = (workflow: string) => checkLabelWorkflow(repositoryWithLabelWorkflow(workflow)).join('\n');

  it('passes the repository’s workflow', () => {
    expectProblems(checkLabelWorkflow(root), []);
  });

  it('refuses a missing file', () => {
    expect(checkLabelWorkflow(repositoryWith(unreleased)).join()).toContain('is missing');
  });

  it('refuses pull_request_target and any further event', () => {
    expect(problemsOf(mutated('  pull_request:\n', '  pull_request_target:\n'))).toContain('exactly the pull_request event');
    expect(problemsOf(mutated('on:\n', 'on:\n  push:\n'))).toContain('exactly the pull_request event');
  });

  it('wants every type, and no other', () => {
    expect(problemsOf(mutated('reopened, ', ''))).toContain('the pull_request types must be');
    expect(problemsOf(mutated('synchronize, ', ''))).toContain('the pull_request types must be');
    expect(problemsOf(mutated('unlabeled]', 'unlabeled, edited]'))).toContain('the pull_request types must be');
  });

  it('wants permissions: {} and none in a job', () => {
    expect(problemsOf(mutated('permissions: {}', 'permissions: write-all'))).toContain('must be "{}"');
    expect(problemsOf(mutated('permissions: {}', 'permissions:\n  contents: read'))).toContain('must be "{}"');
    expect(problemsOf(mutated('    timeout-minutes: 2\n', '    timeout-minutes: 2\n    permissions:\n      contents: read\n'))).toContain('a job asks for permissions');
  });

  it('refuses a checkout, any action, a secret and the token', () => {
    const checkout = '    steps:\n      - uses: actions/checkout@v5\n';
    expect(problemsOf(mutated('    steps:\n', checkout))).toContain('a "uses:" step');
    expect(problemsOf(mutated('    steps:\n', '    steps:\n      - uses: someone/else@v1\n'))).toContain('a "uses:" step');
    expect(problemsOf(mutated('          CATEGORIES:', '          TOKEN: ${{ secrets.TOKEN }}\n          CATEGORIES:'))).toContain('a secret or the token');
    expect(problemsOf(mutated('          CATEGORIES:', '          TOKEN: ${{ github.token }}\n          CATEGORIES:'))).toContain('a secret or the token');
    expect(problemsOf(mutated('          CATEGORIES:', "          TOKEN: ${{ secrets['NPM'] }}\n          CATEGORIES:"))).toContain('a secret or the token');
    expect(problemsOf(mutated('          CATEGORIES:', '          ALL: ${{ toJSON(secrets) }}\n          CATEGORIES:'))).toContain('a secret or the token');
    expect(problemsOf(mutated('          CATEGORIES:', "          TOKEN: ${{ github['token'] }}\n          CATEGORIES:"))).toContain('a secret or the token');
  });

  it('refuses an expression inside the script', () => {
    expect(problemsOf(mutated('          count=$(', '          echo "${{ github.event.pull_request.title }}"\n          count=$('))).toContain('an expression inside a run script');
    expect(problemsOf(mutated('        run: |\n', '        run: echo ${{ github.head_ref }}\n        # |\n'))).toContain('an expression inside a run script');
  });

  it('wants the labels in env from the event and the job named after the required check', () => {
    expect(problemsOf(mutated('toJSON(github.event.pull_request.labels.*.name)', 'toJSON(github.event.pull_request.title)'))).toContain('LABELS must be');
    expect(problemsOf(mutated('name: release label', 'name: label'))).toContain('named "release label"');
  });

  it('keeps CATEGORIES the list of the release rules: a sixth, a missing, a reordered one', () => {
    const list = 'CATEGORIES: breaking feature fix docs internal';
    expect(problemsOf(mutated(list, `${list} chore`))).toContain('CATEGORIES is "breaking feature fix docs internal chore"');
    expect(problemsOf(mutated(list, 'CATEGORIES: breaking feature fix docs'))).toContain('CATEGORIES is "breaking feature fix docs"');
    expect(problemsOf(mutated(list, 'CATEGORIES: feature breaking fix docs internal'))).toContain('one list, in the same order');
  });

  it('wants the error message to explain every label', () => {
    expect(problemsOf(mutated('internal (nothing', 'internal: (nothing'))).toContain('does not explain the label "internal"');
    expect(problemsOf(mutated('docs (documentation', 'documents (documentation'))).toContain('does not explain the label "docs"');
  });

  describe('the shipped script', () => {
    const script = runScripts(real.replace(/(^|\s)#.*$/gm, '$1'))[0]!;
    const hasJq = spawnSync('jq', ['--version']).status === 0;
    const env = (labels: string) => ({ ...process.env, LABELS: labels, CATEGORIES: 'breaking feature fix docs internal' });
    const run = (labels: string) => spawnSync('bash', ['-e', '-c', script], { env: env(labels), encoding: 'utf8' });

    it.skipIf(!hasJq)('passes exactly one category label, whatever else is on the pull request', () => {
      expect(run('["fix"]').status).toBe(0);
      expect(run('["fix","dependencies"]').status).toBe(0);
      expect(run('["internal"]').status).toBe(0);
    });

    it.skipIf(!hasJq)('fails none, two and a label that is no category — naming the labels', () => {
      for (const labels of ['[]', '["fix","docs"]', '["bug"]', '["dependencies"]']) {
        const result = run(labels);
        expect(result.status, labels).toBe(1);
        expect(result.stdout, labels).toContain('::error');
        for (const name of ['breaking', 'feature', 'fix', 'docs', 'internal']) expect(result.stdout, labels).toContain(name);
      }
    });

    it.skipIf(!hasJq)('treats hostile label names as data: nothing runs, nothing is injected, case counts', () => {
      const directory = mkdtempSync(join(tmpdir(), 'label-script-'));
      directories.push(directory);
      const hostile = ['fix', '$(touch pwned)', '`touch pwned2`', 'a"b', 'x\n::error::injected', 'Fix'];
      const result = spawnSync('bash', ['-e', '-c', script], { cwd: directory, env: env(JSON.stringify(hostile)), encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('::error');
      expect(readdirSync(directory)).toEqual([]);
      expect(run('["Fix"]').status).toBe(1);
    });

    it.skipIf(hasJq)('needs jq to run the shipped script', () => {
      expect.fail('jq is not installed: the label script was not run');
    });
  });
});

describe('checkReleaseConfig', () => {
  it('passes the repository’s .github/release.yml', () => {
    expectProblems(checkReleaseConfig(root), []);
  });

  it('refuses a hand-edited file and a missing one', () => {
    const edited = repositoryWith(unreleased);
    mkdirSync(join(edited, '.github'), { recursive: true });
    writeFileSync(join(edited, '.github/release.yml'), `${readFileSync(join(root, '.github/release.yml'), 'utf8')}# my own category\n`);
    expectProblems(checkReleaseConfig(edited), ['.github/release.yml: missing or out of date — run node scripts/release-rules.ts']);
    expect(checkReleaseConfig(repositoryWith(unreleased))).toHaveLength(1);
  });
});
