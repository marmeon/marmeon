import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frameworkPackages } from './packages.ts';
import { check, checkApiLabelWorkflow, checkCanaryWorkflow, checkChangelogs, checkCiWorkflow, checkLabelWorkflow, checkReleaseConfig, checkTrust, checkUpgrading, checkVersion, checkWorkflow, CHANGESETS_UNTIL, runScripts, UPGRADING_ANCHORS } from './check-release.ts';
import { tempDir } from './test/temp-dir.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A repository with nothing but this UPGRADING.md. */
function repositoryWith(upgrading: string): string {
  const directory = tempDir('marmeon-check-release-');
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

/** The full `action@<sha> # vX.Y.Z` reference a workflow pins an action to, so tests follow a version bump. */
function pinOf(workflow: string, action: string): string {
  const name = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${name}@[0-9a-f]{40} # v[\\w.]+`).exec(workflow);
  if (!match) throw new Error(`no pinned ${action} in the workflow`);
  return match[0];
}

/** The problems found against those wanted — both in the message: Vitest shortens the lists in its own ("[ Array(1) ]"). */
function expectProblems(problems: readonly string[], wanted: readonly string[]): void {
  const list = (items: readonly string[]) => (items.length === 0 ? 'nothing' : items.join(' | '));
  expect(problems, `found: ${list(problems)} — wanted: ${list(wanted)}`).toEqual(wanted);
}

describe('checkUpgrading — before the first release', () => {
  it('passes the repository’s UPGRADING.md', () => {
    const problems = checkUpgrading(root, UPGRADING_ANCHORS, frameworkPackages(root)[0]?.manifest.version);
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
      'UPGRADING.md has the section of 0.3.0, and scripts/check-release.ts lists none of its entries — add their anchors to UPGRADING_ANCHORS["0.3.0"]',
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
      'UPGRADING.md has no section "## Upgrading to 0.2.0 from …", which scripts/check-release.ts lists',
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
  const page = section('## Upgrading to 0.2.0 from 0.1.2');
  const listed = { '0.2.0': ['low-a-change-of-020'] };

  it('refuses a section above the version', () => {
    expectProblems(checkUpgrading(repositoryWith(page), listed, '0.1.2'), [
      'UPGRADING.md has a section for 0.2.0, but the packages are at 0.1.2',
    ]);
  });

  it('refuses a section that does not go up', () => {
    const problems = checkUpgrading(repositoryWith(section('## Upgrading to 0.1.0 from 0.1.0')), { '0.1.0': listed['0.2.0'] });
    expectProblems(problems, ['UPGRADING.md: "## Upgrading to 0.1.0 from 0.1.0" — a release upgrades from a lower version to a higher one']);
  });

  it('needs nothing for a version that is no breaking release', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.1.3'), []);
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.2.1'), []);
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '1.1.0'), []);
  });

  it('needs the section of a breaking release', () => {
    expectProblems(checkUpgrading(repositoryWith(unreleased), {}, '0.2.0'), [
      '0.2.0 is a breaking release — UPGRADING.md needs its section "## Upgrading to 0.2.0 from <a 0.1.x version>"',
    ]);
  });

  it('needs the section of a breaking release to start from the line below', () => {
    expectProblems(checkUpgrading(repositoryWith(section('## Upgrading to 0.2.0 from 0.0.9')), listed, '0.2.0'), [
      'UPGRADING.md: the section of 0.2.0 upgrades from 0.0.9, but it starts from 0.1.x — "## Upgrading to 0.2.0 from <a 0.1.x version>"',
    ]);
  });

  it('needs entries listed for the section of a breaking release', () => {
    expectProblems(checkUpgrading(repositoryWith(page), { '0.2.0': [] }, '0.2.0'), [
      '0.2.0 is a breaking release — scripts/check-release.ts lists none of its entries: UPGRADING_ANCHORS["0.2.0"]',
    ]);
  });

  it('passes a breaking release with its section and entries', () => {
    expectProblems(checkUpgrading(repositoryWith(page), listed, '0.2.0'), []);
  });

  it('starts 1.0.0 from any 0.y.z and 2.0.0 from 1.x only', () => {
    const at = (version: string, from: string) =>
      checkUpgrading(repositoryWith(section(`## Upgrading to ${version} from ${from}`)), { [version]: listed['0.2.0'] }, version);
    expectProblems(at('1.0.0', '0.7.2'), []);
    expectProblems(at('2.0.0', '1.8.4'), []);
    expectProblems(at('2.0.0', '0.9.0'), ['UPGRADING.md: the section of 2.0.0 upgrades from 0.9.0, but it starts from 1.x — "## Upgrading to 2.0.0 from <a 1.x version>"']);
    expect(at('1.0.0', '1.0.0')).toContain('UPGRADING.md: "## Upgrading to 1.0.0 from 1.0.0" — a release upgrades from a lower version to a higher one');
  });

  it('refuses the placeholder the release preparation writes', () => {
    const placeholder = '<!-- One entry per breaking pull request: #12, #14 — then list their anchors in UPGRADING_ANCHORS of scripts/check-release.ts. -->';
    expect(checkUpgrading(repositoryWith(section('## Upgrading to 0.2.0 from 0.1.2', placeholder)), listed, '0.2.0')).toContain(
      'UPGRADING.md still has a placeholder or a comment',
    );
  });

  it('refuses a section whose versions are no plain x.y.z', () => {
    expect(checkUpgrading(repositoryWith(section('## Upgrading to 0.02.0 from 0.1.0')), {}).join('\n')).toContain('plain versions');
  });
});

describe('release candidates', () => {
  it('may have the section of their release already, and none above it', () => {
    expectProblems(checkUpgrading(repositoryWith(released()), anchors, '0.3.0-rc.1'), []);
    expectProblems(checkUpgrading(repositoryWith(released()), anchors, '0.2.0-rc.1'), [
      'UPGRADING.md has a section for 0.3.0, but the packages are at 0.2.0-rc.1',
    ]);
  });
});

describe('prereleases', () => {
  it('refuses a prerelease version', () => {
    const problems = checkUpgrading(repositoryWith(unreleased), {}, '0.2.0-beta.0');
    expectProblems(problems, ['the packages are at 0.2.0-beta.0 — prerelease versions are not supported by this check: the sections of UPGRADING.md cannot be bound to them']);
  });
});

/** Writes `files` (path → text; an object is written as JSON) below `directory`. */
function write(directory: string, files: Record<string, unknown>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return directory;
}

const manifest = (name: string, version: string, extra: object = {}) => ({ name, version, ...extra });
const changelog = (name: string, ...sections: [version: string, body: string][]) => `# ${name}\n\n${sections.map(([version, body]) => `## ${version}\n\n${body}\n`).join('\n')}`;

/** A repository of two published packages (and a private one) at `version`. */
function repositoryOfPackages(version = '0.1.2', extra: Record<string, unknown> = {}): string {
  return write(repositoryWith(unreleased), {
    'packages/core/package.json': manifest('@marmeon/core', version),
    'packages/http/package.json': manifest('@marmeon/http', version, { dependencies: { '@marmeon/core': 'workspace:*', valibot: '^1.0.0' } }),
    'packages/private/package.json': manifest('@marmeon/private', '9.9.9', { private: true }),
    ...extra,
  });
}

