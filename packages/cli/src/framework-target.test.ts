import { readFileSync } from 'node:fs';
import { CommandArgumentsError } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { PackageManagerProcess, type PackageManagerRun } from './framework/package-manager.ts';
import { decideJump, parseTarget, resolveTarget } from './framework/target.ts';
import { parseVersion, type Version } from './framework/versions.ts';

const v = (text: string): Version => {
  const version = parseVersion(text);
  if (!version) throw new Error(`not a version: ${text}`);
  return version;
};

const fixture = (name: string): string => readFileSync(new URL(`./__fixtures__/registry/${name}`, import.meta.url), 'utf8');

class FakeProcess extends PackageManagerProcess {
  readonly calls: { name: string; args: readonly string[]; options: PackageManagerRun }[] = [];
  readonly #answer: () => Promise<{ code: number; stdout: string }>;
  constructor(answer: () => Promise<{ code: number; stdout: string }>) {
    super();
    this.#answer = answer;
  }
  override run(name: 'pnpm' | 'npm', args: readonly string[], options: PackageManagerRun): Promise<{ code: number; stdout: string }> {
    this.calls.push({ name, args, options });
    return this.#answer();
  }
}

const answering = (stdout: string, code = 0): FakeProcess => new FakeProcess(() => Promise.resolve({ code, stdout }));
const registry = (tags: unknown, versions: unknown): string => JSON.stringify({ 'dist-tags': tags, versions });

describe('parseTarget', () => {
  it('reads no value and "latest" as the latest tag, an exact version, and a tag name', () => {
    expect(parseTarget(undefined)).toEqual({ kind: 'latest' });
    expect(parseTarget('latest')).toEqual({ kind: 'latest' });
    expect(parseTarget('1.2.0')).toEqual({ kind: 'version', version: v('1.2.0') });
    expect(parseTarget('next')).toEqual({ kind: 'tag', tag: 'next' });
    expect(parseTarget('rc-2')).toEqual({ kind: 'tag', tag: 'rc-2' });
  });

  it.each(['^1.2.0', '../x', '1.2', '~1.2.0', 'file:../x', 'npm:evil@1', '1.2.0 --foo', '1.2.0+b', '1.2.0-rc.1+build.5', '--registry=https://evil.test', 'Next', '-next', '', 'next beta', 'git+https://x.test/y'])('refuses %j with exit 2', (value) => {
    expect(() => parseTarget(value)).toThrow(CommandArgumentsError);
  });
});

