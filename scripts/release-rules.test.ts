import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bumpFor,
  bumpVersion,
  CATEGORIES,
  fromLine,
  formatChangelog,
  isBreakingRelease,
  lineOf,
  maintenanceLine,
  parseChangelog,
  parseVersion,
  releaseCommit,
  releaseConfig,
  releaseSection,
  releaseTarget,
  spawnRunner,
  UNLABELLED,
  upgradesFrom,
} from './release-rules.ts';
import { tempDir } from './test/temp-dir.js';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('.github/release.yml', () => {
  it('is what releaseConfig() makes', () => {
    expect(readFileSync(join(root, '.github/release.yml'), 'utf8')).toBe(releaseConfig());
  });

  it('excludes internal, lists the four titles in order and ends with the catch-all', () => {
    const config = releaseConfig();
    expect(config).toContain('labels: [internal]');
    const titles = [...config.matchAll(/- title: (.+)/g)].map((match) => match[1]);
    expect(titles).toEqual([...CATEGORIES.flatMap((category) => (category.title ? [category.title] : [])), UNLABELLED]);
    expect(titles).toHaveLength(5);
    expect(config.trimEnd().endsWith("labels: ['*']")).toBe(true);
  });
});

describe('versions', () => {
  it('bumps by the labels', () => {
    const none = { breaking: false, feature: false };
    expect(bumpVersion('0.1.2', bumpFor('0.1.2', none))).toBe('0.1.3');
    expect(bumpVersion('0.1.2', bumpFor('0.1.2', { breaking: false, feature: true }))).toBe('0.1.3');
    expect(bumpVersion('0.1.2', bumpFor('0.1.2', { breaking: true, feature: false }))).toBe('0.2.0');
    expect(bumpVersion('1.2.3', bumpFor('1.2.3', { breaking: false, feature: true }))).toBe('1.3.0');
    expect(bumpVersion('1.2.3', bumpFor('1.2.3', { breaking: true, feature: true }))).toBe('2.0.0');
    expect(bumpVersion('1.2.3', bumpFor('1.2.3', none))).toBe('1.2.4');
  });

  it.each(['0.1', '01.2.3', '0.2.0-beta.1', 'v0.1.2', '1.2.3.4', ' 1.2.3', '1.2.3\n'])('refuses %j', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });

  it('parses a plain version', () => {
    expect(parseVersion('0.1.2')).toEqual([0, 1, 2]);
  });

  it.each(['0.2.0', '1.0.0', '2.0.0'])('%s is a breaking release', (version) => expect(isBreakingRelease(version)).toBe(true));
  it.each(['0.1.0', '0.2.1', '1.1.0'])('%s is not', (version) => expect(isBreakingRelease(version)).toBe(false));

  it.each([
    ['0.2.0', '0.1.3', true],
    ['0.2.0', '0.0.9', false],
    ['0.3.0', '0.1.3', false],
    ['1.0.0', '0.7.2', true],
    ['1.0.0', '1.0.1', false],
    ['2.0.0', '1.8.4', true],
    ['2.0.0', '0.9.0', false],
    ['0.2.1', '0.1.3', false],
  ])('upgradesFrom(%s, %s) is %s', (version, from, expected) => expect(upgradesFrom(version, from)).toBe(expected));

  it('names the line an upgrade starts from', () => {
    expect(fromLine('0.2.0')).toBe('0.1.x');
    expect(fromLine('1.0.0')).toBe('0.x');
    expect(fromLine('3.0.0')).toBe('2.x');
    expect(() => fromLine('0.1.5')).toThrow('not a breaking release');
  });
});

describe('lines and branches', () => {
  it.each([
    ['0.1.4', '0.1'],
    ['0.12.0', '0.12'],
    ['1.8.4', '1'],
    ['2.3.0', '2'],
  ])('lineOf(%s) is %s', (version, line) => expect(lineOf(version)).toBe(line));

  it.each([
    ['0.1.x', '0.1'],
    ['1.x', '1'],
    ['2.x', '2'],
    ['10.x', '10'],
    ['0.x', undefined],
    ['1.2.x', undefined],
    ['v0.1.x', undefined],
    ['01.x', undefined],
    ['0.01.x', undefined],
    ['main', undefined],
    ['feature/x', undefined],
  ])('maintenanceLine(%s) is %s', (branch, line) => expect(maintenanceLine(branch)).toBe(line));
});