describe('checkVersion', () => {
  const problemsOf = (directory: string) => checkVersion(directory, frameworkPackages(directory));

  it('passes the repository', () => {
    expectProblems(checkVersion(root, frameworkPackages(root)), []);
  });

  it('passes one version, and ignores a private package', () => {
    expectProblems(problemsOf(repositoryOfPackages()), []);
  });

  it('refuses two versions', () => {
    const directory = repositoryOfPackages('0.1.2', { 'packages/http/package.json': manifest('@marmeon/http', '0.1.3') });
    expectProblems(problemsOf(directory), ['the packages have 2 versions (0.1.2: @marmeon/core; 0.1.3: @marmeon/http) — one version for all (pnpm release:prepare)']);
  });

  it('wants every internal range workspace:*, in dependencies, peers and optional dependencies', () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const directory = repositoryOfPackages('0.1.2', { 'packages/http/package.json': manifest('@marmeon/http', '0.1.2', { [field]: { '@marmeon/core': '^0.1.2' } }) });
      expect(problemsOf(directory).join('\n')).toContain(`@marmeon/http: ${field}["@marmeon/core"] is "^0.1.2"`);
    }
  });

  it('lets a range on a package that is not a framework package be anything', () => {
    const directory = repositoryOfPackages('0.1.2', { 'packages/http/package.json': manifest('@marmeon/http', '0.1.2', { dependencies: { '@marmeon/private': '^1.0.0' } }) });
    expectProblems(problemsOf(directory), []);
  });
});

describe('checkChangelogs', () => {
  const problemsOf = (directory: string) => checkChangelogs(directory, frameworkPackages(directory));
  const same = (version: string, body = '- A change by @max in https://example.test/pull/1') => ({
    'packages/core/CHANGELOG.md': changelog('@marmeon/core', [version, body]),
    'packages/http/CHANGELOG.md': changelog('@marmeon/http', [version, body]),
  });

  it('passes the repository (its older sections differ between packages)', () => {
    expectProblems(checkChangelogs(root, frameworkPackages(root)), []);
  });

  it('passes the same section in every package after the per-package sections', () => {
    expectProblems(problemsOf(repositoryOfPackages('0.1.3', same('0.1.3'))), []);
  });

  it('lets sections differ up to the last per-package version', () => {
    expect(CHANGESETS_UNTIL).toBe('0.1.2');
    const files = { ...same('0.1.2'), 'packages/http/CHANGELOG.md': changelog('@marmeon/http', ['0.1.2', '- Something else']) };
    expectProblems(problemsOf(repositoryOfPackages('0.1.2', files)), []);
  });

  it('refuses a section that differs in one package after the per-package sections', () => {
    const files = { ...same('0.1.3'), 'packages/http/CHANGELOG.md': changelog('@marmeon/http', ['0.1.3', '- Something else']) };
    expectProblems(problemsOf(repositoryOfPackages('0.1.3', files)), ["The \"## 0.1.3\" section of @marmeon/http differs from @marmeon/core's."]);
  });

  it('refuses a package whose first section is an older version', () => {
    const files = { ...same('0.1.3'), 'packages/http/CHANGELOG.md': changelog('@marmeon/http', ['0.1.2', '- Old']) };
    expectProblems(problemsOf(repositoryOfPackages('0.1.3', files)), [
      '@marmeon/http: packages/http/CHANGELOG.md: its first section is "## 0.1.2", but the package is at 0.1.3 — pnpm release:prepare writes it',
    ]);
  });

  it('refuses an Unreleased heading', () => {
    const files = { ...same('0.1.3'), 'packages/http/CHANGELOG.md': '# @marmeon/http\n\n## Unreleased\n\n- A change\n' };
    expect(problemsOf(repositoryOfPackages('0.1.3', files)).join('\n')).toContain('is not "## x.y.z"');
  });

  it('refuses a missing changelog and an empty one', () => {
    const files = { 'packages/core/CHANGELOG.md': changelog('@marmeon/core', ['0.1.2', 'x']), 'packages/http/CHANGELOG.md': '# @marmeon/http\n' };
    expectProblems(problemsOf(repositoryOfPackages('0.1.2', files)), ['@marmeon/http: packages/http/CHANGELOG.md: its first section is missing, but the package is at 0.1.2 — pnpm release:prepare writes it']);
    expectProblems(problemsOf(repositoryOfPackages('0.1.2', { 'packages/core/CHANGELOG.md': changelog('@marmeon/core', ['0.1.2', 'x']) })), [
      '@marmeon/http: packages/http/CHANGELOG.md is missing',
    ]);
  });
});

