import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { labelProblems } from './api-label.ts';
import { compareSnapshots, renderSnapshot, type ApiItem, type ApiSection } from './api-snapshot.ts';
import { tempDir } from './test/temp-dir.js';

const item = (name: string, text: string, section: ApiSection = 'stable', entry = '@marmeon/demo'): ApiItem => ({ entry, section, name, text });
const problems = (before: ApiItem[], after: ApiItem[], ...labels: string[]) => labelProblems(compareSnapshots(before, after), labels);

const a = item('a', 'export declare const a: 1;');
const b = item('b', 'export declare const b: 1;');
const a2 = item('a', 'export declare const a: 2;');

describe('labelProblems', () => {
  it('wants "breaking" for a removed entry, and "api-compatible" never helps', () => {
    expect(problems([a, b], [a], 'feature')).toHaveLength(1);
    expect(problems([a, b], [a], 'feature')[0]).toContain('removes @marmeon/demo b');
    expect(problems([a, b], [a], 'breaking')).toEqual([]);
    expect(problems([a, b], [a], 'fix', 'api-compatible')).toHaveLength(1);
    expect(problems([a, b], [a], 'breaking', 'api-compatible')).toEqual([]);
  });

  it('wants "breaking" or "api-compatible" for a changed entry', () => {
    expect(problems([a], [a2], 'fix')).toHaveLength(1);
    expect(problems([a], [a2], 'fix')[0]).toContain('changes @marmeon/demo a');
    expect(problems([a], [a2], 'fix', 'api-compatible')).toEqual([]);
    expect(problems([a], [a2], 'breaking')).toEqual([]);
    expect(problems([a], [a2])).toHaveLength(1);
  });

  it('counts a removed helper type as a change: a rename, or a numbered twin sliding down', () => {
    const opts = item('Opts', 'interface Opts { a: 1 }', 'referenced');
    const fooOptions = item('FooOptions', 'interface FooOptions { a: 1 }', 'referenced');
    const before = [item('foo', 'export declare function foo(o: Opts): void;'), opts];
    const after = [item('foo', 'export declare function foo(o: FooOptions): void;'), fooOptions];
    expect(problems(before, after, 'fix')).toHaveLength(1);
    expect(problems(before, after, 'fix')[0]).toContain('changes');
    expect(problems(before, after, 'fix', 'api-compatible')).toEqual([]);
    expect(problems(before, after, 'breaking')).toEqual([]);
    const twins = [item('X', 'interface X { a: 1 }', 'referenced'), item('X (2)', 'interface X { b: 1 }', 'referenced'), item('X (3)', 'interface X { c: 1 }', 'referenced')];
    expect(problems(twins, twins.slice(0, 2), 'fix', 'api-compatible')).toEqual([]);
    expect(problems(twins, twins.slice(0, 2), 'fix')).toHaveLength(1);
  });

  it('keeps a removed stable, augments, environment or commands item a removal', () => {
    const removals: ApiItem[] = [
      item('s', 'x'),
      item('@marmeon/core.ApplicationDefinition', 'x', 'augments'),
      item('PORT', 'x', 'environment', ''),
      item('demo:run', 'x', 'commands', ''),
    ];
    for (const removal of removals) expect(problems([removal], [], 'fix', 'api-compatible'), removal.section).toHaveLength(1);
  });

  it('refuses a new entry under "docs" and "internal", whatever else is on the pull request', () => {
    expect(problems([a], [a, b], 'internal')).toHaveLength(1);
    expect(problems([a], [a, b], 'docs')).toHaveLength(1);
    expect(problems([a], [a, b], 'docs', 'api-compatible')).toHaveLength(1);
    expect(problems([a], [a, b], 'fix')).toEqual([]);
    expect(problems([a], [a, b], 'feature')).toEqual([]);
    expect(problems([a], [a, b], 'breaking')).toEqual([]);
  });

  it('reports every broken rule at once', () => {
    expect(problems([a, b], [a2, item('c', 'x')], 'internal')).toHaveLength(3);
  });

  it('treats an environment variable and a command like any other entry', () => {
    const env = item('PORT', 'number, default 3000', 'environment', '');
    const loud = item('PORT', 'number, default 8080', 'environment', '');
    expect(problems([env], [loud], 'feature')[0]).toContain('changes environment PORT');
    expect(problems([env], [loud], 'breaking')).toEqual([]);
    const command = item('demo:run', 'Runs the demo.', 'commands', '');
    expect(problems([command], [], 'fix')[0]).toContain('removes commands demo:run');
  });

  it('names at most ten entries and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, index) => item(`n${String(index).padStart(2, '0')}`, 'x'));
    const [message] = problems(many, [], 'fix');
    expect(message).toContain('n09');
    expect(message).not.toContain('n10');
    expect(message).toContain('and 2 more');
  });

  it('puts the package in front of a message', () => {
    expect(labelProblems(compareSnapshots([a], []), ['fix'], '@marmeon/demo')[0]).toMatch(/^@marmeon\/demo: removes /);
  });

  it('asks nothing of a pull request that changes no entry', () => {
    for (const label of ['internal', 'docs', 'fix', 'feature', 'breaking']) expect(problems([a, b], [a, b], label)).toEqual([]);
  });
});