describe('releaseTarget', () => {
  const allowed: [string, string, string | undefined, string, boolean][] = [
    ['main', '0.1.3', '0.1.2', 'latest', true],
    ['0.1.x', '0.1.4', '0.2.0', 'latest-0.1', false],
    ['1.x', '1.8.4', '2.3.0', 'latest-1', false],
    ['main', '2.4.0', '2.3.0', 'latest', true],
    ['2.x', '2.3.1', '2.3.0', 'latest', true],
    ['main', '0.1.0', undefined, 'latest', true],
  ];
  it.each(allowed)('%s releases %s over latest %s as %s (marked latest: %s)', (branch, version, latest, distTag, markLatest) => {
    expect(releaseTarget({ branch, version, latest })).toEqual({ ok: true, distTag, markLatest });
  });

  const refused: [string, string, string | undefined, string[]][] = [
    ['1.x', '1.0.1', undefined, ['1.x', 'no latest', 'main']],
    ['2.x', '1.8.4', '2.3.0', ['2.x', '1.8.4', '1.x']],
    ['main', '1.8.4', '2.3.0', ['main', '1.8.4', 'latest 2.3.0']],
    ['0.1.x', '0.2.1', '0.2.0', ['0.1.x', '0.2.1', '0.2.x']],
    ['1.x', '2.0.1', '2.3.0', ['1.x', '2.0.1', '2.x']],
    ['main', '0.1.2', '0.1.2', ['main', '0.1.2', 'latest']],
    ['feature/x', '0.1.3', '0.1.2', ['feature/x', '0.1.3', '0.1.x']],
    ['0.x', '0.1.3', '0.1.2', ['0.x', '0.1.3', '0.1.x']],
    ['1.2.x', '1.2.5', '2.0.0', ['1.2.x', '1.2.5', '1.x']],
    ['main', '0.2.0-beta.1', '0.1.2', ['main', '0.2.0-beta.1', 'x.y.z']],
    ['main', '0.2.1', '0.2.0-beta.1', ['main', '0.2.1', '0.2.0-beta.1']],
    ['0.2.x', '0.2.1', '0.1.03', ['0.2.x', '0.2.1', '0.1.03']],
  ];
  it.each(refused)('refuses %s releasing %s over latest %s', (branch, version, latest, mentions) => {
    const target = releaseTarget({ branch, version, latest });
    expect(target.ok).toBe(false);
    for (const text of mentions) expect(target.ok ? '' : target.problem).toContain(text);
  });
});