describe('check', () => {
  it('passes the repository', () => {
    const problems = check(root);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('hands the packages’ version to the upgrade guide check', () => {
    const directory = repositoryOfPackages('0.2.0', {
      'packages/core/CHANGELOG.md': changelog('@marmeon/core', ['0.2.0', 'x']),
      'packages/http/CHANGELOG.md': changelog('@marmeon/http', ['0.2.0', 'x']),
    });
    expect(check(directory)).toContain('0.2.0 is a breaking release — UPGRADING.md needs its section "## Upgrading to 0.2.0 from <a 0.1.x version>"');
  });
});

describe('checkWorkflow — the release run', () => {
  const real = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const setupNode = pinOf(real, 'actions/setup-node');
  const checkoutPin = pinOf(real, 'actions/checkout');
  const pnpmPin = pinOf(real, 'pnpm/action-setup');
  const pnpmSha = pnpmPin.split(' ')[0]!;
  const draft = /gh release create .*--draft.*/.exec(real)![0];
  /** Where the staging job and the release job start: before them is the workflow's top and the build job. */
  const cutStage = real.indexOf('\n  stage:\n');
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
  function mutated(from: string | RegExp, to: string, part: 'file' | 'build' | 'stage' | 'release' = 'file'): string {
    const [start, end] = part === 'file' ? [0, real.length] : part === 'build' ? [0, cutStage] : part === 'stage' ? [cutStage, cut] : [cut, real.length];
    const result = real.slice(0, start) + real.slice(start, end).replace(from, to) + real.slice(end);
    expect(result, `the mutation of ${String(from)} changed nothing`).not.toBe(real);
    return result;
  }
  const problemsOf = (workflow: string) => checkWorkflow(repositoryWithWorkflow(workflow)).join('\n');

  /** The real workflow's steps by their first line, to move or drop them. */
  const step = (first: string) => {
    const start = real.indexOf(first);
    expect(start, `no step starts with ${first}`).toBeGreaterThanOrEqual(0);
    const to = [real.indexOf('\n      # ', start + 1), real.indexOf('\n      - ', start + 1), real.indexOf('\n\n  stage:', start + 1), real.indexOf('\n\n  release:', start + 1)].filter((index) => index > 0).sort((a, b) => a - b)[0] ?? real.length;
    return real.slice(start, to + 1);
  };
  const guardStep = '      - id: guard\n        run: node scripts/release-guard.ts\n';
  const installStep = '      - run: pnpm install --frozen-lockfile\n';
  const packStep = step('      - id: pack');
  const uploadStep = step('      - uses: actions/upload-artifact');
  const stagingStep = step('      - name: stage the tarballs');
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
      expect(problemsOf(mutated('LATEST: ${{ needs.build.outputs.latest }}', 'LATEST: true'))).toContain('--latest="$LATEST"');
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
      expect(problemsOf(mutated('LATEST: ${{ needs.build.outputs.latest }}', 'LATEST: ${{ needs.build.outputs.latest }}\n          X: ${{ secrets.NPM_TOKEN }}'))).toContain('a secret');
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

    it('refuses a tag step that skips without comparing the commit, or that never looks for an existing tag', () => {
      expect(problemsOf(mutated('elif [ "$existing" = "$COMMIT" ]; then', 'elif [ -n "$existing" ]; then', 'release'))).toContain('looks for a tag that exists');
      expect(problemsOf(mutated('            exit 1\n', '            echo x\n', 'release'))).toContain('looks for a tag that exists');
      expect(problemsOf(mutated('"refs/tags/v$VERSION^{}" | cut -f1', '"refs/tags/v$VERSION" | cut -f1', 'release'))).toContain('looks for a tag that exists');
    });

    it('refuses a run script with a pipe that does not start with pipefail', () => {
      expect(problemsOf(mutated('set -o pipefail\n          test "$(git rev-parse HEAD)" = "$COMMIT"', 'test "$(git rev-parse HEAD)" = "$COMMIT"', 'release'))).toContain('must start with "set -o pipefail"');
    });

    it('refuses a cache in either job', () => {
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          cache: pnpm', 'build'))).toContain('a cache');
      expect(problemsOf(mutated('node-version: 26.10.0', 'node-version: 26.10.0\n          cache: npm', 'stage'))).toContain('a cache');
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          cache: pnpm', 'release'))).toContain('a cache');
      expect(problemsOf(mutated(installStep, `      - uses: actions/cache@v4\n${installStep}`))).toContain('a cache');
    });

    it('refuses a setup-node step that does not turn its implicit cache off', () => {
      for (const [part, version] of [['build', 'node-version-file: .nvmrc'], ['stage', 'node-version: 26.10.0'], ['release', 'node-version-file: .nvmrc']] as const) {
        const off = `${version}\n          package-manager-cache: false`;
        expect(problemsOf(mutated(off, version, part))).toContain('without "package-manager-cache: false"');
        expect(problemsOf(mutated(off, `${version}\n          package-manager-cache: true`, part))).toContain('without "package-manager-cache: false"');
      }
      const setup = '      - uses: ' + setupNode + '\n        with:\n          node-version-file: .nvmrc\n          package-manager-cache: false # the action\'s default restores a pnpm store by itself\n';
      const named = '      - name: node\n        uses: ' + setupNode + '\n        with:\n          node-version-file: .nvmrc\n';
      expect(problemsOf(mutated(setup, named, 'build'))).toContain('without "package-manager-cache: false"');
      expect(problemsOf(mutated(setup, named.replace('with:', 'env:\n          package-manager-cache: false\n        with:'), 'release'))).toContain('without "package-manager-cache: false"');
      expect(problemsOf(mutated(setup, named + '          package-manager-cache: false\n', 'release'))).not.toContain('package-manager-cache');
      expect(problemsOf(real)).not.toContain('package-manager-cache');
    });

    it('refuses defaults: and shell:', () => {
      expect(problemsOf(mutated('\njobs:\n', '\ndefaults:\n  run:\n    shell: sh\n\njobs:\n'))).toContain('"defaults:" or "shell:"');
      expect(problemsOf(mutated(installStep, '      - run: pnpm install --frozen-lockfile\n        shell: bash\n'))).toContain('"defaults:" or "shell:"');
    });

    it('wants every action pinned by its SHA, those of actions/* too', () => {
      expect(problemsOf(mutated(/pnpm\/action-setup@[0-9a-f]{40}/, 'pnpm/action-setup@v6.1.0'))).toContain('is not pinned to a commit');
      expect(problemsOf(mutated(/pnpm\/action-setup@[0-9a-f]{40}/, 'pnpm/action-setup@main'))).toContain('is not pinned to a commit');
      expect(problemsOf(mutated(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v5'))).toContain('"actions/checkout@v5" is not pinned to a commit');
      expect(problemsOf(mutated(/actions\/setup-node@[0-9a-f]{40}/, 'actions/setup-node@v5', 'release'))).toContain('"actions/setup-node@v5" is not pinned to a commit');
      expect(problemsOf(mutated(/actions\/setup-node@[0-9a-f]{40}/, 'actions/setup-node@' + 'a'.repeat(39), 'stage'))).toContain('is not pinned to a commit');
      expect(problemsOf(mutated(/actions\/upload-artifact@[0-9a-f]{40}/, 'actions/upload-artifact@v7'))).toContain('"actions/upload-artifact@v7" is not pinned to a commit');
      expect(problemsOf(mutated(/actions\/download-artifact@[0-9a-f]{40}/, 'actions/download-artifact@v8'))).toContain('"actions/download-artifact@v8" is not pinned to a commit');
    });

    it.each([['a quoted key', '"uses":'], ['a space before the colon', 'uses :'], ['single quotes', "'uses':"]])('sees a uses key written with %s', (_form, key) => {
      const unpinned = `      - ${key} actions/cache@v4\n`;
      expect(problemsOf(mutated(installStep, unpinned + installStep))).toContain('"actions/cache@v4" is not pinned to a commit');
      expect(problemsOf(mutated(installStep, `      - ${key} softprops/action-gh-release@v2\n${installStep}`))).toContain('a release action');
      expect(problemsOf(mutated(installStep, `      - ${key} actions/checkout@v5\n${installStep}`))).toContain('is not pinned to a commit');
      expect(problemsOf(mutated(/uses: actions\/setup-node@[0-9a-f]{40}/, `${key} actions/setup-node@v5`, 'release'))).toContain('is not pinned to a commit');
    });

    it('sees an action after the guard however its uses key is written', () => {
      for (const key of ['"uses":', 'uses :']) {
        expect(problemsOf(mutated(installStep, `      - ${key} actions/setup-node@${'a'.repeat(40)}\n${installStep}`))).toContain('uses an action after the guard');
      }
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

    it('stages from the protected environment, in the staging job and in no other', () => {
      expect(problemsOf(mutated('    environment: npm-release\n', '', 'stage'))).toContain('the job "stage" stages without "environment: npm-release"');
      expect(problemsOf(mutated('    environment: npm-release', '    environment: other', 'stage'))).toContain('the job "stage" stages without "environment: npm-release"');
      expect(problemsOf(mutated('    permissions:\n      contents: write', '    environment: npm-release\n    permissions:\n      contents: write', 'release'))).toContain('the job "release" has an "environment:"');
    });

    it('wants the trust script to pass the environment', () => {
      const directory = tempDir('marmeon-check-release-');
      mkdirSync(join(directory, 'scripts'));
      writeFileSync(join(directory, 'scripts/npm-trust.sh'), '#!/usr/bin/env bash\nnpm trust github "$package" --repository marmeon/marmeon --file release.yml --allow-stage-publish --yes\n');
      expect(checkTrust(directory)).toEqual([expect.stringContaining('does not pass --environment npm-release')]);
      expect(checkTrust(root)).toEqual([]);
    });

    it('gives the OIDC token to the staging job only — not to the build job, which runs the repository’s code', () => {
      const withToken = mutated('    permissions:\n      contents: read\n    outputs:', '    permissions:\n      contents: read\n      id-token: write\n    outputs:', 'build');
      expect(problemsOf(withToken)).toContain('the job "build" has "id-token: write" but stages nothing');
    });

    it('keeps the default exactly contents: read — no further scope for every job', () => {
      expect(problemsOf(mutated('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'))).toContain('default "permissions:"');
      expect(problemsOf(mutated('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n'))).toContain('default "permissions:"');
      expect(problemsOf(mutated('permissions:\n  contents: read\n', 'permissions:\n  id-token: write\n  contents: read\n'))).toContain('default "permissions:"');
    });

    it('wants a permissions: block on every job — the split cannot be undone by a default that grants id-token', () => {
      const own = '    permissions:\n      contents: read\n    outputs:';
      const undone = mutated(own, '    outputs:', 'build').replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n');
      expect(problemsOf(undone)).toContain('the job "build" has no "permissions:" block');
      expect(problemsOf(undone)).toContain('default "permissions:"');
      expect(problemsOf(mutated('    permissions:\n      contents: write # the tag and the draft GitHub Release\n', '', 'release'))).toContain('the job "release" has no "permissions:" block');
    });

    it('wants the job after the staging to depend on it, and on the build job', () => {
      expect(problemsOf(mutated('    needs: [build, stage]\n', ''))).toContain('0 jobs run after the staging job');
      expect(problemsOf(mutated('    needs: [build, stage]\n', ''))).toContain('github.token without a release job');
      expect(problemsOf(mutated('    needs: [build, stage]\n', '    needs: stage\n'))).toContain('the job "release" waits for the build job too');
    });

    it('wants the staging job to wait for exactly the build job', () => {
      expect(problemsOf(mutated('    needs: build\n', '', 'stage'))).toContain('the staging job waits for 0 jobs');
      expect(problemsOf(mutated('    needs: build\n', '    needs: [build, release]\n', 'stage'))).toContain('the staging job waits for 2 jobs');
    });

    it('wants exactly one staging job, on a GitHub-hosted runner, and the build to run pack:check and check-release', () => {
      expect(problemsOf(`${real}\n  again:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm stage publish ./x.tgz\n`)).toContain('2 jobs stage the packages');
      expect(problemsOf(mutated('    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n', 'stage'))).toContain('must run on a GitHub-hosted runner');
      expect(problemsOf(mutated('pnpm run ci --only build,pack:check,check-release', 'pnpm run ci --only build'))).toContain('runs pack:check before the tarballs are packed');
      expect(problemsOf(mutated('pnpm run ci --only build,pack:check,check-release', 'pnpm run ci --only build,pack:check'))).toContain('runs check-release before the tarballs are packed');
    });

    it('refuses npm publish, a plain pnpm publish, pnpm stage and a token', () => {
      const cd = 'cd "$TARBALLS"';
      expect(problemsOf(mutated(cd, `npm publish && ${cd}`, 'stage'))).toContain('"npm publish"');
      expect(problemsOf(mutated(cd, `pnpm publish -r && ${cd}`, 'stage'))).toContain('a plain "pnpm publish"');
      expect(problemsOf(mutated(installStep, `      - run: pnpm run release:stage\n${installStep}`))).toContain('pnpm stage or release:stage');
      expect(problemsOf(mutated(installStep, `      - run: pnpm stage publish -r\n${installStep}`))).toContain('pnpm stage or release:stage');
      expect(problemsOf(mutated('node-version-file: .nvmrc', 'node-version-file: .nvmrc\n          registry-url: https://registry.npmjs.org'))).toContain('registry-url');
    });

    it('refuses an if: or continue-on-error: on a step or on a job', () => {
      expect(problemsOf(mutated('      - id: guard\n', '      - id: guard\n        if: false\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('      - id: guard\n', '      - id: guard\n        continue-on-error: true\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('    timeout-minutes: 30\n', '    timeout-minutes: 30\n    if: github.ref == \'refs/heads/main\'\n'))).toContain('"if:" or "continue-on-error:"');
      expect(problemsOf(mutated('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    if: always()\n'))).toContain('"if:" or "continue-on-error:"');
    });

    it('wants every checkout without persisted credentials', () => {
      expect(problemsOf(mutated(/ {10}persist-credentials: false.*\n/, '', 'build'))).toContain('the job "build" checks out without "persist-credentials: false"');
      expect(problemsOf(mutated(/ {10}persist-credentials: false.*\n/, '', 'release'))).toContain('the job "release" checks out without "persist-credentials: false"');
    });
  });

  describe('the build job: the guard and the release commit', () => {
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

    it('wants the guard before the install, the checks and the packing', () => {
      expect(problemsOf(mutated(guardStep, '').replace(installStep, `${installStep}${guardStep}`))).toContain('pnpm install must come after the guard');
      expect(problemsOf(mutated(guardStep, '').replace(packStep, `${packStep}${guardStep}`))).toContain('pnpm install must come after the guard');
    });

    it('wants packing after pack:check', () => {
      const check = step('      - run: pnpm run ci --only');
      expect(problemsOf(real.replace(check, '').replace(packStep, `${packStep}${check}`))).toContain('packing must come after pack:check');
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
      expect(problemsOf(mutated(installStep, `      - uses: ${checkoutPin}\n${installStep}`))).toContain('checks out or moves the tree after the guard');
      expect(problemsOf(mutated(installStep, `      - run: |\n          echo hi\n          git checkout main\n${installStep}`))).toContain('checks out or moves the tree after the guard');
    });

    it('allows only run steps after the guard', () => {
      expect(problemsOf(mutated(installStep, `      - uses: ${setupNode}\n${installStep}`))).toContain('uses an action after the guard');
    });

    it('wants the checkout with the whole history', () => {
      expect(problemsOf(mutated(/ {10}fetch-depth: 0.*\n/, ''))).toContain('"fetch-depth: 0"');
      expect(problemsOf(mutated(/ {10}fetch-depth: 0.*\n/, '          fetch-depth: 1\n'))).toContain('"fetch-depth: 0"');
    });

    it('wants the packing step exactly: HEAD is the release commit, the tree is clean, the tarballs go to one directory', () => {
      const wanted = 'packs with exactly';
      expect(problemsOf(mutated('          test "$(git rev-parse HEAD)" = "$COMMIT"\n', '', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('          status=$(git status --porcelain)\n', '', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('          test -z "$status"\n', '', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('          test -z "$status"\n', '          test -z "$(git status --porcelain)"\n', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('node scripts/release-pack.ts "$RUNNER_TEMP/tarballs"', 'node scripts/release-pack.ts "$RUNNER_TEMP/other"', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('COMMIT: ${{ steps.guard.outputs.commit }}', 'COMMIT: ${{ github.sha }}'))).toContain('takes COMMIT of it from the guard');
      expect(problemsOf(mutated('      - id: pack\n', '      - id: other\n'))).toContain('packs in the step with the id "pack"');
    });

    it('wants the packing after the install, the checks and the guard, and no packing at all is a problem', () => {
      expect(problemsOf(mutated(packStep, ''))).toContain('packing must come after pack:check');
    });

    it('wants the guard’s commit, version, latest and dist-tag and the pack step’s sums as outputs', () => {
      for (const key of ['commit', 'version', 'latest', 'dist-tag']) {
        expect(problemsOf(mutated(`      ${key}: \${{ steps.guard.outputs.${key} }}\n`, '', 'build')), key).toContain(`hands the guard's "${key}" on`);
      }
      expect(problemsOf(mutated('      sums: ${{ steps.pack.outputs.sums }}\n', '', 'build'))).toContain('hands the hash of SHA512SUMS on as the output "sums"');
    });

    it('ends by uploading the artifact, pinned, for a day, and nothing else uses an action after the guard', () => {
      const wanted = 'ends by uploading the artifact';
      expect(problemsOf(mutated(uploadStep, ''))).toContain(wanted);
      expect(problemsOf(mutated('          name: tarballs\n          path: ${{ runner.temp }}/tarballs\n          retention-days: 1', '          name: other\n          path: ${{ runner.temp }}/tarballs\n          retention-days: 1', 'build'))).toContain(wanted);
      expect(problemsOf(mutated('retention-days: 1', 'retention-days: 90'))).toContain(wanted);
      expect(problemsOf(mutated(uploadStep, `${uploadStep}      - run: echo hi\n`))).toContain(wanted);
      expect(problemsOf(mutated(uploadStep, `${uploadStep}      - uses: actions/upload-artifact@${'a'.repeat(40)}\n`))).toContain('uses an action after the guard');
      expect(problemsOf(mutated(installStep, `      - uses: actions/upload-artifact@${'a'.repeat(40)}\n${installStep}`))).toContain('uses an action after the guard');
    });
  });

  describe('the staging job: the only one with the OIDC token', () => {
    const wanted = 'stages with exactly';

    it('has no checkout, because the repository’s code would run next to the token', () => {
      const checkout = '      - uses: ' + checkoutPin + '\n        with:\n          persist-credentials: false\n';
      const first = '      - uses: actions/download-artifact';
      expect(problemsOf(mutated(first, `${checkout}${first}`, 'stage'))).toContain('the job "stage" checks out the repository');
      expect(problemsOf(mutated(first, `${checkout}${first}`, 'stage'))).toContain('has exactly three steps');
    });

    it('installs and runs nothing of the repository: no pnpm, node, git, npm install or other npm command', () => {
      const cd = 'cd "$TARBALLS"';
      for (const command of ['pnpm install --frozen-lockfile', 'pnpm run build', 'npm ci', 'npm install', 'npm run build', 'npm exec x', 'npx x', 'yarn', 'corepack enable', 'node scripts/other.ts', 'git status', 'bun x']) {
        expect(problemsOf(mutated(cd, `${command}\n          ${cd}`, 'stage')), command).toContain('it holds the OIDC token: no pnpm, node, git or install');
      }
      expect(problemsOf(mutated(cd, `# ${'pnpm install'}\n          ${cd}`, 'stage'))).not.toContain('no pnpm, node, git or install');
    });

    it('uses no action but the download of the artifact and setup-node', () => {
      const first = '      - uses: actions/download-artifact';
      expect(problemsOf(mutated(first, `      - uses: ${pnpmPin}\n${first}`, 'stage'))).toContain('the job "stage" uses pnpm/action-setup@');
      expect(problemsOf(mutated(first, `      - uses: actions/cache@${'a'.repeat(40)}\n${first}`, 'stage'))).toContain('the job "stage" uses actions/cache@');
    });

    it('has exactly three steps: the download, setup-node, the staging', () => {
      expect(problemsOf(mutated(stagingStep, `${stagingStep}      - run: echo hi\n`, 'stage'))).toContain('has exactly three steps');
      expect(problemsOf(mutated('          node-version: 26.10.0\n', '', 'stage'))).toContain('sets up Node with');
      expect(problemsOf(mutated(stagingStep, '', 'stage'))).toContain('0 jobs stage the packages');
    });

    it('downloads the artifact the build job uploads', () => {
      const wantedDownload = 'downloads the artifact "tarballs"';
      expect(problemsOf(mutated('          name: tarballs\n', '          name: other\n', 'stage'))).toContain(wantedDownload);
      expect(problemsOf(mutated('          path: ${{ runner.temp }}/tarballs\n', '          path: ${{ runner.temp }}/elsewhere\n', 'stage'))).toContain(wantedDownload);
    });

    it('sets up the Node of .nvmrc — there is no checkout to read the file from', () => {
      const version = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
      expect(real).toContain(`node-version: ${version}`);
      const repository = repositoryWithWorkflow(real);
      writeFileSync(join(repository, '.nvmrc'), '99.0.0\n');
      expect(checkWorkflow(repository).join('\n')).toContain('sets up Node with "node-version: 99.0.0"');
      writeFileSync(join(repository, '.nvmrc'), `${version}\n`);
      expect(checkWorkflow(repository)).toEqual([]);
      expect(problemsOf(mutated('          node-version: 26.10.0\n', '          node-version-file: .nvmrc\n', 'stage'))).toContain('sets up Node with');
    });

    it('checks the hash of SHA512SUMS and of every tarball before the first npm stage publish, and stages the files SHA512SUMS names', () => {
      const hashCheck = '          printf \'%s  SHA512SUMS\\n\' "$SUMS" | sha512sum --check --strict -\n';
      expect(real).toContain(hashCheck);
      expect(problemsOf(mutated(hashCheck, '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(hashCheck, hashCheck.replace('--strict ', ''), 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          sha512sum --check --strict SHA512SUMS\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(hashCheck, '', 'stage'))).toContain('before the first npm stage publish');
      expect(problemsOf(mutated('          set -o pipefail\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          done < "$TARBALLS/SHA512SUMS"\n', '          done < /dev/null\n', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          cat SHA512SUMS\n', '', 'stage'))).toContain(wanted);
    });

    it('refuses any file in the artifact besides SHA512SUMS and the tarballs it names — npm would read a planted .npmrc', () => {
      for (const line of ['          expected=', '          found=', '          test "$expected" = "$found"']) {
        const start = real.indexOf(line);
        expect(start, line).toBeGreaterThan(0);
        const text = real.slice(start, real.indexOf('\n', start) + 1);
        expect(problemsOf(mutated(text, '', 'stage')), line).toContain(wanted);
      }
      expect(problemsOf(mutated('find . -mindepth 1', 'find . -mindepth 1 -not -name ".*"', 'stage'))).toContain(wanted);
    });

    it('runs npm in an empty directory, on tarballs named by absolute path, without an npmrc of the user or the machine', () => {
      expect(problemsOf(mutated('          cd "$RUNNER_TEMP/empty"\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('"$TARBALLS/$name" --provenance', '"./$name" --provenance', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('NPM_CONFIG_USERCONFIG: ${{ runner.temp }}/no-userconfig', 'NPM_CONFIG_USERCONFIG: /tmp/npmrc', 'stage'))).toContain('stages with the env');
      // npm exits 1 when both name /dev/null ("double-loading config").
      expect(problemsOf(mutated('NPM_CONFIG_USERCONFIG: ${{ runner.temp }}/no-userconfig', 'NPM_CONFIG_USERCONFIG: /dev/null', 'stage'))).toContain('stages with the env');
      expect(problemsOf(mutated('NPM_CONFIG_GLOBALCONFIG: ${{ runner.temp }}/no-globalconfig', 'NPM_CONFIG_GLOBALCONFIG: ${{ runner.temp }}/no-userconfig', 'stage'))).toContain('stages with the env');
      expect(problemsOf(mutated(/ {10}NPM_CONFIG_GLOBALCONFIG: .*\n/, '', 'stage'))).toContain('stages with the env');
    });

    it('starts npm with the two config files of the workflow (the same file for both makes npm exit 1)', () => {
      const dir = tempDir('marmeon-check-release-');
      const env = { ...process.env, NPM_CONFIG_USERCONFIG: join(dir, 'no-userconfig'), NPM_CONFIG_GLOBALCONFIG: join(dir, 'no-globalconfig') };
      expect(spawnSync('npm', ['--version'], { env, encoding: 'utf8' }).status).toBe(0);
      const same = { ...env, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null' };
      expect(spawnSync('npm', ['--version'], { env: same, encoding: 'utf8' }).status).not.toBe(0);
    });

    it('validates the dist-tag before any npm call and passes it as --tag="$DIST_TAG"', () => {
      expect(problemsOf(mutated('          [[ "$DIST_TAG" =~ ^latest(-[0-9]+(\\.[0-9]+)?)?$ ]]\n', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('^latest(-[0-9]+(\\.[0-9]+)?)?$', '^.*$', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('--tag="$DIST_TAG"', '--tag "$DIST_TAG"', 'stage'))).toContain(wanted);
    });

    it('allows the step no other variable, and no env on the job, the workflow or another step', () => {
      const takes = 'stages with the env';
      expect(problemsOf(mutated('          SUMS: ${{', '          NODE_OPTIONS: --require /tmp/x.js\n          SUMS: ${{', 'stage'))).toContain(takes);
      expect(problemsOf(mutated('          NPM_CONFIG_USERCONFIG', '          NPM_CONFIG_REGISTRY: https://example.com\n          NPM_CONFIG_USERCONFIG', 'stage'))).toContain(takes);
      expect(problemsOf(mutated('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    env:\n      NODE_OPTIONS: --require /tmp/x.js\n', 'stage'))).toContain('has an env: besides');
      expect(problemsOf(mutated('          package-manager-cache: false # the action\'s default restores a pnpm store by itself\n', '          package-manager-cache: false\n        env:\n          HTTPS_PROXY: http://example.com\n', 'stage'))).toContain('has an env: besides');
      expect(problemsOf(mutated('\njobs:\n', '\nenv:\n  NODE_OPTIONS: --require /tmp/x.js\n\njobs:\n'))).toContain('an env: for the whole workflow');
    });

    it('stages every tarball with provenance, the public access and the guard’s dist-tag, and only one of the version', () => {
      expect(problemsOf(mutated(' --provenance', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(' --tag="$DIST_TAG"', '', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated(' --tag="$DIST_TAG"', ' --tag=latest', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('"$TARBALLS/$name"', '"$TARBALLS"/*.tgz', 'stage'))).toContain(wanted);
      expect(problemsOf(mutated('          test "${name%-"$VERSION".tgz}" != "$name"\n', '', 'stage'))).toContain(wanted);
    });

    it('takes the hash, the version and the dist-tag from the build job’s outputs', () => {
      const takes = 'takes SUMS, VERSION and DIST_TAG of the staging from the build job';
      expect(problemsOf(mutated('SUMS: ${{ needs.build.outputs.sums }}', 'SUMS: ${{ needs.build.outputs.version }}', 'stage'))).toContain(takes);
      expect(problemsOf(mutated('VERSION: ${{ needs.build.outputs.version }}', 'VERSION: 1.0.0', 'stage'))).toContain(takes);
      expect(problemsOf(mutated('DIST_TAG: ${{ needs.build.outputs.dist-tag }}', 'DIST_TAG: latest', 'stage'))).toContain(takes);
      expect(problemsOf(mutated('TARBALLS: ${{ runner.temp }}/tarballs', 'TARBALLS: /tmp', 'stage'))).toContain(takes);
    });
  });

  describe('the release job', () => {
    it('starts with the release commit’s checkout', () => {
      expect(problemsOf(mutated('          ref: ${{ needs.build.outputs.commit }}\n', '', 'release'))).toContain('starts by checking out the release commit');
      expect(problemsOf(mutated('ref: ${{ needs.build.outputs.commit }}', 'ref: main', 'release'))).toContain('starts by checking out the release commit');
      expect(problemsOf(mutated('ref: ${{ needs.build.outputs.commit }}', 'ref: ${{ github.sha }}', 'release'))).toContain('starts by checking out the release commit');
    });

    it('installs nothing and uses nothing but actions/* — setup-node without a cache', () => {
      const setup = '      - uses: ' + setupNode + '\n        with:\n          node-version-file: .nvmrc\n';
      const afterSetup = (step: string) => mutated(setup, `${setup}${step}`, 'release');
      expect(problemsOf(afterSetup('      - run: pnpm install --frozen-lockfile\n'))).toContain('installs or runs a package');
      expect(problemsOf(afterSetup('      - run: npx something\n'))).toContain('installs or runs a package');
      expect(problemsOf(afterSetup('      - uses: ' + pnpmSha + '\n'))).toContain('the job "release" uses pnpm/action-setup');
      expect(problemsOf(afterSetup('      - uses: actions/cache@v4\n'))).toContain('the job "release" uses actions/cache@v4');
      expect(problemsOf(afterSetup('      - uses: ' + checkoutPin + '\n        with:\n          persist-credentials: false\n'))).toContain(`the job "release" uses ${checkoutPin.split(' ')[0]}`);
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
      expect(problemsOf(mutated('COMMIT: ${{ needs.build.outputs.commit }}', 'COMMIT: ${{ github.sha }}', 'release'))).toContain('tags "$COMMIT"');
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
      expect(problemsOf(mutated('      - uses: ' + setupNode + '\n        with:\n          node-version-file: .nvmrc\n', `      - uses: ${setupNode}\n        env:\n          ${token}\n        with:\n          node-version-file: .nvmrc\n`, 'release'))).toContain('github.token outside');
    });

    it('is no job-level or workflow-level env', () => {
      expect(problemsOf(mutated('    timeout-minutes: 10\n', `    timeout-minutes: 10\n    env:\n      ${token}\n`))).toContain('github.token outside');
      expect(problemsOf(mutated('    timeout-minutes: 30\n', `    timeout-minutes: 30\n    env:\n      ${token}\n`))).toContain('github.token outside');
      expect(problemsOf(mutated('\npermissions:\n  contents: read\n', `\nenv:\n  ${token}\n\npermissions:\n  contents: read\n`))).toContain('github.token outside');
    });
  });
});

describe('checkCiWorkflow — the pins of ci.yml', () => {
  const real = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const problemsOf = (workflow: string) => {
    const directory = repositoryWith(unreleased);
    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(join(directory, '.github/workflows/ci.yml'), workflow);
    return checkCiWorkflow(directory).join('\n');
  };

  it('passes the repository’s workflow', () => {
    expectProblems(checkCiWorkflow(root), []);
  });

  it('refuses a missing file', () => {
    expect(checkCiWorkflow(repositoryWith(unreleased)).join()).toContain('is missing');
  });

  it('refuses an action on a tag, whichever way the key is written', () => {
    const pinned = pinOf(real, 'actions/checkout');
    expect(problemsOf(real.replace(pinned, 'actions/checkout@v5'))).toContain('"actions/checkout@v5" is not pinned to a commit');
    expect(problemsOf(real.replace(/uses: actions\/checkout@[0-9a-f]{40}/, '"uses": actions/checkout@v5'))).toContain('is not pinned to a commit');
    expect(problemsOf(real.replace(/uses: actions\/checkout@[0-9a-f]{40}/, 'uses : actions/checkout@main'))).toContain('is not pinned to a commit');
  });

  it('refuses a checkout that keeps the token', () => {
    expect(problemsOf(real.replace('persist-credentials: false', 'fetch-depth: 1'))).toContain('without "persist-credentials: false"');
  });

  it('refuses a cache save that is not limited to main', () => {
    expect(problemsOf(real.replace("github.ref == 'refs/heads/main' && ", ''))).toContain('actions/cache/save step without');
  });

  it('refuses a setup-node that restores or saves a cache by itself', () => {
    expect(problemsOf(real.replace('package-manager-cache: false', 'cache: pnpm'))).toContain('actions/setup-node step needs');
    expect(problemsOf(real.replace('          package-manager-cache: false\n', ''))).toContain('actions/setup-node step needs');
  });

  it('refuses the combined cache action, which a pull request would write', () => {
    expect(problemsOf(real.replace('actions/cache/restore@', 'actions/cache@'))).toContain('a pull request would write the cache');
  });
});

describe('checkLabelWorkflow — the release label check', () => {
  const real = readFileSync(join(root, '.github/workflows/pr-label.yml'), 'utf8');
  const checkoutPin = pinOf(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), 'actions/checkout');

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

  it.each([['uses:'], ['"uses":'], ['uses :']])('refuses a step written with %s', (key) => {
    expect(problemsOf(mutated('    steps:\n', `    steps:\n      - ${key} actions/checkout@v5\n`))).toContain('a "uses:" step');
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
    const checkout = '    steps:\n      - uses: ' + checkoutPin + '\n';
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
      const directory = tempDir('marmeon-check-release-');
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

describe('checkApiLabelWorkflow — the API label check', () => {
  const real = readFileSync(join(root, '.github/workflows/api-label.yml'), 'utf8');

  /** A repository with the real workflow and scripts, the workflow replaced by `workflow` and a script by `scripts`. */
  function repositoryWithApi(workflow: string, scripts: Record<string, string> = {}): string {
    const directory = repositoryWith(unreleased);
    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    writeFileSync(join(directory, '.github/workflows/api-label.yml'), workflow);
    for (const name of ['api-label.ts', 'api-snapshot.ts']) {
      writeFileSync(join(directory, 'scripts', name), scripts[name] ?? readFileSync(join(root, 'scripts', name), 'utf8'));
    }
    return directory;
  }
  /** The real workflow with `from` replaced — a mutation that did not change anything is a broken test, not a pass. */
  function mutated(from: string, to: string): string {
    const result = real.replace(from, to);
    expect(result, `the mutation of ${from} changed nothing`).not.toBe(real);
    return result;
  }
  const problemsOf = (workflow: string, scripts?: Record<string, string>) => checkApiLabelWorkflow(repositoryWithApi(workflow, scripts)).join('\n');
  const realScript = (name: string) => readFileSync(join(root, 'scripts', name), 'utf8');

  it('passes the repository’s workflow', () => {
    expectProblems(checkApiLabelWorkflow(root), []);
  });

  it('refuses a missing workflow and a missing script', () => {
    expect(checkApiLabelWorkflow(repositoryWith(unreleased)).join()).toContain('is missing');
    const directory = repositoryWithApi(real);
    rmSync(join(directory, 'scripts/api-label.ts'));
    expect(checkApiLabelWorkflow(directory).join()).toContain('scripts/api-label.ts is missing');
  });

  it('refuses pull_request_target and any further event', () => {
    expect(problemsOf(mutated('  pull_request:\n', '  pull_request_target:\n'))).toContain('exactly the pull_request event');
    expect(problemsOf(mutated('on:\n', 'on:\n  push:\n'))).toContain('exactly the pull_request event');
  });

  it('wants every type, and no other', () => {
    expect(problemsOf(mutated('reopened, ', ''))).toContain('the pull_request types must be');
    expect(problemsOf(mutated('unlabeled]', 'unlabeled, edited]'))).toContain('the pull_request types must be');
  });

  it('wants permissions: {} on top and nothing but contents: read in the job', () => {
    expect(problemsOf(mutated('permissions: {}', 'permissions: write-all'))).toContain('must be "{}"');
    expect(problemsOf(mutated('permissions: {}', 'permissions:\n  contents: read'))).toContain('must be "{}"');
    expect(problemsOf(mutated('      contents: read\n', '      contents: write\n'))).toContain('more than "contents: read" (contents: write)');
    expect(problemsOf(mutated('      contents: read\n', '      contents: read\n      id-token: write\n'))).toContain('(id-token: write)');
    expect(problemsOf(mutated('    permissions:\n      contents: read\n', '    permissions: write-all\n'))).toContain('(write-all)');
    expect(problemsOf(mutated('    permissions:\n      contents: read\n', ''))).toContain('must say "permissions: contents: read"');
  });

  it('wants every action pinned by SHA and only the checkout and setup-node', () => {
    expect(problemsOf(mutated(/actions\/checkout@[0-9a-f]{40}/.exec(real)![0], 'actions/checkout@v7'))).toContain('"actions/checkout@v7" is not pinned');
    expect(problemsOf(mutated(/actions\/setup-node@[0-9a-f]{40}/.exec(real)![0], 'actions/setup-node@v7'))).toContain('"actions/setup-node@v7" is not pinned');
    const pinned = '      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413\n      - uses: actions/setup-node';
    expect(problemsOf(mutated('      - uses: actions/setup-node', pinned))).toContain('only actions/checkout and actions/setup-node');
  });

  it('wants persist-credentials: false and fetch-depth: 0 on the checkout', () => {
    expect(problemsOf(mutated('          persist-credentials: false\n', ''))).toContain('without "persist-credentials: false"');
    expect(problemsOf(mutated('          persist-credentials: false\n', '          persist-credentials: true\n'))).toContain('without "persist-credentials: false"');
    expect(problemsOf(mutated('          fetch-depth: 0\n', ''))).toContain('"fetch-depth: 0"');
  });

  it('wants setup-node without a cache', () => {
    expect(problemsOf(mutated('          package-manager-cache: false\n', ''))).toContain('"package-manager-cache: false"');
    expect(problemsOf(mutated('          package-manager-cache: false\n', '          package-manager-cache: false\n          cache: pnpm\n'))).toContain('no "cache:"');
  });

  it('refuses a package manager in a script, an install, and any other script', () => {
    const step = (run: string) => mutated('        run: node scripts/api-label.ts\n', `        run: ${run}\n`);
    expect(problemsOf(step('pnpm install && node scripts/api-label.ts'))).toContain('a package manager in a run script');
    expect(problemsOf(step('npm ci'))).toContain('a package manager in a run script');
    expect(problemsOf(step('corepack enable'))).toContain('a package manager in a run script');
    expect(problemsOf(step('node scripts/other.ts'))).toContain('a run script other than');
    expect(problemsOf(mutated('        run: node scripts/api-label.ts\n', '        run: node scripts/api-label.ts\n      - run: pnpm install\n'))).toContain('exactly one run script');
  });

  it('refuses an expression inside a script', () => {
    expect(problemsOf(mutated('        run: node scripts/api-label.ts\n', '        run: node scripts/api-label.ts ${{ github.head_ref }}\n'))).toContain('an expression inside a run script');
    expect(problemsOf(mutated('        run: node scripts/api-label.ts\n', '        run: |\n          echo "${{ github.event.pull_request.title }}"\n          node scripts/api-label.ts\n'))).toContain('an expression inside a run script');
  });

  it('refuses a secret and the token', () => {
    const env = (line: string) => mutated('        run: node', `          ${line}\n        run: node`);
    expect(problemsOf(env('TOKEN: ${{ secrets.TOKEN }}'))).toContain('a secret or the token');
    expect(problemsOf(env('TOKEN: ${{ github.token }}'))).toContain('a secret or the token');
    expect(problemsOf(env('TOKEN: ${{ github["token"] }}'))).toContain('a secret or the token');
    expect(problemsOf(env('ALL: ${{ toJSON(secrets) }}'))).toContain('a secret or the token');
    expect(problemsOf(mutated('    steps:\n', '    steps:\n      - name: x # GITHUB_TOKEN\n        run: true\n'))).not.toContain('a secret or the token');
  });

  it('wants the labels and the base commit in env from the event and the job named after the required check', () => {
    expect(problemsOf(mutated('toJSON(github.event.pull_request.labels.*.name)', 'toJSON(github.event.pull_request.title)'))).toContain('LABELS must be');
    expect(problemsOf(mutated('        run: node', '          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n        run: node'))).toContain('first parent');
    expect(problemsOf(mutated('name: api label', 'name: label'))).toContain('named "api label"');
  });

  it('lets the script load only node:* and its snapshot module', () => {
    const label = realScript('api-label.ts');
    const withImport = (line: string) => `${line}\n${label}`;
    expect(problemsOf(real, { 'api-label.ts': withImport("import { parse } from 'oxc-parser';") })).toContain('imports "oxc-parser"');
    expect(problemsOf(real, { 'api-label.ts': withImport("import { frameworkPackages } from './packages.ts';") })).toContain('imports "./packages.ts"');
    expect(problemsOf(real, { 'api-label.ts': withImport("export { x } from 'left-pad';") })).toContain('imports "left-pad"');
    expect(problemsOf(real, { 'api-label.ts': withImport("await import('hono');") })).toContain('imports "hono"');
    expect(problemsOf(real, { 'api-label.ts': withImport("import 'side-effect';") })).toContain('imports "side-effect"');
    expect(problemsOf(real, { 'api-snapshot.ts': `import { x } from './packages.ts';\n${realScript('api-snapshot.ts')}` })).toContain('scripts/api-snapshot.ts imports "./packages.ts"');
    expect(problemsOf(real, { 'api-snapshot.ts': `import { x } from './api-label.ts';\n${realScript('api-snapshot.ts')}` })).toContain('scripts/api-snapshot.ts imports "./api-label.ts"');
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

describe('checkCanaryWorkflow — the scheduled Kysely canary', () => {
  const real = readFileSync(join(root, '.github/workflows/kysely-canary.yml'), 'utf8');

  function repositoryWithCanary(workflow: string): string {
    const directory = repositoryWith(unreleased);
    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(join(directory, '.github/workflows/kysely-canary.yml'), workflow);
    return directory;
  }
  /** The real workflow with `from` replaced — a mutation that did not change anything is a broken test, not a pass. */
  function mutated(from: string, to: string): string {
    const result = real.replace(from, to);
    expect(result, `the mutation of ${from} changed nothing`).not.toBe(real);
    return result;
  }
  const problemsOf = (workflow: string) => checkCanaryWorkflow(repositoryWithCanary(workflow)).join('\n');
  const build = "      - if: steps.kysely.outputs.run == 'true'\n        run: pnpm build\n";

  it('passes the repository’s workflow', () => {
    expectProblems(checkCanaryWorkflow(root), []);
  });

  it('refuses a missing workflow', () => {
    expect(checkCanaryWorkflow(repositoryWith(unreleased)).join()).toContain('is missing');
  });

  it('refuses a pull request, a push and any other event, and wants the schedule', () => {
    for (const event of ['pull_request', 'push', 'pull_request_target']) {
      expect(problemsOf(mutated('  workflow_dispatch:\n', `  workflow_dispatch:\n  ${event}:\n`))).toContain('exactly schedule and workflow_dispatch');
    }
    expect(problemsOf(mutated("  schedule:\n    - cron: '17 5 * * 1'\n", ''))).toContain('exactly schedule and workflow_dispatch');
  });

  it('wants empty workflow permissions and nothing but contents: read in the job', () => {
    expect(problemsOf(mutated('permissions: {}', 'permissions:\n  contents: read'))).toContain('must be "{}"');
    expect(problemsOf(mutated('      contents: read\n', '      contents: write\n'))).toContain('more than "contents: read"');
    expect(problemsOf(mutated('      contents: read\n', '      contents: read\n      id-token: write\n'))).toContain('more than "contents: read"');
    expect(problemsOf(mutated('    permissions:\n      contents: read\n', ''))).toContain('must say "permissions: contents: read"');
  });

  it('wants every action pinned by its full SHA', () => {
    expect(problemsOf(mutated('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7'))).toContain('is not pinned to a commit');
    expect(problemsOf(mutated('pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413', 'pnpm/action-setup@ea17c68'))).toContain('is not pinned to a commit');
  });

  it('refuses a cache action, saving or restoring, and any other action', () => {
    const sha = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
    expect(problemsOf(mutated(build, `      - uses: actions/cache@${sha}\n        with:\n          path: x\n          key: y\n${build}`))).toContain('only actions/checkout');
    expect(problemsOf(mutated(build, `      - uses: actions/cache/save@${sha}\n${build}`))).toContain('only actions/checkout');
    expect(problemsOf(mutated(build, `      - uses: actions/cache/restore@${sha}\n${build}`))).toContain('only actions/checkout');
    expect(problemsOf(mutated(build, `      - uses: somebody/else@0123456789abcdef0123456789abcdef01234567\n${build}`))).toContain('only actions/checkout');
  });

  it('wants the checkout to leave no credentials behind', () => {
    expect(problemsOf(mutated('          persist-credentials: false\n', ''))).toContain('without "persist-credentials: false"');
    expect(problemsOf(mutated('          persist-credentials: false\n', '          persist-credentials: true\n'))).toContain('without "persist-credentials: false"');
  });

  it('wants setup-node without a cache', () => {
    expect(problemsOf(mutated('          package-manager-cache: false\n', ''))).toContain('"package-manager-cache: false"');
    expect(problemsOf(mutated('          package-manager-cache: false\n', '          package-manager-cache: false\n          cache: pnpm\n'))).toContain('no "cache:"');
  });

  it('refuses a secret and the token', () => {
    const env = (line: string) => mutated('        env:\n          VERSION', `        env:\n          ${line}\n          VERSION`);
    expect(problemsOf(env('TOKEN: ${{ secrets.TOKEN }}'))).toContain('a secret or the token');
    expect(problemsOf(env('TOKEN: ${{ github.token }}'))).toContain('a secret or the token');
    expect(problemsOf(env('TOKEN: ${{ secrets.GITHUB_TOKEN }}'))).toContain('a secret or the token');
  });

  it('refuses a cache input of any action, pnpm/action-setup included', () => {
    const pnpmSetup = 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413';
    expect(problemsOf(mutated(`${pnpmSetup} # v6.1.0, the version from "packageManager"\n`, `${pnpmSetup}\n        with:\n          cache: true\n`))).toContain('may not read or write a cache');
    expect(problemsOf(mutated(`${pnpmSetup} # v6.1.0, the version from "packageManager"\n`, `${pnpmSetup}\n        with:\n          cache_save: true\n`))).toContain('may not read or write a cache');
    expect(problemsOf(mutated('package-manager-cache: false', 'package-manager-cache: true'))).toContain('may not read or write a cache');
  });

  it('refuses an override of the release-age gate and the trust policy', () => {
    const update = 'pnpm -r --filter "./packages/*" update "kysely@$VERSION"';
    for (const override of ['--config.minimum-release-age=0', '--config.trust-policy=off', '--minimum-release-age=0', 'minimumReleaseAge=0', 'trustPolicy: off']) {
      expect(problemsOf(mutated(update, `${update} ${override}`)), override).toContain('an override of the release-age gate');
    }
    expect(problemsOf(mutated('        env:\n          VERSION', '        env:\n          pnpm_config_minimum_release_age: 0\n          VERSION'))).toContain('an override of the release-age gate');
    expect(problemsOf(mutated(update, `pnpm config set minimum-release-age 0 && ${update}`))).toContain('an override of the release-age gate');
  });

  it('refuses a script that changes pnpm-workspace.yaml but not one that reads it', () => {
    const update = 'pnpm -r --filter "./packages/*" update "kysely@$VERSION"';
    for (const write of ["sed -i '/^minimum/d' pnpm-workspace.yaml", "sed -ni '1p' pnpm-workspace.yaml", 'echo x > pnpm-workspace.yaml', 'echo x >> pnpm-workspace.yaml', 'rm pnpm-workspace.yaml', 'tee pnpm-workspace.yaml </dev/null']) {
      expect(problemsOf(mutated(update, `${write}\n          ${update}`).replace('run: ' + write, 'run: |\n          ' + write)), write).toContain('changes pnpm-workspace.yaml');
    }
    expect(problemsOf(mutated(update, `cat pnpm-workspace.yaml\n          ${update}`))).not.toContain('changes pnpm-workspace.yaml');
  });

  it('allows no expression but a step output', () => {
    const env = (line: string) => mutated('        env:\n          VERSION', `        env:\n          ${line}\n          VERSION`);
    expect(problemsOf(env('CTX: ${{ toJSON(github) }}'))).toContain('only ${{ steps.<id>.outputs.<name> }} is allowed');
    expect(problemsOf(env('OS: ${{ runner.os }}'))).toContain('only ${{ steps.<id>.outputs.<name> }} is allowed');
  });

  it('refuses an expression inside a script', () => {
    expect(problemsOf(mutated('update "kysely@$VERSION"', 'update "kysely@${{ steps.kysely.outputs.version }}"'))).toContain('an expression inside a run script');
  });
});
