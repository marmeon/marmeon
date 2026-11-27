import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { importOptional } from './optional-peer.ts';

// The source file Node loads itself in the plain-Node test.
const HELPER = './optional-peer.ts';
let root: string;

function file(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function pkg(name: string, exports: Record<string, string>, files: Record<string, string>): void {
  file(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', type: 'module', exports }));
  for (const [path, content] of Object.entries(files)) file(`node_modules/${name}/${path}`, content);
}

/** An importer file in the fixture tree: what an app's `import('<specifier>')` starts from. */
const importer = (specifier: string): { url: string; load: () => Promise<unknown> } => {
  const path = join(root, `importer-${specifier.replace(/[^a-z]/g, '-')}.mjs`);
  writeFileSync(path, `export * from '${specifier}';\n`);
  const url = pathToFileURL(path).href;
  return { url, load: () => import(/* @vite-ignore */ url) };
};

beforeAll(() => {
  root = tempDir('marmeon-optional-peer-');
  pkg('@probe/ok', { '.': './index.js', './testing': './testing.js' }, { 'index.js': 'export const main = 1;\n', 'testing.js': 'export const fake = 2;\n' });
  pkg('@probe/unbuilt', { '.': './index.js', './testing': './missing-testing.js' }, { 'index.js': 'export const main = 1;\n' });
  pkg('@probe/needs-dep', { '.': './index.js' }, { 'index.js': "import '@probe/absent-dep';\nexport const main = 1;\n" });
  pkg('@probe/syntax', { '.': './index.js' }, { 'index.js': 'export const = ;\n' });
  mkdirSync(join(root, 'node_modules/@probe'), { recursive: true });
  symlinkSync(join(root, 'does-not-exist'), join(root, 'node_modules/@probe/dangling'));
});

describe('importOptional on real imports', () => {
  it('returns undefined for a package that is not installed', async () => {
    const from = importer('@probe/none');
    expect(await importOptional('@probe/none', from.load, { from: from.url })).toBeUndefined();
  });

  it('returns the module of an installed package', async () => {
    const from = importer('@probe/ok');
    expect(await importOptional('@probe/ok', from.load, { from: from.url })).toMatchObject({ main: 1 });
    const testing = importer('@probe/ok/testing');
    expect(await importOptional('@probe/ok', testing.load, { from: testing.url })).toMatchObject({ fake: 2 });
  });

  it('rethrows when an installed package exports a subpath whose file is missing', async () => {
    const from = importer('@probe/unbuilt/testing');
    await expect(importOptional('@probe/unbuilt', from.load, { from: from.url })).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('rethrows when an installed package misses a dependency', async () => {
    const from = importer('@probe/needs-dep');
    await expect(importOptional('@probe/needs-dep', from.load, { from: from.url })).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('rethrows a SyntaxError of an installed package', async () => {
    const from = importer('@probe/syntax');
    await expect(importOptional('@probe/syntax', from.load, { from: from.url })).rejects.toBeInstanceOf(SyntaxError);
  });

  it('treats a dangling link in node_modules as installed and rethrows', async () => {
    const from = importer('@probe/dangling');
    await expect(importOptional('@probe/dangling', from.load, { from: from.url })).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('rethrows a not-found error while the package directory exists', async () => {
    const error = Object.assign(new Error("Cannot find package '@probe/ok' imported from /a/b.js"), { code: 'ERR_MODULE_NOT_FOUND' });
    await expect(importOptional('@probe/ok', () => Promise.reject(error), { from: importer('@probe/ok').url })).rejects.toBe(error);
  });

  it('rethrows another code while the package directory is absent', async () => {
    const error = Object.assign(new Error("Cannot find package '@probe/none' imported from /a/b.js"), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await expect(importOptional('@probe/none', () => Promise.reject(error), { from: importer('@probe/none').url })).rejects.toBe(error);
  });

  it('rethrows a thrown non-object as it is', async () => {
    const from = importer('@probe/none').url;
    await expect(importOptional('@probe/none', () => Promise.reject(null), { from })).rejects.toBeNull();
    await expect(importOptional('@probe/none', () => Promise.reject('boom'), { from })).rejects.toBe('boom');
  });

  const notFound = (): Promise<never> => Promise.reject(Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' }));

  it('walks up through every ancestor directory', async () => {
    mkdirSync(join(root, 'x/y'), { recursive: true });
    pkg('@probe/walk', { '.': './index.js', './testing': './missing.js' }, { 'index.js': 'export const main = 1;\n' });
    const path = join(root, 'x/y/importer.mjs');
    writeFileSync(path, "export * from '@probe/walk/testing';\n");
    const url = pathToFileURL(path).href;
    await expect(importOptional('@probe/walk', () => import(/* @vite-ignore */ url), { from: url })).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('looks from the real path of a linked directory', async () => {
    const other = tempDir('marmeon-optional-peer-other-');
    mkdirSync(join(other, 'node_modules/@p/a'), { recursive: true });
    mkdirSync(join(other, 'real'));
    symlinkSync(join(other, 'real'), join(root, 'link'));
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = pathToFileURL(join(root, 'link/i.mjs')).href;
    await expect(importOptional('@p/a', () => Promise.reject(error), { from, probe: notFound })).rejects.toBe(error);
  });

  it('rethrows the original error when the bare import loads, although nothing is on disk', async () => {
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = importer('@probe/none-loads').url;
    await expect(importOptional('@probe/none-loads', () => Promise.reject(error), { from, probe: async () => ({}) })).rejects.toBe(error);
  });

  it('rethrows the original error when the bare import fails with another code', async () => {
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = importer('@probe/none-other').url;
    const probe = () => Promise.reject(new SyntaxError('y'));
    await expect(importOptional('@probe/none-other', () => Promise.reject(error), { from, probe })).rejects.toBe(error);
    await expect(importOptional('@probe/none-other', () => Promise.reject(error), { from, probe: () => Promise.reject(null) })).rejects.toBe(error);
  });

  it('returns undefined when the bare import and the disk both say absent', async () => {
    expect(await importOptional('@probe/none-both', notFound, { from: importer('@probe/none-both').url, probe: notFound })).toBeUndefined();
  });

  it('rethrows the original error when it cannot tell where to look', async () => {
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    for (const from of ['not a url', 'file:///does/not/exist/at/all/i.mjs', 'https://example.com/i.mjs']) {
      await expect(importOptional('@probe/none', () => Promise.reject(error), { from, probe: notFound })).rejects.toBe(error);
    }
  });

  it('answers absent from memory the second time, and never remembers a broken package', async () => {
    let probed = 0;
    const probe = () => {
      probed++;
      return notFound();
    };
    const from = importer('@probe/none-twice').url;
    expect(await importOptional('@probe/none-twice', notFound, { from, probe })).toBeUndefined();
    expect(await importOptional('@probe/none-twice', notFound, { from, probe })).toBeUndefined();
    expect(probed).toBe(1);
    const broken = importer('@probe/unbuilt').url;
    for (let attempt = 0; attempt < 2; attempt++) await expect(importOptional('@probe/unbuilt', notFound, { from: broken, probe })).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  });

  it('treats a node_modules that is a file as nothing there', async () => {
    mkdirSync(join(root, 'z'), { recursive: true });
    writeFileSync(join(root, 'z/node_modules'), '');
    const from = pathToFileURL(join(root, 'z/i.mjs')).href;
    expect(await importOptional('@probe/none-file', notFound, { from, probe: notFound })).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)('rethrows when a directory on the walk cannot be read', async () => {
    const closed = join(root, 'closed');
    mkdirSync(join(closed, 'node_modules'), { recursive: true });
    chmodSync(join(closed, 'node_modules'), 0o000);
    onTestFinished(() => chmodSync(join(closed, 'node_modules'), 0o755));
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = pathToFileURL(join(closed, 'i.mjs')).href;
    await expect(importOptional('@probe/none-closed', () => Promise.reject(error), { from, probe: notFound })).rejects.toBe(error);
  });

  it('looks from the path as written as well as from its real path', async () => {
    const other = tempDir('marmeon-optional-peer-written-');
    mkdirSync(join(other, 'real'));
    mkdirSync(join(root, 'written-node-modules/node_modules/@p/w'), { recursive: true });
    symlinkSync(join(other, 'real'), join(root, 'written-node-modules/link'));
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = pathToFileURL(join(root, 'written-node-modules/link/i.mjs')).href;
    await expect(importOptional('@p/w', () => Promise.reject(error), { from, probe: notFound })).rejects.toBe(error);
  });

  it('rethrows when the package resolves, although the bare import and the disk say absent', async () => {
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = importer('@probe/none-resolves').url;
    await expect(importOptional('@probe/none-resolves', () => Promise.reject(error), { from, resolve: () => 'file:///x.js', probe: notFound })).rejects.toBe(error);
  });

  it('rethrows when resolving fails with another code', async () => {
    const error = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });
    const from = importer('@probe/none-resolve-other').url;
    const resolve = () => {
      throw Object.assign(new Error('y'), { code: 'ERR_INVALID_MODULE_SPECIFIER' });
    };
    await expect(importOptional('@probe/none-resolve-other', () => Promise.reject(error), { from, resolve, probe: notFound })).rejects.toBe(error);
  });

  it('returns undefined when resolving, the bare import and the disk all say absent', async () => {
    const resolve = () => {
      throw Object.assign(new Error('y'), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const from = importer('@probe/none-all').url;
    expect(await importOptional('@probe/none-all', notFound, { from, resolve, probe: notFound })).toBeUndefined();
  });

  it('recognises a package that does not exist under the module runner (default start)', async () => {
    const name = ['@marmeon/not-installed', String(process.pid)].join('-');
    expect(await importOptional(name, () => import(/* @vite-ignore */ name))).toBeUndefined();
  });

  it('gives the same answers in plain Node', async () => {
    const helper = pathToFileURL(fileURLToPath(new URL(HELPER, import.meta.url))).href;
    const script = join(root, 'native.mjs');
    writeFileSync(
      script,
      `import { registerHooks } from 'node:module';
// A resolver hook that supplies '@probe/hooked' from memory; its source imports a dependency that does not exist.
registerHooks({
  resolve: (specifier, context, next) => (specifier === '@probe/hooked' ? { url: 'file:///hooked/entry.js', shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url === 'file:///hooked/entry.js' ? { format: 'module', source: "import '@probe/hook-dep';", shortCircuit: true } : next(url, context)),
});
const { importOptional } = await import(${JSON.stringify(helper)});
const answer = async (name, specifier) => {
  try { return String(typeof (await importOptional(name, () => import(specifier), { from: import.meta.url }))); } catch (error) { return 'threw ' + error.code; }
};
console.log(JSON.stringify([await answer('@probe/hooked', '@probe/hooked'), await answer('@probe/none', '@probe/none'), await answer('@probe/unbuilt', '@probe/unbuilt/testing'), await answer('@probe/ok', '@probe/ok')]));
`,
    );
    const child = spawn(process.execPath, [script], { cwd: root, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    onTestFinished(() => void child.kill());
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    await new Promise((resolve) => child.on('close', resolve));
    expect(err).toBe('');
    expect(JSON.parse(out)).toEqual(['threw ERR_MODULE_NOT_FOUND', 'undefined', 'threw ERR_MODULE_NOT_FOUND', 'object']);
  });
});

describe('the optional peers of createTestApp()', () => {
  const source = readFileSync(new URL('./test-app.ts', import.meta.url), 'utf8');
  const loaders = [...source.matchAll(/async function (import\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].map(([, name, body]) => ({ name, body: body! }));

  it('imports only the package it names in every importOptional call', () => {
    const calls = [...source.matchAll(/importOptional\('([^']+)', async \(\) => \(([\s\S]*?)\)\);/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, name, body] of calls) {
      const specifiers = [...body!.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1]!);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(specifier === name || specifier.startsWith(`${name}/`)).toBe(true);
    }
  });

  it('has nothing but the helper call in a loader, apart from the two that throw their own message', () => {
    expect(loaders.length).toBeGreaterThan(10);
    for (const { name, body } of loaders) {
      if (name === 'importDevtools' || name === 'importCli') continue;
      expect(body.trim(), name).toMatch(/^return importOptional\('[^']+', async \(\) => \(\{[\s\S]*\}\)\);$/);
    }
  });

  it('has importChat answer through importOptional alone, and load only the chat package', () => {
    const chat = readFileSync(new URL('./import-chat.ts', import.meta.url), 'utf8');
    const body = chat.match(/async function importChat\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(body.trim()).toBe("return importOptional('@marmeon/chat-notifications', load);");
    const loader = chat.match(/const loadChat = [^\n]*/)?.[0] ?? '';
    const specifiers = [...loader.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier === '@marmeon/chat-notifications' || specifier.startsWith('@marmeon/chat-notifications/')).toBe(true);
  });

  it('has importSearch answer through importOptional alone, and load only the search package', () => {
    const search = readFileSync(new URL('./import-search.ts', import.meta.url), 'utf8');
    const body = search.match(/async function importSearch\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(body.trim()).toBe("return importOptional('@marmeon/search', load);");
    const loader = search.match(/const loadSearch = [^\n]*/)?.[0] ?? '';
    const specifiers = [...loader.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier === '@marmeon/search' || specifier.startsWith('@marmeon/search/')).toBe(true);
  });
});
