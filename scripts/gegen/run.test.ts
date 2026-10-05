import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/temp-dir.js';
import { escapeTestName } from './run.ts';

/**
 * `pnpm gegen` (E188) against a fixture repository under $TMPDIR — a git checkout with a function, its test and a step of
 * Gegenproben — so the runner's guarantees are proven without touching this checkout: anchors first, the patch taken back (also on
 * SIGINT), 0 tests never counted, the reason by the message, the control.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const RUNNER = join(here, 'run.ts');
const VITEST = join(root, 'node_modules/.bin/vitest');
const DEFINE = pathToFileURL(join(here, 'define.ts')).href;

const MATH = 'export const add = (a, b) => a + b;\n';
const OTHER = 'export const twice = (a) => a * 2;\n';
const CASES = `import { defineGegenproben } from '${DEFINE}';

const breakAdd = { file: 'src/math.js', find: 'a + b', replace: 'a - b' };
const test = { vitest: 'math.test.js', name: 'adds (two) numbers' };

export default defineGegenproben({
  step: 'F1.1',
  cases: [
    { id: 'R1', title: 'add broken', patch: [breakAdd], run: test, expect: /expected -1 to be 3/ },
    { id: 'A1', title: 'two files, the second anchor missing', patch: [breakAdd, { file: 'src/other.js', find: 'a * 5', replace: 'a * 3' }], run: test, expect: /expected -1 to be 3/ },
    { id: 'W1', title: 'a reason that does not match', patch: [breakAdd], run: test, expect: /expected 4 to be 3/ },
    { id: 'Z1', title: 'a name no test has', patch: [breakAdd], run: { vitest: 'math.test.js', name: 'adds (three) numbers' }, expect: /expected -1 to be 3/ },
    { id: 'N1', title: 'a patch the test does not see', patch: [{ file: 'src/other.js', find: 'a * 2', replace: 'a * 3' }], run: test, expect: /expected/ },
    { id: 'M1', title: 'a masking probe', patch: [{ file: 'src/other.js', find: 'a * 2', replace: 'a * 3' }], run: test, expectGreen: true },
    { id: 'C1', title: 'a command', patch: [breakAdd], run: { command: ['node', 'check.js'] }, expect: /add is broken: -1/ },
    { id: 'S1', title: 'a slow run', patch: [breakAdd], run: { command: ['node', '-e', 'console.log("started"); setTimeout(() => {}, 60000)'] }, expect: /never/ },
    { id: 'T1', title: 'a run that writes a file', patch: [breakAdd], run: { command: ['node', '-e', 'require("node:fs").writeFileSync("stray.txt", "x")'] }, expect: /never/ },
  ],
});
`;

interface Fixture {
  readonly repo: string;
  readonly cases: string;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function fixture(): Fixture {
  const base = tempDir('bespoke-gegen-fixture-');
  const repo = join(base, 'repo');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'gegen-fixture', private: true, type: 'module', scripts: { test: `${VITEST} run --globals` } }),
    '.gitignore': 'node_modules\n',
    'src/math.js': MATH,
    'src/other.js': OTHER,
    'math.test.js': `import { add } from './src/math.js';\nimport { twice } from './src/other.js';\n\nit('adds (two) numbers', () => {\n  expect(add(1, 2)).toBe(3);\n});\n\nit('doubles', () => {\n  expect(twice(2)).toBe(4);\n});\n`,
    'check.js': `import { add } from './src/math.js';\nif (add(1, 2) !== 3) {\n  console.error('add is broken: ' + add(1, 2));\n  process.exit(1);\n}\n`,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  const cases = join(base, 'cases');
  mkdirSync(join(cases, 'w1'), { recursive: true });
  writeFileSync(join(cases, 'w1', 's01-fixture.ts'), CASES);
  return { repo, cases };
}

/** The runner's environment without the variables of the Vitest these tests run in. */
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(VITEST|TINYPOOL)/.test(key)) env[key] = value;
  return env;
}

function gegen({ repo, cases }: Fixture, ...args: string[]): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [RUNNER, ...args, '--cases', cases, '--repo', repo], { encoding: 'utf8', env: environment(), timeout: 90_000 });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const untouched = ({ repo }: Fixture) => {
  expect(readFileSync(join(repo, 'src/math.js'), 'utf8')).toBe(MATH);
  expect(readFileSync(join(repo, 'src/other.js'), 'utf8')).toBe(OTHER);
  expect(git(repo, ['status', '--porcelain'])).toBe('');
};

