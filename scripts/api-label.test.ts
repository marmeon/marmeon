import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatProblems, isShippedMigration, labelProblems, migrationProblems, migrationSourceProblems } from './api-label.ts';
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

describe('formatProblems', () => {
  const path = 'packages/queue/src/__fixtures__/formats/job/v1.json';
  const change = (status: string, file = path) => [{ status, path: file }];

  it('lets a new fixture through and refuses a changed, deleted or renamed one', () => {
    expect(formatProblems(change('A'), ['fix'])).toEqual([]);
    for (const status of ['M', 'D', 'R100', 'R087', 'T', 'X']) {
      const [message, ...rest] = formatProblems(change(status), ['fix']);
      expect(rest, status).toEqual([]);
      expect(message, status).toContain(`changes the fixture ${path} of a stored or wire format`);
    }
  });

  it('is satisfied by "breaking", and "api-compatible" never lifts it', () => {
    expect(formatProblems(change('M'), ['breaking'])).toEqual([]);
    expect(formatProblems(change('D'), ['breaking', 'api-compatible'])).toEqual([]);
    expect(formatProblems(change('M'), ['fix', 'api-compatible'])).toHaveLength(1);
    expect(formatProblems(change('R100'), [])).toHaveLength(1);
  });

  it('names every fixture it refuses', () => {
    expect(formatProblems([...change('M'), ...change('D', 'packages/http/src/__fixtures__/formats/page/v1.json'), ...change('A', 'x')], ['feature'])).toHaveLength(2);
  });
});

describe('migrationProblems', () => {
  const directory = 'packages/queue/stubs/migrations';
  const shipped = (dir: string) => (dir === directory ? ['2026_01_01_000000_create_jobs_table.ts', '2026_02_01_000000_add_queue_column.ts'] : []);
  const at = (status: string, name: string) => [{ status, path: `${directory}/${name}` }];

  it('refuses a changed, deleted or renamed migration', () => {
    for (const status of ['M', 'D', 'T', 'R100', 'C090']) {
      const [message, ...rest] = migrationProblems(at(status, '2026_01_01_000000_create_jobs_table.ts'), shipped);
      expect(rest, status).toEqual([]);
      expect(message, status).toContain(`${directory}/2026_01_01_000000_create_jobs_table.ts: a migration a package ships never changes or goes`);
    }
  });

  it('lets a file through that sorts after every shipped one, and one in a new directory', () => {
    expect(migrationProblems(at('A', '2026_03_01_000000_add_priority.ts'), shipped)).toEqual([]);
    expect(migrationProblems([{ status: 'A', path: 'packages/audit/stubs/migrations/2020_01_01_000000_create_audit_table.ts' }], shipped)).toEqual([]);
  });

  it('refuses a new file that sorts before a shipped one and names the first it precedes', () => {
    const [message, ...rest] = migrationProblems(at('A', '2026_01_15_000000_add_priority.ts'), shipped);
    expect(rest).toEqual([]);
    expect(message).toBe(`${directory}/2026_01_15_000000_add_priority.ts sorts before 2026_02_01_000000_add_queue_column.ts, which is already shipped: name it after every file in its directory`);
  });
});

describe('migrationSourceProblems', () => {
  const manifest = (from?: string) => JSON.stringify({ name: 'x', ...(from === undefined ? {} : { marmeon: { migrations: { format: 2, module: 'x', from } } }) });
  const change = (before: string | undefined, after: string | undefined) => [{ path: 'packages/x/package.json', before, after }];

  it('refuses a changed or removed from, and nothing else', () => {
    expect(migrationSourceProblems(change(manifest('stubs/migrations'), manifest('stubs/other')))).toHaveLength(1);
    expect(migrationSourceProblems(change(manifest('stubs/migrations'), manifest()))).toHaveLength(1);
    expect(migrationSourceProblems(change(manifest('stubs/migrations'), undefined))).toHaveLength(1);
    expect(migrationSourceProblems(change(manifest('stubs/migrations'), manifest('stubs/migrations')))).toEqual([]);
    expect(migrationSourceProblems(change(manifest(), manifest('stubs/migrations')))).toEqual([]);
    expect(migrationSourceProblems(change(undefined, manifest('stubs/migrations')))).toEqual([]);
  });
});

