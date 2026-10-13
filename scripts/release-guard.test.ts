import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guard, outputLines } from './release-guard.ts';
import { formatReleaseBase, RELEASE_BASE, spawnRunner, type Runner } from './release-rules.ts';
import { tempDir } from './test/temp-dir.js';

type Answer = { status: number | null; stdout?: string; stderr?: string };

const NOT_FOUND = JSON.stringify({ error: { code: `E${404}`, summary: 'not found' } });
const COMMIT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function writePackage(root: string, short: string, name: string, version: string, section = `## ${version}\n\n### Fixes\n\n- Fix a thing by @max in https://example.com/pull/1\n`) {
  mkdirSync(join(root, 'packages', short), { recursive: true });
  writeFileSync(join(root, 'packages', short, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(root, 'packages', short, 'CHANGELOG.md'), `# ${name}\n\n${section}`);
}

function writeBase(root: string, version: string, commit: string) {
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, RELEASE_BASE), formatReleaseBase(version, commit));
}

/** Two published packages at `version`. */
function fixture(version: string) {
  const root = tempDir('marmeon-release-guard-');
  writePackage(root, 'core', '@marmeon/core', version);
  writePackage(root, 'mail', '@marmeon/mail', version);
  writeBase(root, version, BASE);
  return root;
}

interface Fake {
  /** Answers by command line; a key present here replaces the happy-path answer. */
  readonly answers: Record<string, Answer>;
}