describe('pnpm gegen — the Gegenproben runner (E188)', { timeout: 120_000 }, () => {
  it('escapes a test name for -t: parentheses and dots are text, not a regex', () => {
    expect(escapeTestName('onOneServer() runs once. [a]')).toBe('onOneServer\\(\\) runs once\\. \\[a\\]');
  });

  it('a case turns red for its reason — the name with () is escaped for -t, the patch is taken back', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'R1');
    expect(output).toContain('✓ red (reason matches): AssertionError: expected -1 to be 3');
    expect(output).toContain('F1.1: 1 of 1 red (reason matches)');
    expect(code).toBe(0);
    untouched(repo);
  });

  it('a missing anchor in a two-file patch changes nothing — not even the file whose anchor is there', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'A1');
    expect(output).toContain('anchor problem — nothing was patched: src/other.js: the anchor "a * 5" occurs 0 times');
    expect(code).toBe(1);
    untouched(repo);
  });

  it('a name filter that matches no test is "0 tests" — never red, never green', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'Z1');
    expect(output).toContain('✗ 0 tests ran (aborted — check the name filter)');
    expect(code).toBe(1);
    untouched(repo);
  });

  it('a failure with another message is "red for another reason", not counted as red', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'W1');
    expect(output).toContain('✗ red for another reason: AssertionError: expected -1 to be 3');
    expect(output).toContain('F1.1: 0 of 1 red (reason matches)');
    expect(code).toBe(1);
    untouched(repo);
  });

  it('a measure without effect is GREEN — and a masking probe must stay green, counted apart', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'N1', 'M1');
    expect(output).toContain('✗ GREEN — the measure has no effect!');
    expect(output).toContain('✓ green, as a masking probe must be');
    expect(output).toContain('F1.1: 0 of 1 red (reason matches), 1 of 1 masking probes as expected');
    expect(code).toBe(1);
    untouched(repo);
  });

  it('a command case is red by its exit code, its reason in its output', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'C1');
    expect(output).toContain('✓ red (reason matches): add is broken: -1');
    expect(code).toBe(0);
    untouched(repo);
  });

  it('SIGINT in the middle of a run stops it and takes the patch back', async () => {
    const repo = fixture();
    const child = spawn(process.execPath, [RUNNER, 'w1/s01', 'S1', '--cases', repo.cases, '--repo', repo.repo], { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const deadline = Date.now() + 30_000;
    while (!output.includes('▶ F1.1 S1') && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 20));
    // The command runs: the patch is in place.
    while (readFileSync(join(repo.repo, 'src/math.js'), 'utf8') === MATH && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 20));
    expect(readFileSync(join(repo.repo, 'src/math.js'), 'utf8')).toContain('a - b');
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(output).toContain('SIGINT — stopped; 1 patched file(s) taken back');
    untouched(repo);
  });

  it('a run that writes a file no patch touched stops the runner loudly (exit 3)', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, 'w1/s01', 'T1');
    expect(output).toContain('STOPPED — git status changed during the run');
    expect(output).toContain('?? stray.txt');
    expect(code).toBe(3);
    expect(readFileSync(join(repo.repo, 'src/math.js'), 'utf8')).toBe(MATH);
  });

  it('the control runs without the patches: every case green — and 0 tests still fails it', () => {
    const repo = fixture();
    const green = gegen(repo, 'w1/s01', 'R1', 'M1', 'C1', '--control');
    expect(green.output).toContain('F1.1 control: 3 of 3 green');
    expect(green.code).toBe(0);
    const zero = gegen(repo, 'w1/s01', 'Z1', '--control');
    expect(zero.output).toContain('0 tests ran');
    expect(zero.code).toBe(1);
    untouched(repo);
    expect(existsSync(join(repo.repo, 'stray.txt'))).toBe(false);
  });

  it('lists waves, steps and cases', () => {
    const repo = fixture();
    const { code, output } = gegen(repo, '--list');
    expect(output).toContain('w1/s01  F1.1 — 9 case(s)');
    expect(output).toContain('M1    a masking probe (masking probe)');
    expect(code).toBe(0);
  });
});