describe('resolveTarget', () => {
  it.each(['npm-view.json', 'pnpm-view.json'])('resolves latest from the real answer in %s', async (file) => {
    const process = answering(fixture(file));
    const result = await resolveTarget({ kind: 'latest' }, 'pnpm', process, '/app');
    expect(result).toEqual({ ok: true, version: v('1.1.0'), explicit: false });
    expect(process.calls).toHaveLength(1);
    expect(process.calls[0]).toMatchObject({ name: 'pnpm', args: ['view', 'marmeon', 'dist-tags', 'versions', '--json'], options: { cwd: '/app', interactive: false, stdout: 'capture' } });
  });

  it('runs the package manager of the app', async () => {
    const process = answering(fixture('npm-view.json'));
    await resolveTarget({ kind: 'latest' }, 'npm', process, '/app');
    expect(process.calls[0]?.name).toBe('npm');
  });

  it('resolves a tag, and a prerelease is fine for a tag; the registry chooses a tag, so it is not explicit', async () => {
    const process = answering(registry({ latest: '1.1.0', next: '1.2.0-rc.1' }, ['1.1.0', '1.2.0-rc.1']));
    expect(await resolveTarget({ kind: 'tag', tag: 'next' }, 'pnpm', process, '/app')).toEqual({ ok: true, version: v('1.2.0-rc.1'), explicit: false });
  });

  it('does not call a tag below the installed version explicit', async () => {
    const process = answering(registry({ latest: '1.1.0', next: '0.9.0' }, ['0.9.0', '1.1.0']));
    expect(await resolveTarget({ kind: 'tag', tag: 'next' }, 'pnpm', process, '/app')).toMatchObject({ ok: true, explicit: false });
  });

  it('refuses build metadata on a tag and on an exact version', async () => {
    const tag = await resolveTarget({ kind: 'tag', tag: 'next' }, 'pnpm', answering(registry({ latest: '1.1.0', next: '1.2.0-rc.1+x' }, ['1.1.0', '1.2.0-rc.1+x'])), '/app');
    expect(tag).toMatchObject({ ok: false });
    expect((tag as { message: string }).message).toContain('not an exact version');
    expect(await resolveTarget({ kind: 'version', version: v('1.2.0+b') }, 'pnpm', answering(''), '/app')).toMatchObject({ ok: false });
  });

  it('makes no call for an exact version', async () => {
    const process = answering('never read');
    expect(await resolveTarget({ kind: 'version', version: v('1.2.0') }, 'pnpm', process, '/app')).toEqual({ ok: true, version: v('1.2.0'), explicit: true });
    expect(process.calls).toEqual([]);
  });

  it.each([
    ['build metadata on latest', registry({ latest: '1.1.0+x' }, ['1.1.0+x'])],
    ['a path as latest', registry({ latest: 'file:../x' }, ['file:../x'])],
    ['an argument smuggled into latest', registry({ latest: '1.2.0 --foo' }, ['1.2.0 --foo'])],
    ['a prerelease as latest', registry({ latest: '1.2.0-rc.1' }, ['1.2.0-rc.1'])],
    ['an unlisted latest', registry({ latest: '1.2.0' }, ['1.1.0'])],
    ['a missing latest', registry({ next: '1.2.0-rc.1' }, ['1.2.0-rc.1'])],
    ['a numeric latest', registry({ latest: 12 }, ['1.1.0'])],
    ['an array as another tag', registry({ latest: '1.1.0', next: ['1.2.0'] }, ['1.1.0'])],
    ['versions that is a string (npm prints one version so)', registry({ latest: '1.1.0' }, '1.1.0')],
    ['a number among the versions', registry({ latest: '1.1.0' }, ['1.1.0', 2])],
    ['dist-tags as an array', registry(['1.1.0'], ['1.1.0'])],
    ['missing dist-tags', JSON.stringify({ versions: ['1.1.0'] })],
    ['not JSON', 'Error: registry unreachable'],
    ['an array as the answer', '[]'],
    ['a null answer', 'null'],
    ['a string as the answer', '"1.1.0"'],
    ['an empty answer', ''],
  ])('refuses %s', async (_name, stdout) => {
    const result = await resolveTarget({ kind: 'latest' }, 'pnpm', answering(stdout), '/app');
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('--to=<version>');
  });

  it('reads a tag from the answer\'s own tags only, never from the prototype', async () => {
    const result = await resolveTarget({ kind: 'tag', tag: 'constructor' }, 'pnpm', answering(registry({ latest: '1.1.0' }, ['1.1.0'])), '/app');
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('has no "constructor" tag');
  });

  it('refuses a failed call and a call that throws', async () => {
    const failed = await resolveTarget({ kind: 'latest' }, 'pnpm', answering(fixture('npm-view.json'), 1), '/app');
    expect(failed).toMatchObject({ ok: false });
    expect((failed as { message: string }).message).toContain('--to=<version>');
    const thrown = await resolveTarget({ kind: 'latest' }, 'pnpm', new FakeProcess(() => Promise.reject(new Error('pnpm did not finish within 60 s'))), '/app');
    expect(thrown).toMatchObject({ ok: false });
    expect((thrown as { message: string }).message).toContain('60 s');
    expect((thrown as { message: string }).message).toContain('--to=<version>');
  });
});

describe('decideJump', () => {
  const jump = (installed: string[], to: string) => decideJump(installed.map(v), v(to));

  it.each([
    [['1.1.0'], '1.0.0', { kind: 'downgrade' }],
    [['1.1.0'], '1.1.0-rc.1', { kind: 'downgrade' }],
    [['1.1.0'], '1.1.0', { kind: 'same' }],
    [['1.1.0', '1.1.0'], '1.1.0', { kind: 'same' }],
    [['1.1.0'], '1.2.0', { kind: 'move', breaking: false }],
    [['1.1.0'], '2.0.0', { kind: 'move', breaking: true }],
    [['0.3.0'], '0.4.0', { kind: 'move', breaking: true }],
    [['0.4.0'], '0.4.1', { kind: 'move', breaking: false }],
    [['1.1.0-rc.2'], '1.1.0', { kind: 'move', breaking: false }],
    [['1.0.0-rc.8'], '1.0.0', { kind: 'move', breaking: false }],
    [['0.4.0'], '1.0.0-rc.8', { kind: 'move', breaking: true }],
  ])('%j to %s', (installed, to, expected) => {
    expect(jump(installed, to)).toEqual(expected);
  });

  it('repairs a mix at the highest version: a move, not the same', () => {
    expect(jump(['1.1.0', '1.0.0'], '1.1.0')).toEqual({ kind: 'move', breaking: false });
  });

  it('judges a mix across 0.x and 1.x from its lowest package', () => {
    expect(jump(['1.0.0', '0.4.0', '1.0.0'], '1.1.0')).toEqual({ kind: 'move', breaking: true });
  });

  it('calls a target below an outlier a downgrade', () => {
    expect(jump(['1.1.0', '2.0.0', '1.1.0'], '1.2.0')).toEqual({ kind: 'downgrade' });
  });

  it('needs the installed versions', () => {
    expect(() => decideJump([], v('1.0.0'))).toThrow('at least one installed version');
  });
});