/** A runner for git and npm that answers by command line (happy path unless `answers` says otherwise) and records the calls. */
function fakeRun({ answers }: Fake, latest: string | 'not-found' | 'network' = '0.1.2', calls: string[] = []): Runner {
  return (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    const answer: Answer | undefined =
      answers[line] ??
      (line === 'git rev-parse --is-shallow-repository'
        ? { status: 0, stdout: 'false\n' }
        : line.startsWith('git log -1 --first-parent')
          ? { status: 0, stdout: `${COMMIT}\n` }
          : line === `git rev-parse ${COMMIT}^1`
            ? { status: 0, stdout: `${BASE}\n` }
            : line === `git diff --name-only ${BASE} ${COMMIT}`
              ? { status: 0, stdout: 'packages/core/package.json\npackages/core/CHANGELOG.md\nUPGRADING.md\n.github/release-base\n' }
              : line.startsWith('git rev-list --count')
              ? { status: 0, stdout: '3\n' }
              : line.startsWith('git checkout')
            ? { status: 0 }
            : line.startsWith('git ls-remote')
              ? { status: 2 }
              : line === 'npm view @marmeon/core dist-tags.latest --json'
                ? latest === 'not-found'
                  ? { status: 1, stdout: NOT_FOUND }
                  : latest === 'network'
                    ? { status: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request failed' }
                    : { status: 0, stdout: JSON.stringify(latest) }
                : line.startsWith('npm view ')
                  ? { status: 1, stdout: NOT_FOUND }
                  : undefined);
    if (!answer) throw new Error(`unexpected command: ${line}`);
    return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  };
}

const none: Fake = { answers: {} };
const onMain = { refType: 'branch', branch: 'main' };

describe('guard on a fake runner', () => {
  it('passes on main for the next version and hands over commit, version, dist-tag and the latest flag', () => {
    const root = fixture('0.1.3');
    const result = guard({ root, ...onMain, run: fakeRun(none) });
    expect(result).toEqual({ problems: [], commit: COMMIT, version: '0.1.3', distTag: 'latest', markLatest: true });
    expect(outputLines(result)).toEqual([`commit=${COMMIT}`, 'version=0.1.3', 'dist-tag=latest', 'latest=true']);
  });

  it('takes the dist-tag from releaseTarget for a maintenance release under a newer latest', () => {
    const result = guard({ root: fixture('0.1.4'), refType: 'branch', branch: '0.1.x', run: fakeRun(none, '0.2.0') });
    expect(result).toMatchObject({ problems: [], distTag: 'latest-0.1', markLatest: false });
    expect(outputLines(result)).toContain('latest=false');
    const second = guard({ root: fixture('1.8.4'), refType: 'branch', branch: '1.x', run: fakeRun(none, '2.3.0') });
    expect(second).toMatchObject({ problems: [], distTag: 'latest-1', markLatest: false });
  });

  it('releases as latest when npm has no latest yet, but never when the lookup fails', () => {
    expect(guard({ root: fixture('0.1.0'), ...onMain, run: fakeRun(none, 'not-found') })).toMatchObject({ problems: [], distTag: 'latest', markLatest: true });
    const failed = guard({ root: fixture('0.1.0'), ...onMain, run: fakeRun(none, 'network') });
    expect(failed.problems.join('\n')).toContain('ENOTFOUND');
    expect(failed.distTag).toBeUndefined();
    expect(outputLines(failed)).toEqual([]);
  });

  it("reaches releaseTarget's refusals", () => {
    const wrongLine = guard({ root: fixture('1.8.4'), refType: 'branch', branch: '2.x', run: fakeRun(none, '2.3.0') });
    expect(wrongLine.problems.join('\n')).toContain('2.x releases 2 versions only');
    expect(wrongLine.distTag).toBeUndefined();
    const belowOnMain = guard({ root: fixture('1.8.4'), ...onMain, run: fakeRun(none, '2.3.0') });
    expect(belowOnMain.problems.join('\n')).toContain('main releases above latest 2.3.0');
    expect(outputLines(belowOnMain)).toEqual([]);
  });

  it('refuses a tag ref and a feature branch before any git call', () => {
    const calls: string[] = [];
    const run = fakeRun(none, '0.1.2', calls);
    expect(guard({ root: fixture('0.1.3'), refType: 'tag', branch: 'v0.1.3', run }).problems[0]).toContain('tag ref');
    expect(guard({ root: fixture('0.1.3'), refType: 'branch', branch: 'feature/x', run }).problems[0]).toContain('maintenance branch');
    expect(calls).toEqual([]);
  });

  it('refuses two versions across the packages and a prerelease', () => {
    const root = fixture('0.1.3');
    writePackage(root, 'mail', '@marmeon/mail', '0.1.2');
    expect(guard({ root, ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('do not share one version');
    expect(guard({ root: fixture('0.1.3-beta.1'), ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('prereleases are not released');
  });

  it('refuses a shallow clone, a branch without a release commit and a failing checkout, and stops there', () => {
    const calls: string[] = [];
    const shallow = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun({ answers: { 'git rev-parse --is-shallow-repository': { status: 0, stdout: 'true\n' } } }, '0.1.2', calls) });
    expect(shallow.problems.join('\n')).toContain('shallow');
    expect(calls).toEqual(['git rev-parse --is-shallow-repository']);

    const noCommit = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun({ answers: { 'git log -1 --first-parent --format=%H -- :(glob)packages/*/CHANGELOG.md .github/release-base': { status: 0, stdout: '' } } }) });
    expect(noCommit.problems.join('\n')).toContain('No release commit');

    const checkoutCalls: string[] = [];
    const failed = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun({ answers: { [`git checkout --quiet --detach ${COMMIT}`]: { status: 1, stderr: 'dirty' } } }, '0.1.2', checkoutCalls) });
    expect(failed.problems.join('\n')).toContain('Could not check out');
    expect(checkoutCalls.some((line) => line.startsWith('git ls-remote') || line.startsWith('npm'))).toBe(false);
  });

  it('refuses a release commit that is not a commit id, before the checkout', () => {
    const calls: string[] = [];
    const run = fakeRun({ answers: { 'git log -1 --first-parent --format=%H -- :(glob)packages/*/CHANGELOG.md .github/release-base': { status: 0, stdout: '--upload-pack=x\n' } } }, '0.1.2', calls);
    expect(guard({ root: fixture('0.1.3'), ...onMain, run }).problems.join('\n')).toContain('is not a commit id');
    expect(calls.some((line) => line.startsWith('git checkout'))).toBe(false);
  });

  it('refuses a version whose tag exists, and a tag lookup that fails', () => {
    const tag = (status: number, stderr = '') => ({ answers: { 'git ls-remote --exit-code --tags origin refs/tags/v0.1.3': { status, stderr } } });
    const taken = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(tag(0)) });
    expect(taken.problems.join('\n')).toContain('v0.1.3 exists');
    expect(taken.distTag).toBeUndefined();
    const broken = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(tag(128, 'fatal: no remote')) });
    expect(broken.problems.join('\n')).toContain('fatal: no remote');
  });

  it('refuses a version a package already has on npm, and any npm answer that is not "not found"', () => {
    const view = (answer: Answer) => ({ answers: { 'npm view @marmeon/mail@0.1.3 version --json': answer } });
    const taken = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(view({ status: 0, stdout: '"0.1.3"\n' })) });
    expect(taken.problems).toEqual(['@marmeon/mail@0.1.3 is already on npm.']);
    const otherError = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(view({ status: 1, stdout: JSON.stringify({ error: { code: 'ETIMEDOUT' } }) })) });
    expect(otherError.problems.join('\n')).toContain('@marmeon/mail@0.1.3 version failed');
    const garbage = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(view({ status: 1, stdout: '<html>bad gateway</html>' })) });
    expect(garbage.problems.join('\n')).toContain('bad gateway');
    const empty = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun(view({ status: 0, stdout: '' })) });
    expect(empty.problems).toHaveLength(1);
    for (const result of [otherError, garbage, empty]) expect(outputLines(result)).toEqual([]);
  });

  it('refuses a release whose first parent is not the commit it was prepared from', () => {
    const moved = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun({ answers: { [`git rev-parse ${COMMIT}^1`]: { status: 0, stdout: `${'c'.repeat(40)}\n` } } }) });
    expect(moved.problems.join('\n')).toContain('main moved after the release was prepared (3 commits) — run pnpm release:prepare again');
    expect(outputLines(moved)).toEqual([]);
  });

  it('refuses a release commit that changes anything but release files, naming it', () => {
    const diff = `git diff --name-only ${BASE} ${COMMIT}`;
    const result = guard({ root: fixture('0.1.3'), ...onMain, run: fakeRun({ answers: { [diff]: { status: 0, stdout: 'packages/core/package.json\npackages/core/src/index.ts\n' } } }) });
    expect(result.problems.join('\n')).toContain('also changes packages/core/src/index.ts — code belongs in its own pull request');
    expect(outputLines(result)).toEqual([]);
  });

  it('refuses a missing, malformed or stale release base', () => {
    const missing = fixture('0.1.3');
    rmSync(join(missing, RELEASE_BASE));
    expect(guard({ root: missing, ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('missing or malformed');
    const malformed = fixture('0.1.3');
    writeFileSync(join(malformed, RELEASE_BASE), '0.1.3 abc\n');
    expect(guard({ root: malformed, ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('missing or malformed');
    const stale = fixture('0.1.3');
    writeBase(stale, '0.1.2', BASE);
    expect(guard({ root: stale, ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('records 0.1.2, the packages are at 0.1.3');
  });

  it('refuses a missing or differing changelog section', () => {
    const root = fixture('0.1.3');
    writePackage(root, 'mail', '@marmeon/mail', '0.1.3', '## 0.1.2\n\nold\n');
    expect(guard({ root, ...onMain, run: fakeRun(none) }).problems.join('\n')).toContain('@marmeon/mail');
  });
});

describe('the script', () => {
  const script = fileURLToPath(new URL('./release-guard.ts', import.meta.url));
  const start = (env: Record<string, string>) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

  it('exits 1 and writes nothing to GITHUB_OUTPUT when the guard refuses', () => {
    const output = join(tempDir('marmeon-release-guard-'), 'output');
    writeFileSync(output, '');
    const result = start({ GITHUB_OUTPUT: output, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.0.0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✗');
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('refuses to run without GITHUB_OUTPUT', () => {
    const result = start({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GITHUB_OUTPUT');
  });
});

describe('guard in a real repository', () => {
  function repository() {
    const dir = tempDir('marmeon-release-guard-');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    writePackage(dir, 'core', '@marmeon/core', '0.1.2');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    const start = git('rev-parse', 'HEAD');
    /** The release pull request's branch: the preparation of 0.1.3 from `start`. */
    git('switch', '-q', '-c', 'release');
    writePackage(dir, 'core', '@marmeon/core', '0.1.3');
    writeBase(dir, '0.1.3', start);
    git('add', '.');
    git('commit', '-q', '-m', 'Prepare 0.1.3');
    git('switch', '-q', 'main');
    return { dir, git, start };
  }

  function run(dir: string): Runner {
    const real = spawnRunner(dir);
    const npm = fakeRun(none);
    return (command, args) => (command === 'git' && args[0] !== 'ls-remote' ? real(command, args) : npm(command, args));
  }

  it('checks out the release commit and reads its version, not the one a later commit set', () => {
    const { dir, git } = repository();
    git('merge', '-q', '--no-ff', '-m', 'Merge release', 'release');
    const release = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'packages/core/package.json'), JSON.stringify({ name: '@marmeon/core', version: '9.9.9' }));
    git('commit', '-q', '-am', 'Later change');

    const result = guard({ root: dir, ...onMain, run: run(dir) });

    expect(result).toMatchObject({ problems: [], commit: release, version: '0.1.3' });
    expect(git('rev-parse', 'HEAD')).toBe(release);
    expect(git('branch', '--show-current')).toBe('');
    expect(JSON.parse(readFileSync(join(dir, 'packages/core/package.json'), 'utf8')).version).toBe('0.1.3');
  });

  it('passes a release squashed onto the commit it was prepared from', () => {
    const { dir, git } = repository();
    git('merge', '-q', '--squash', 'release');
    git('commit', '-q', '-m', 'Release 0.1.3 (#2)');
    expect(guard({ root: dir, ...onMain, run: run(dir) })).toMatchObject({ problems: [], version: '0.1.3' });
  });

  it('refuses a release merged after another pull request landed, however it was merged', () => {
    const merged = repository();
    writeFileSync(join(merged.dir, 'other.txt'), 'x');
    merged.git('add', '.');
    merged.git('commit', '-q', '-m', 'Another pull request');
    merged.git('merge', '-q', '--no-ff', '-m', 'Merge release', 'release');
    const result = guard({ root: merged.dir, ...onMain, run: run(merged.dir) });
    expect(result.problems.join('\n')).toContain('main moved after the release was prepared (1 commit)');

    const squashed = repository();
    writeFileSync(join(squashed.dir, 'other.txt'), 'x');
    squashed.git('add', '.');
    squashed.git('commit', '-q', '-m', 'Another pull request');
    squashed.git('merge', '-q', '--squash', 'release');
    squashed.git('commit', '-q', '-m', 'Release 0.1.3 (#2)');
    expect(guard({ root: squashed.dir, ...onMain, run: run(squashed.dir) }).problems.join('\n')).toContain('main moved after the release was prepared');
  });

  it('refuses a release pull request that also changes code, and passes one that changes release files only', () => {
    const { dir, git } = repository();
    git('switch', '-q', 'release');
    mkdirSync(join(dir, 'packages/core/src'), { recursive: true });
    writeFileSync(join(dir, 'packages/core/src/index.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Sneak in code');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge release', 'release');
    expect(guard({ root: dir, ...onMain, run: run(dir) }).problems.join('\n')).toContain('also changes packages/core/src/index.ts');

    const clean = repository();
    clean.git('merge', '-q', '--no-ff', '-m', 'Merge release', 'release');
    expect(guard({ root: clean.dir, ...onMain, run: run(clean.dir) }).problems).toEqual([]);
  });

  it('releases the merge of a re-run that changed only the base, after an internal pull request moved main', () => {
    const { dir, git } = repository();
    writeFileSync(join(dir, 'internal.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'An internal pull request');
    git('merge', '-q', '--no-ff', '-m', 'Merge release', 'release');
    expect(guard({ root: dir, ...onMain, run: run(dir) }).problems.join('\n')).toContain('moved after the release was prepared');

    git('switch', '-q', '-c', 'prepare-again');
    writeBase(dir, '0.1.3', git('rev-parse', 'main'));
    git('add', '.');
    git('commit', '-q', '-m', 'Release 0.1.3 again');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge release again', 'prepare-again');
    const again = git('rev-parse', 'HEAD');
    expect(guard({ root: dir, ...onMain, run: run(dir) })).toMatchObject({ problems: [], commit: again, version: '0.1.3' });
  });
});