describe('releaseCommit', () => {
  /** A repository on `main`; `git` runs a command in it, committing as a fixed identity. */
  function repository() {
    const dir = tempDir('marmeon-release-rules-');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    git('init', '-q', '-b', 'main');
    write('README.md', 'start\n');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    return { dir, git, write };
  }

  /** A pull request merged with a merge commit: `path` written on a side branch. */
  function merge(repo: ReturnType<typeof repository>, name: string, path: string, text: string) {
    repo.git('switch', '-q', '-c', name);
    repo.write(path, text);
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', name);
    repo.git('switch', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', `Merge ${name}`, name);
    return repo.git('rev-parse', 'HEAD');
  }

  it('is the merge that changed a changelog, not the head after it', () => {
    const repo = repository();
    const release = merge(repo, 'release', 'packages/core/CHANGELOG.md', '# core\n\n## 0.1.3\n');
    merge(repo, 'later', 'packages/core/src/index.ts', 'export {};\n');
    expect(releaseCommit(spawnRunner(repo.dir))).toBe(release);
  });

  it('counts a changelog change on a merged side branch only through its merge', () => {
    const repo = repository();
    repo.git('switch', '-q', '-c', 'side');
    repo.write('packages/core/CHANGELOG.md', '# core\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'changelog on the side');
    repo.git('switch', '-q', 'main');
    repo.write('other.txt', 'x\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'other');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const mergeCommit = repo.git('rev-parse', 'HEAD');
    expect(releaseCommit(spawnRunner(repo.dir))).toBe(mergeCommit);
  });

  it('ignores a nested CHANGELOG.md added after the release', () => {
    const repo = repository();
    const release = merge(repo, 'release', 'packages/x/CHANGELOG.md', '# x\n');
    merge(repo, 'later', 'packages/x/sub/CHANGELOG.md', '# template\n');
    expect(releaseCommit(spawnRunner(repo.dir))).toBe(release);
  });

  it('moves to a merge that changed only the release base, and not to a later unrelated commit', () => {
    const repo = repository();
    merge(repo, 'release', 'packages/core/CHANGELOG.md', '# core\n\n## 0.1.3\n');
    merge(repo, 'internal', 'other.txt', 'x\n');
    const again = merge(repo, 'prepare-again', '.github/release-base', `0.1.3 ${'a'.repeat(40)}\n`);
    expect(releaseCommit(spawnRunner(repo.dir))).toBe(again);
    merge(repo, 'later', 'packages/core/src/index.ts', 'export {};\n');
    expect(releaseCommit(spawnRunner(repo.dir))).toBe(again);
  });

  it('throws when no commit changed a changelog', () => {
    const repo = repository();
    expect(() => releaseCommit(spawnRunner(repo.dir))).toThrow('No release commit');
  });
});

describe('changelogs', () => {
  it('round-trips the repository changelog', () => {
    const text = readFileSync(join(root, 'packages/cli/CHANGELOG.md'), 'utf8');
    const parsed = parseChangelog(text);
    expect(parsed.title).toBe('# marmeon\n\n');
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(formatChangelog(parsed)).toBe(text);
  });

  it('refuses a heading that is not a version, showing a trailing space', () => {
    expect(() => parseChangelog('# core\n\n## Unreleased\n')).toThrow('line 3');
    expect(() => parseChangelog('# core\n\n## 0.1.3 \n')).toThrow('"## 0.1.3 "');
  });

  it.each([['CRLF', '# core\r\n\r\n## 0.1.3\r\n\r\n- A\r\n'], ['a last heading without a newline', '# core\n\n## 0.1.3\n\n- A\n\n## 0.1.2']])(
    'round-trips %s',
    (_name, text) => expect(formatChangelog(parseChangelog(text))).toBe(text),
  );
});

describe('releaseSection', () => {
  /** A repository with a `CHANGELOG.md` per package, `bodies` by package directory. */
  function changelogs(bodies: Record<string, string>) {
    const dir = tempDir('marmeon-release-rules-');
    for (const [short, body] of Object.entries(bodies)) {
      mkdirSync(join(dir, 'packages', short), { recursive: true });
      writeFileSync(join(dir, 'packages', short, 'package.json'), JSON.stringify({ name: `@marmeon/${short}`, version: '0.1.3' }));
      writeFileSync(join(dir, 'packages', short, 'CHANGELOG.md'), `# ${short}\n\n## 0.1.3\n${body}\n## 0.1.2\n\nold\n`);
    }
    return dir;
  }

  it('returns the shared body, trimmed', () => {
    expect(releaseSection(changelogs({ core: '\n### Fixes\n\n- A fix\n', http: '\n### Fixes\n\n- A fix\n' }), '0.1.3')).toBe('### Fixes\n\n- A fix');
  });

  it('names a package without the section', () => {
    expect(() => releaseSection(changelogs({ core: '\n- A\n', http: '\n- A\n' }), '0.1.4')).toThrow('@marmeon/core, @marmeon/http');
  });

  it('names a package whose body differs', () => {
    expect(() => releaseSection(changelogs({ core: '\n- A\n', http: '\n- B\n' }), '0.1.3')).toThrow(/@marmeon\/http differs from @marmeon\/core/);
  });
});
