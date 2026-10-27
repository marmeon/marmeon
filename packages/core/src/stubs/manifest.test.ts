import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStubManifest, recordStubSet, STUB_MANIFEST, stubHash } from './manifest.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

const fixtures = new URL('../__fixtures__/formats/stubs-manifest/', import.meta.url);

function app(files: Record<string, string> = { 'a.txt': 'one\n', 'sub/b.txt': 'two\n' }): string {
  const root = tempDir('marmeon-stub-manifest-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const set = { package: 'pkg', version: '1.2.3', files: [{ path: 'a.txt', stub: 'stubs/a.txt' }, { path: 'sub/b.txt', stub: 'stubs/sub/b.txt' }] };

describe('the hash of a copied file', () => {
  it('is the same for LF and CRLF line endings', () => {
    expect(stubHash('a\r\nb\r\n')).toBe(stubHash('a\nb\n'));
    expect(stubHash(Buffer.from('a\r\nb\r\n'))).toBe(stubHash('a\nb\n'));
    expect(stubHash('a\n')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stubHash('a\n')).not.toBe(stubHash('b\n'));
  });
});

describe('marmeon-stubs.json', () => {
  it('writes the same bytes twice, sorted, with a final newline', () => {
    const root = app();
    expect(recordStubSet(root, 'pkg:stubs', set).ok).toBe(true);
    const first = readFileSync(join(root, STUB_MANIFEST), 'utf8');
    expect(recordStubSet(root, 'pkg:stubs', { ...set, files: [...set.files].reverse() }).ok).toBe(true);
    expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
    expect(first.indexOf('"a.txt"')).toBeLessThan(first.indexOf('"sub/b.txt"'));
    const read = readStubManifest(root);
    expect(read.ok && read.value?.sets['pkg:stubs']?.files['a.txt']).toEqual({ stub: 'stubs/a.txt', sha256: stubHash('one\n') });
  });

  it('keeps the other sets when it replaces one', () => {
    const root = app();
    recordStubSet(root, 'one:stubs', { ...set, package: 'one' });
    recordStubSet(root, 'two:stubs', { ...set, package: 'two' });
    recordStubSet(root, 'one:stubs', { package: 'one', version: '2.0.0', files: [{ path: 'a.txt', stub: 'stubs/a.txt' }] });
    const read = readStubManifest(root);
    if (!read.ok || !read.value) throw new Error('unreadable');
    expect(Object.keys(read.value.sets)).toEqual(['one:stubs', 'two:stubs']);
    expect(read.value.sets['one:stubs']?.version).toBe('2.0.0');
    expect(Object.keys(read.value.sets['one:stubs']!.files)).toEqual(['a.txt']);
    expect(read.value.sets['two:stubs']?.package).toBe('two');
  });

  it('says nothing for an app without a manifest', () => {
    const read = readStubManifest(app());
    expect(read).toMatchObject({ ok: true, value: undefined });
  });

  it('reads every fixture of a version it supports', () => {
    const names = readdirSync(fixtures);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const root = app();
      const bytes = readFileSync(new URL(name, fixtures), 'utf8');
      writeFileSync(join(root, STUB_MANIFEST), bytes);
      const read = readStubManifest(root);
      expect(read.ok, name).toBe(true);
      // What the writer produces for a manifest is what the fixture holds: a reader and a writer agree on the form.
      if (read.ok && read.value) {
        expect(read.value, name).toEqual(JSON.parse(bytes));
        expect(`${JSON.stringify(JSON.parse(bytes), null, 2)}\n`, name).toBe(bytes);
        // The keys are sorted on every level: a writer in another package compares byte for byte.
        const sortedCopy = (value: unknown): unknown =>
          typeof value === 'object' && value !== null ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedCopy((value as Record<string, unknown>)[key])])) : value;
        expect(JSON.stringify(JSON.parse(bytes)), name).toBe(JSON.stringify(sortedCopy(JSON.parse(bytes))));
      }
    }
  });

  it('refuses a newer format and leaves the file as it is', () => {
    const root = app();
    const newer = `${JSON.stringify({ format: 2, sets: {}, extra: true })}\n`;
    writeFileSync(join(root, STUB_MANIFEST), newer);
    const read = readStubManifest(root);
    expect(read).toMatchObject({ ok: false, error: { kind: 'newer' } });
    expect(!read.ok && read.error.message).toContain('newer Marmeon');
    expect(recordStubSet(root, 'pkg:stubs', set)).toMatchObject({ ok: false, error: { kind: 'newer' } });
    expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(newer);
  });

  it('refuses a file without a format, with a foreign one and with broken JSON', () => {
    for (const contents of ['{"sets":{}}', '{"format":"1","sets":{}}', '{"format":0,"sets":{}}', '{"format":1}', '{', '[]']) {
      const root = app();
      writeFileSync(join(root, STUB_MANIFEST), contents);
      expect(readStubManifest(root), contents).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    }
  });

  it('refuses a path that leaves the app, and a hash that is none', () => {
    const entry = { stub: 'x', sha256: stubHash('x') };
    const manifest = (files: unknown, key = 'pkg:stubs') => JSON.stringify({ format: 1, sets: { [key]: { package: 'pkg', version: '1.0.0', files } } });
    const cases: unknown[] = [
      { '../x': entry },
      { '/abs': entry },
      { 'a\\b': entry },
      { 'a/../../b': entry },
      { 'a\0b': entry },
      { 'a//b': entry },
      { './a': entry },
      { 'modules/./auth/x': entry },
      { 'a.txt': { stub: './x', sha256: entry.sha256 } },
      { 'a.txt': { ...entry, extra: 1 } },
      { 'a.txt': { stub: '../../etc', sha256: entry.sha256 } },
      { 'a.txt': { stub: '/etc/passwd', sha256: entry.sha256 } },
      { 'a.txt': { stub: 'x', sha256: 'sha256:abc' } },
      { 'a.txt': { stub: 'x', sha256: stubHash('x').toUpperCase() } },
      { 'a.txt': { stub: 'x' } },
    ];
    for (const files of cases) {
      const root = app();
      writeFileSync(join(root, STUB_MANIFEST), manifest(files));
      expect(readStubManifest(root), JSON.stringify(files)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    }
    const root = app();
    writeFileSync(join(root, STUB_MANIFEST), manifest({ 'a.txt': entry }, '../evil'));
    expect(readStubManifest(root)).toMatchObject({ ok: false });
  });

  it('refuses a package, a version and a key of a set that are none', () => {
    const entry = { stub: 'x', sha256: stubHash('x') };
    const sets = (key: string, name: unknown, version: unknown, extra: Record<string, unknown> = {}) =>
      ({ format: 1, sets: { [key]: { package: name, version, files: { 'a.txt': entry }, ...extra } } });
    const cases: [string, unknown][] = [
      ['package with a slash', sets('a/b/c:stubs', 'a/b/c', '1.0.0')],
      ['package in capitals', sets('Pkg:stubs', 'Pkg', '1.0.0')],
      ['package not a string', sets('pkg:stubs', 1, '1.0.0')],
      ['version with a space', sets('pkg:stubs', 'pkg', '1.0.0 x')],
      ['version with a slash', sets('pkg:stubs', 'pkg', '1.0.0/../x')],
      ['version not semver', sets('pkg:stubs', 'pkg', '1')],
      ['key of another package', sets('other:stubs', 'pkg', '1.0.0')],
      ['key without a directory', sets('pkg:', 'pkg', '1.0.0')],
      ['key with a way out', sets('pkg:../x', 'pkg', '1.0.0')],
      ['key with a dot segment', sets('pkg:./x', 'pkg', '1.0.0')],
      ['unknown key of a set', sets('pkg:stubs', 'pkg', '1.0.0', { extra: 1 })],
      ['unknown key at the top', { ...sets('pkg:stubs', 'pkg', '1.0.0'), extra: 1 }],
    ];
    for (const [name, manifest] of cases) {
      const root = app();
      writeFileSync(join(root, STUB_MANIFEST), JSON.stringify(manifest));
      expect(readStubManifest(root), name).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    }
    const root = app();
    const files = [{ path: 'a.txt', stub: 'x' }];
    for (const [key, name, version] of [['pkg:stubs', 'pkg', 'x y'], ['pkg:stubs', 'p/q/r', '1.0.0'], ['other:stubs', 'pkg', '1.0.0'], ['pkg:../x', 'pkg', '1.0.0']] as const) {
      expect(recordStubSet(root, key, { package: name, version, files }), `${key} ${name} ${version}`).toMatchObject({ ok: false });
    }
    for (const path of ['./a.txt', 'modules/./a.txt']) {
      expect(recordStubSet(root, 'pkg:stubs', { package: 'pkg', version: '1.0.0', files: [{ path, stub: 'x' }] })).toMatchObject({ ok: false });
    }
    expect(readdirSync(root)).not.toContain(STUB_MANIFEST);
  });

  it('writes nothing for a path that leaves the app', () => {
    const root = app();
    for (const bad of [{ path: '../x', stub: 'a' }, { path: '/abs', stub: 'a' }, { path: 'a\\b', stub: 'a' }, { path: 'a.txt', stub: '../../etc' }]) {
      expect(recordStubSet(root, 'pkg:stubs', { package: 'pkg', version: '1.0.0', files: [bad] })).toMatchObject({ ok: false });
    }
    expect(readdirSync(root)).not.toContain(STUB_MANIFEST);
  });

  it('records the hash a file carries instead of hashing it, and refuses one that is no hash', () => {
    const root = app();
    const written = stubHash('what was written\n');
    expect(recordStubSet(root, 'pkg:stubs', { ...set, files: [{ path: 'a.txt', stub: 'stubs/a.txt', sha256: written }, set.files[1]!] }).ok).toBe(true);
    const read = readStubManifest(root);
    expect(read.ok && read.value?.sets['pkg:stubs']?.files['a.txt']?.sha256).toBe(written);
    expect(read.ok && read.value?.sets['pkg:stubs']?.files['sub/b.txt']?.sha256).toBe(stubHash('two\n'));
    expect(recordStubSet(root, 'pkg:stubs', { ...set, files: [{ path: 'a.txt', stub: 'stubs/a.txt', sha256: 'nope' }] })).toMatchObject({ ok: false });
  });
});
