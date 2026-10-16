import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Commands, compare, parseStageList, releaseVerify, tarballName } from './release-verify.ts';

const sha512 = (data: string) => createHash('sha512').update(data).digest('hex');
const SHA = 'a'.repeat(40);
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

interface Setup {
  /** Rebuilt tarballs: file name → contents. */
  rebuilt: Record<string, string>;
  /** Staged items: id → package, version and the contents npm holds. */
  staged: Record<string, { packageName: string; version: string; contents: string }>;
  listOutput?: string;
  failBuild?: boolean;
  /** SHA512SUMS claims the hash of these contents for every rebuilt file instead of the file's own. */
  sumsClaim?: string;
  /** How many tarballs `npm stage download` writes (default 1). */
  downloads?: number;
}

function fake(setup: Setup) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let tmp = '';
  const commands: Commands = {
    capture(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (command === 'git') return `${SHA}\n`;
      return (
        setup.listOutput ??
        JSON.stringify(Object.entries(setup.staged).map(([id, item]) => ({ id, packageName: item.packageName, version: item.version })))
      );
    },
    run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (command === 'git' && args[1] === 'add') {
        tmp = dirname(args[3]!);
        mkdirSync(args[3]!, { recursive: true });
      }
      if (args[0] === 'build' && setup.failBuild) throw new Error('build broke');
      if (command === 'node') {
        const directory = args[1]!;
        mkdirSync(directory, { recursive: true });
        let sums = '';
        for (const [file, contents] of Object.entries(setup.rebuilt)) {
          writeFileSync(join(directory, file), contents);
          sums += `${sha512(setup.sumsClaim ?? contents)}  ${file}\n`;
        }
        writeFileSync(join(directory, 'SHA512SUMS'), sums);
      }
      if (command === 'npm' && args[1] === 'download') {
        const item = setup.staged[args[2]!]!;
        const name = `${item.packageName.replace(/^@/, '').replace('/', '-')}-${item.version}-${args[2]}.tgz`;
        for (let n = 0; n < (setup.downloads ?? 1); n++) writeFileSync(join(cwd, n === 0 ? name : `extra${n}-${name}`), item.contents);
      }
    },
  };
  return { commands, calls, tmp: () => tmp };
}

const pkg = (packageName: string, contents: string) => ({ packageName, version: '1.2.3', contents });

describe('tarballName', () => {
  it('maps a scoped and an unscoped package to the file name pnpm pack writes', () => {
    expect(tarballName('@marmeon/core', '1.2.3')).toBe('marmeon-core-1.2.3.tgz');
    expect(tarballName('marmeon', '1.2.3')).toBe('marmeon-1.2.3.tgz');
  });
});

describe('parseStageList', () => {
  it('reads the items and refuses anything else', () => {
    expect(parseStageList(JSON.stringify([{ id: ID1, packageName: 'marmeon', version: '1.0.0', tag: 'latest' }]))).toEqual([
      { id: ID1, packageName: 'marmeon', version: '1.0.0' },
    ]);
    expect(() => parseStageList('not json')).toThrow('did not print JSON');
    expect(() => parseStageList('{}')).toThrow('not print an array');
    expect(() => parseStageList(JSON.stringify([{ id: ID1, packageName: 'marmeon' }]))).toThrow('without a string');
    expect(() => parseStageList(JSON.stringify([null]))).toThrow('without a string');
    expect(() => parseStageList(JSON.stringify([{ id: '../x', packageName: 'marmeon', version: '1.0.0' }]))).toThrow('not a UUID');
  });
});

describe('compare', () => {
  it('classifies match, difference, missing rebuild and unstaged tarball', () => {
    const entries = compare(
      [
        { id: ID1, packageName: 'marmeon', version: '1.2.3', sha512: 'aa' },
        { id: ID2, packageName: '@marmeon/core', version: '1.2.3', sha512: 'bb' },
        { id: ID2, packageName: '@marmeon/gone', version: '1.2.3', sha512: 'cc' },
      ],
      new Map([
        ['marmeon-1.2.3.tgz', 'aa'],
        ['marmeon-core-1.2.3.tgz', 'zz'],
        ['marmeon-extra-1.2.3.tgz', 'dd'],
      ]),
    );
    expect(entries.map((entry) => [entry.file, entry.outcome])).toEqual([
      ['marmeon-1.2.3.tgz', 'match'],
      ['marmeon-core-1.2.3.tgz', 'differs'],
      ['marmeon-gone-1.2.3.tgz', 'not-rebuilt'],
      ['marmeon-extra-1.2.3.tgz', 'not-staged'],
    ]);
  });
});