describe('the directories packages ship migrations from', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('lie under the files the check holds', () => {
    for (const name of readdirSync(join(root, 'packages'))) {
      let manifest: { marmeon?: { migrations?: { from?: unknown } } };
      try {
        manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      const from = manifest.marmeon?.migrations?.from;
      if (from === undefined) continue;
      expect(typeof from, name).toBe('string');
      expect(isShippedMigration(`packages/${name}/${String(from).replace(/^\.\//, '').replace(/\/$/, '')}/2026_01_01_000000_x.ts`), `${name}: ${String(from)}`).toBe(true);
    }
  });

  it('recognises where a stub may sit', () => {
    expect(isShippedMigration('packages/queue/stubs/migrations/a.ts')).toBe(true);
    expect(isShippedMigration('packages/auth/stubs/react/modules/auth/migrations/a.ts')).toBe(true);
    expect(isShippedMigration('packages/queue/src/migrations/a.ts')).toBe(false);
    expect(isShippedMigration('packages/queue/migrations/a.ts')).toBe(false);
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

  describe('fixtures of formats', () => {
    const fixture = 'packages/queue/src/__fixtures__/formats/job/v1.json';
    const other = 'packages/queue/src/__fixtures__/job.json';

    /** A merge commit whose base holds the two files above and whose pull request applies `change`. */
    function withFixtures(change: (directory: string, git: (...args: string[]) => string) => void) {
      const directory = tempDir('marmeon-api-label-');
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      for (const file of [fixture, other]) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), '{"v":1,"padding":"a record long enough for git to see a rename"}\n');
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      change(directory, git);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
      git('checkout', '-q', 'main');
      writeFileSync(join(directory, 'README.md'), 'x');
      git('add', '-A');
      git('commit', '-q', '-m', 'merged meanwhile');
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      return (labels: string[]) => {
        const result = spawnSync('node', [script], { cwd: directory, env: { PATH: process.env.PATH, LABELS: JSON.stringify(labels) }, encoding: 'utf8' });
        return { status: result.status, out: result.stdout + result.stderr };
      };
    }

    it('lets a new fixture and a change outside formats/ through', () => {
      const run = withFixtures((directory) => {
        writeFileSync(join(directory, fixture.replace('v1', 'v2')), '{"v":2}\n');
        writeFileSync(join(directory, other), '{"v":9}\n');
      });
      expect(run(['internal']).status).toBe(0);
    });

    it('fails a changed, deleted or renamed fixture without "breaking", and "api-compatible" does not help', () => {
      const changed = withFixtures((directory) => writeFileSync(join(directory, fixture), '{"v":1,"padding":"changed"}\n'));
      const deleted = withFixtures((_directory, git) => git('rm', '-q', fixture));
      const renamed = withFixtures((_directory, git) => git('mv', fixture, fixture.replace('v1', 'v1-old')));
      for (const run of [changed, deleted, renamed]) {
        const result = run(['fix', 'api-compatible']);
        expect(result.status).toBe(1);
        expect(result.out).toContain(`::error title=API label::changes the fixture ${fixture} of a stored or wire format`);
        expect(run(['breaking']).status).toBe(0);
      }
    });
  });

  describe('shipped migrations', () => {
    const stubs = ['packages/queue/stubs/migrations', 'packages/auth/stubs/react/modules/auth/migrations'];
    const first = (directory: string) => `${directory}/2026_01_01_000000_create_things_table.ts`;
    const manifest = (from?: string) => JSON.stringify({ name: 'x', ...(from === undefined ? {} : { marmeon: { migrations: { format: 2, module: 'x', from } } }) });

    /** A merge commit whose base ships a migration in each of `stubs` and one in `src/`, and whose pull request applies `change`. */
    function withMigrations(change: (directory: string, git: (...args: string[]) => string) => void) {
      const directory = tempDir('marmeon-api-label-');
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      for (const file of [...stubs.map(first), 'packages/queue/src/migrations/2026_01_01_000000_inside.ts']) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), 'export const up = () => 1;\n'.repeat(5));
      }
      // Files in the stub directory that are not migrations: a README and a folder.
      writeFileSync(join(directory, 'packages/queue/stubs/migrations/README.md'), 'x\n');
      mkdirSync(join(directory, 'packages/queue/stubs/migrations/zz'), { recursive: true });
      writeFileSync(join(directory, 'packages/queue/stubs/migrations/zz/a.ts'), 'x\n');
      writeFileSync(join(directory, 'packages/queue/package.json'), manifest('stubs/migrations'));
      mkdirSync(join(directory, 'packages/cache'), { recursive: true });
      writeFileSync(join(directory, 'packages/cache/package.json'), manifest());
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      change(directory, git);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'change');
      git('checkout', '-q', 'main');
      writeFileSync(join(directory, 'README.md'), 'x');
      git('add', '-A');
      git('commit', '-q', '-m', 'merged meanwhile');
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      return (labels: string[]) => {
        const result = spawnSync('node', [script], { cwd: directory, env: { PATH: process.env.PATH, LABELS: JSON.stringify(labels) }, encoding: 'utf8' });
        return { status: result.status, out: result.stdout + result.stderr };
      };
    }

    it('lets a later file, a file in a new directory and a change outside the stubs through', () => {
      const run = withMigrations((directory) => {
        for (const stub of stubs) writeFileSync(join(directory, stub, '2026_02_01_000000_add_column.ts'), 'x\n');
        mkdirSync(join(directory, 'packages/audit/stubs/migrations'), { recursive: true });
        writeFileSync(join(directory, 'packages/audit/stubs/migrations/2020_01_01_000000_create_audit_table.ts'), 'x\n');
        writeFileSync(join(directory, 'packages/queue/src/migrations/2026_01_01_000000_inside.ts'), 'changed\n');
        writeFileSync(join(directory, 'packages/queue/package.json'), JSON.stringify({ name: 'x', version: '2', marmeon: { migrations: { format: 2, module: 'x', from: 'stubs/migrations' } } }));
        writeFileSync(join(directory, 'packages/cache/package.json'), manifest('stubs/migrations'));
      });
      expect(run(['internal']).status).toBe(0);
    });

    it('counts only the .ts files of a directory as shipped', () => {
      // The README and the folder in the base sort after the new file; neither is a migration.
      const run = withMigrations((directory) => writeFileSync(join(directory, 'packages/queue/stubs/migrations/2026_02_01_000000_add_column.ts'), 'x\n'));
      expect(run(['fix']).status).toBe(0);
    });

    it('fails a package.json that changes or drops the directory a package ships from', () => {
      const moved = withMigrations((directory) => writeFileSync(join(directory, 'packages/queue/package.json'), manifest('stubs/elsewhere')));
      const dropped = withMigrations((directory) => writeFileSync(join(directory, 'packages/queue/package.json'), manifest()));
      for (const run of [moved, dropped]) {
        const result = run(['breaking', 'api-compatible']);
        expect(result.status).toBe(1);
        expect(result.out).toContain('::error title=API label::packages/queue/package.json: marmeon.migrations.from');
      }
    });

    it('fails a new file that repeats a name of its own directory, and lets one through that another directory of the package has', () => {
      const same = 'packages/queue/stubs/migrations/2026_05_01_000000_create_things_table.ts';
      const elsewhere = 'packages/queue/stubs/other/migrations/2026_05_01_000000_create_things_table.ts';
      const repeated = withMigrations((directory) => writeFileSync(join(directory, same), 'x\n'));
      const result = repeated(['breaking']);
      expect(result.status).toBe(1);
      expect(result.out).toContain(`${same} repeats the name of 2026_01_01_000000_create_things_table.ts`);
      const shared = withMigrations((directory) => {
        mkdirSync(dirname(join(directory, elsewhere)), { recursive: true });
        writeFileSync(join(directory, elsewhere), 'x\n');
      });
      expect(shared(['fix']).status).toBe(0);
    });

    it('fails a new symlink among the migrations', () => {
      const link = 'packages/queue/stubs/migrations/2026_02_01_000000_link.ts';
      const run = withMigrations((directory) => symlinkSync('2026_01_01_000000_create_things_table.ts', join(directory, link)));
      const result = run(['breaking']);
      expect(result.status).toBe(1);
      expect(result.out).toContain(`${link}: a migration is a regular file`);
    });

    it('fails a changed, deleted or renamed migration whatever the labels say', () => {
      for (const stub of stubs) {
        const changed = withMigrations((directory) => writeFileSync(join(directory, first(stub)), 'changed\n'));
        const deleted = withMigrations((_directory, git) => git('rm', '-q', first(stub)));
        const renamed = withMigrations((_directory, git) => git('mv', first(stub), `${stub}/2026_01_01_000000_make_things_table.ts`));
        for (const run of [changed, deleted, renamed]) {
          const result = run(['breaking', 'api-compatible']);
          expect(result.status).toBe(1);
          expect(result.out).toContain(`::error title=API label::${first(stub)}: a migration a package ships never changes or goes`);
        }
      }
    }, 30_000);

    it('fails a new file that sorts before a shipped one', () => {
      const early = 'packages/queue/stubs/migrations/2025_12_01_000000_early.ts';
      const run = withMigrations((directory) => writeFileSync(join(directory, early), 'x\n'));
      const result = run(['breaking']);
      expect(result.status).toBe(1);
      expect(result.out).toContain(`${early} sorts before 2026_01_01_000000_create_things_table.ts, which is already shipped`);
    });
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