describe('the script', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'api-label.ts');

  const snapshot = (items: ApiItem[]) => renderSnapshot('@marmeon/demo', items, new Map([['@marmeon/demo', []]]));

  /**
   * A repository shaped like the checkout of a pull request: `before` is the base, `after` the pull request's change, `moved`
   * what other pull requests merged into the base since the branch point; `HEAD` is the merge commit of both (`linear`: the
   * change on top of the base, no merge).
   */
  function repository(before: Record<string, ApiItem[]>, after: Record<string, ApiItem[] | null>, moved: Record<string, ApiItem[] | null> = {}, linear = false) {
    const directory = tempDir('marmeon-api-label-');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
    const write = (files: Record<string, ApiItem[] | null>) => {
      for (const [name, items] of Object.entries(files)) {
        const file = join(directory, 'packages', name, 'api.md');
        mkdirSync(dirname(file), { recursive: true });
        if (items === null) git('rm', '-q', '-f', join('packages', name, 'api.md'));
        else writeFileSync(file, snapshot(items));
      }
    };
    git('init', '-q', '-b', 'main');
    write(before);
    writeFileSync(join(directory, 'README.md'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    if (linear) {
      write(after);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
    } else {
      git('checkout', '-q', '-b', 'pr');
      write(after);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
      git('checkout', '-q', 'main');
      write(moved);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'merged meanwhile');
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    }
    const run = (labels: string[]) => {
      const result = spawnSync('node', [script], { cwd: directory, env: { PATH: process.env.PATH, LABELS: JSON.stringify(labels) }, encoding: 'utf8' });
      return { status: result.status, out: result.stdout + result.stderr };
    };
    return { run, directory };
  }

  it('says there is nothing to label when no api.md changed', () => {
    const { run } = repository({ demo: [a] }, {});
    const result = run(['internal']);
    expect(result.status).toBe(0);
    expect(result.out).toContain('api.md: no public change');
  });

  it('fails a removal without "breaking" and names the package and the entry', () => {
    const { run } = repository({ demo: [a, b] }, { demo: [a] });
    const result = run(['feature', 'api-compatible']);
    expect(result.status).toBe(1);
    expect(result.out).toContain('::error title=API label::@marmeon/demo: removes @marmeon/demo b');
    expect(run(['breaking']).status).toBe(0);
  });

  it('lets "api-compatible" cover a change', () => {
    const { run } = repository({ demo: [a] }, { demo: [a2] });
    expect(run(['fix']).status).toBe(1);
    expect(run(['fix', 'api-compatible']).status).toBe(0);
  });

  it('refuses a new entry under "internal", and reads a new file against nothing', () => {
    const { run } = repository({}, { demo: [a] });
    expect(run(['internal']).status).toBe(1);
    expect(run(['feature']).status).toBe(0);
  });

  it('counts a deleted api.md as a removal', () => {
    const { run } = repository({ demo: [a] }, { demo: null });
    expect(run(['fix']).status).toBe(1);
    expect(run(['breaking']).status).toBe(0);
  });

  it('does not enforce the experimental section', () => {
    const probe = item('Probe', 'export declare class Probe {}', 'experimental');
    const { run } = repository({ demo: [a, probe] }, { demo: [a, item('Probe', 'export declare class Probe { x: 1 }', 'experimental')] });
    expect(run(['internal']).status).toBe(0);
    const removed = repository({ demo: [a, probe] }, { demo: [a] });
    expect(removed.run(['internal']).status).toBe(0);
  });

  it('counts a move from stable to experimental as a removal', () => {
    const { run } = repository({ demo: [a, b] }, { demo: [a, item('b', 'export declare const b: 1;', 'experimental')] });
    expect(run(['feature']).status).toBe(1);
    expect(run(['breaking']).status).toBe(0);
  });

  it('refuses malformed labels instead of passing', () => {
    const { directory } = repository({ demo: [a] }, { demo: [a2] });
    const noLabels = spawnSync('node', [script], { cwd: directory, env: { PATH: process.env.PATH, LABELS: '{"fix":1}' }, encoding: 'utf8' });
    expect(noLabels.status).toBe(1);
    expect(noLabels.stdout + noLabels.stderr).toContain('LABELS');
  });

  it('compares with the first parent: what merged into the base since the branch point is not the pull request’s', () => {
    // The base gained b and lost nothing; the pull request itself only touches a README-level nothing.
    const { run } = repository({ demo: [a] }, {}, { demo: [a, b] });
    const result = run(['internal']);
    expect(result.status).toBe(0);
    expect(result.out).toContain('api.md: no public change');
    // The base removed b (another pull request's breaking change); this one changed nothing in demo.
    const removedMeanwhile = repository({ demo: [a, b] }, {}, { demo: [a] });
    expect(removedMeanwhile.run(['fix']).status).toBe(0);
    // A file that exists only on the moved base is no addition of this pull request.
    const newPackage = repository({}, {}, { other: [a] });
    expect(newPackage.run(['internal']).status).toBe(0);
  });

  it('still sees the pull request’s own change on a moved base', () => {
    const { run } = repository({ demo: [a, b] }, { demo: [a] }, { other: [a] });
    expect(run(['fix']).status).toBe(1);
    expect(run(['breaking']).status).toBe(0);
  });

  it('fails clearly when HEAD is not a merge commit', () => {
    const { run } = repository({ demo: [a, b] }, { demo: [a] }, {}, true);
    const result = run(['breaking']);
    expect(result.status).toBe(1);
    expect(result.out).toContain('is not a merge commit with two parents (it has 1)');
  });

  it('fails when git cannot read the base instead of taking the file for new', () => {
    const { run, directory } = repository({ demo: [a, b] }, { demo: [a] });
    const blob = execFileSync('git', ['rev-parse', 'HEAD^1:packages/demo/api.md'], { cwd: directory, encoding: 'utf8' }).trim();
    rmSync(join(directory, '.git/objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    const result = run(['fix']);
    expect(result.status).toBe(1);
    expect(result.out).not.toContain('api.md:');
    expect(result.out).toContain('::error title=API label::');
  });
});