describe('releaseVerify', () => {
  const root = '/repo';
  const run = (setup: Setup) => {
    const f = fake(setup);
    const lines: string[] = [];
    const result = releaseVerify(root, 'v1', f.commands, (line) => lines.push(line));
    return { ...f, lines, result };
  };

  it('is ok when every staged tarball is the rebuilt one', () => {
    const { result, lines } = run({
      rebuilt: { 'marmeon-1.2.3.tgz': 'a', 'marmeon-core-1.2.3.tgz': 'b' },
      staged: { [ID1]: pkg('marmeon', 'a'), [ID2]: pkg('@marmeon/core', 'b') },
    });
    expect(result.ok).toBe(true);
    expect(result.sha).toBe(SHA);
    expect(lines.join('\n')).toContain(`✓ marmeon-core-1.2.3.tgz  matches (stage ${ID2})`);
    expect(lines.join('\n')).toContain('approve them on npmjs.com');
  });

  it('runs the commands in order, in the worktree, and packs into <tmp>/tarballs', () => {
    const { calls, tmp } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a') } });
    const source = join(tmp(), 'source');
    expect(calls.slice(0, 6)).toEqual([
      { command: 'git', args: ['rev-parse', '--verify', 'v1^{commit}'], cwd: root },
      { command: 'git', args: ['worktree', 'add', '--detach', source, SHA], cwd: root },
      { command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: source },
      { command: 'pnpm', args: ['run', 'clean'], cwd: source },
      { command: 'pnpm', args: ['build'], cwd: source },
      { command: 'node', args: ['scripts/release-pack.ts', join(tmp(), 'tarballs')], cwd: source },
    ]);
    expect(calls.at(-2)).toEqual({ command: 'git', args: ['worktree', 'remove', '--force', source], cwd: root });
    expect(calls.at(-1)).toEqual({ command: 'git', args: ['worktree', 'prune'], cwd: root });
    const download = calls.find((call) => call.args[1] === 'download')!;
    expect(download.cwd).toBe(join(tmp(), 'staged', ID1));
  });

  it('reports a differing hash and names every staged id to reject', () => {
    const { result, lines } = run({
      rebuilt: { 'marmeon-1.2.3.tgz': 'a' },
      staged: { [ID1]: pkg('marmeon', 'tampered') },
    });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain(`✗ marmeon-1.2.3.tgz  differs (stage ${ID1}): staged sha512 ${sha512('tampered').slice(0, 16)}…`);
    expect(lines.join('\n')).toContain('do not approve');
    expect(lines.join('\n')).toContain(`npm stage reject ${ID1}`);
  });

  it('fails on a staged package without a rebuilt counterpart', () => {
    const { result, lines } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a'), [ID2]: pkg('@marmeon/evil', 'x') } });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain('@marmeon/evil@1.2.3  staged');
    expect(lines.join('\n')).toContain('the rebuild has no marmeon-evil-1.2.3.tgz');
  });

  it('hashes the rebuilt files itself instead of trusting SHA512SUMS', () => {
    const { result, lines } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'tampered' }, staged: { [ID1]: pkg('marmeon', 'a') }, sumsClaim: 'a' });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain('differs');
  });

  it('throws when npm stage download writes no tarball, or two', () => {
    expect(() => run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a') }, downloads: 0 })).toThrow('wrote 0 tarballs');
    expect(() => run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a') }, downloads: 2 })).toThrow('wrote 2 tarballs');
  });

  it('fails when one of two stage ids for the same version is tampered', () => {
    const { result, lines } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a'), [ID2]: pkg('marmeon', 'bad') } });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain(`✗ marmeon-1.2.3.tgz  differs (stage ${ID2})`);
    expect(lines.join('\n')).toContain(`npm stage reject ${ID2}`);
  });

  it('separates staged packages outside the rebuild from the ones to reject', () => {
    const { lines } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'bad' }, staged: { [ID1]: pkg('marmeon', 'a'), [ID2]: pkg('other-thing', 'x') } });
    const text = lines.join('\n');
    expect(text).toContain(`npm stage reject ${ID1}`);
    expect(text).not.toContain(`npm stage reject ${ID2}`);
    expect(text).toContain(`other-thing@1.2.3  (stage ${ID2})`);
    expect(text).toContain('check them before rejecting');
  });

  it('refuses an option as the commit, and a non-SHA resolution', () => {
    const f = fake({ rebuilt: {}, staged: {} });
    expect(() => releaseVerify(root, '--help', f.commands, () => undefined)).toThrow('looks like an option');
    expect(f.calls).toEqual([]);
    const odd: Commands = { capture: () => 'zzz\n', run: () => undefined };
    expect(() => releaseVerify(root, 'v1', odd, () => undefined)).toThrow('not a commit SHA');
  });

  it('fails on a rebuilt tarball that is not staged', () => {
    const { result, lines } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a', 'marmeon-core-1.2.3.tgz': 'b' }, staged: { [ID1]: pkg('marmeon', 'a') } });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain('✗ marmeon-core-1.2.3.tgz  rebuilt, but not staged');
  });

  it('throws when nothing is staged, and on malformed list output', () => {
    expect(() => run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: {} })).toThrow('nothing is staged');
    expect(() => run({ rebuilt: {}, staged: {}, listOutput: '{"id":1}' })).toThrow('not print an array');
  });

  it('removes the worktree and the temporary directory on success', () => {
    const { calls, tmp } = run({ rebuilt: { 'marmeon-1.2.3.tgz': 'a' }, staged: { [ID1]: pkg('marmeon', 'a') } });
    expect(calls.some((call) => call.args[1] === 'remove')).toBe(true);
    expect(existsSync(tmp())).toBe(false);
  });

  it('removes them when the build throws', () => {
    const f = fake({ rebuilt: {}, staged: {}, failBuild: true });
    expect(() => releaseVerify(root, 'v1', f.commands, () => undefined)).toThrow('build broke');
    expect(f.calls.some((call) => call.args[1] === 'remove')).toBe(true);
    expect(existsSync(f.tmp())).toBe(false);
    expect(basename(f.tmp())).toMatch(/^marmeon-release-verify-/);
  });

  it('says so when the commit does not resolve, and starts nothing', () => {
    const commands: Commands = {
      capture: () => {
        throw new Error('bad');
      },
      run: () => {
        throw new Error('must not run');
      },
    };
    expect(() => releaseVerify(root, 'nope', commands, () => undefined)).toThrow('not a commit in this repository');
  });
});
