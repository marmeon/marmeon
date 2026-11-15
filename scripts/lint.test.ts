import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from './test/temp-dir.js';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A trim whose second alternative restarts at every character of a run of dots or spaces that does not end the string. */
const TRIM = "export const trim = (text: string) => text.replace(/^[. ]+|[. ]+$/g, '');\n";
const MOVE = 'regexp(no-super-linear-move)';
const BACKTRACKING = 'regexp(no-super-linear-backtracking)';

/**
 * Lints `files` (path to text) in a fresh directory with a literal copy of the root config and of the repository's own plugin. `node_modules` holds a link to
 * `eslint-plugin-regexp` so that `jsPlugins` resolves; linking the whole directory would make oxlint walk every installed package. Returns the
 * exit code and the hits as `file:line:rule`. The timeout matters: `spawnSync` blocks the event loop, so Vitest's own timeout
 * could not stop a hanging oxlint.
 */
function lint(files: Record<string, string>) {
  const root = tempDir('marmeon-lint-');
  copyFileSync(join(repository, '.oxlintrc.json'), join(root, '.oxlintrc.json'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repository, 'scripts/lint-rules.ts'), join(root, 'scripts/lint-rules.ts'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(repository, 'node_modules/eslint-plugin-regexp'), join(root, 'node_modules/eslint-plugin-regexp'), 'dir');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync(join(repository, 'node_modules/.bin/oxlint'), ['--deny-warnings', '-f', 'unix'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const hits = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(.+?):(\d+):\d+: .*\[\w+\/((?:regexp|marmeon)\([\w-]+\))\]$/.exec(line);
    if (match) hits.add(`${match[1]}:${match[2]}:${match[3]}`);
  }
  return { status: result.status, hits, output: result.stdout + result.stderr };
}

const CLEAN = {
  // A lookbehind that starts a run only at its first character, and a plain pattern.
  'packages/demo/src/linear.ts': [
    "export const a = /(?<![. ])[. ]+$/;",
    "export const b = /^[a-z][a-z0-9-]*$/;",
    '',
  ].join('\n'),
  'packages/demo/src/allowed.ts': [
    "// oxlint-disable-next-line regexp/no-super-linear-move -- the value comes from the app's config",
    "export const c = /^[. ]+|[. ]+$/g;",
    '',
  ].join('\n'),
};

describe('lint — regular expressions that run in super-linear time', () => {
  const flagged = lint({
    'packages/demo/src/trim.ts': TRIM,
    'packages/demo/src/nested.ts': 'export const nested = /^(\\w+\\s?)*$/;\n',
    'packages/demo/src/constructed.ts': "export const built = new RegExp('(a+)+b');\n",
    'packages/demo/bin/run.js': TRIM.replace(': string', ''),
    'packages/demo/stubs/x.ts': TRIM,
    // Out of scope: tests, fixtures, scripts and examples only see repository content.
    'packages/demo/src/trim.test.ts': TRIM,
    'packages/demo/src/__fixtures__/x.ts': TRIM,
    'scripts/x.ts': TRIM,
    'examples/x/x.ts': TRIM,
    ...CLEAN,
  });

  it('refuses the trim of the old pattern with the move rule only', () => {
    const own = [...flagged.hits].filter((hit) => hit.startsWith('packages/demo/src/trim.ts:'));
    expect(own).toEqual([`packages/demo/src/trim.ts:1:${MOVE}`]);
  });

  it('reports exactly the expected hits and fails the run', () => {
    expect(flagged.status).toBe(1);
    expect([...flagged.hits].sort()).toEqual(
      [
        `packages/demo/bin/run.js:1:${MOVE}`,
        `packages/demo/src/constructed.ts:1:${BACKTRACKING}`,
        `packages/demo/src/constructed.ts:1:${MOVE}`,
        `packages/demo/src/nested.ts:1:${BACKTRACKING}`,
        `packages/demo/src/trim.ts:1:${MOVE}`,
        `packages/demo/stubs/x.ts:1:${MOVE}`,
      ].sort(),
    );
  });

  it('passes a run over linear patterns, an allowed one and out-of-scope files', () => {
    const clean = lint({
      ...CLEAN,
      'packages/demo/src/trim.test.ts': TRIM,
      'packages/demo/src/__fixtures__/x.ts': TRIM,
      'scripts/x.ts': TRIM,
      'examples/x/x.ts': TRIM,
    });
    expect(clean.output).not.toContain('regexp');
    expect([...clean.hits]).toEqual([]);
    expect(clean.status).toBe(0);
  });
});

const own = (rule: string) => `marmeon(${rule})`;

describe('lint — the repository\'s own rules', () => {
  const flagged = lint({
      // fixture-app-root: the folder of the test file as the root of an app whose modules take migrations from `__fixtures__`.
      'packages/demo/src/root.test.ts': [
        "import { createApplication } from '@marmeon/core';",
        "import { fixtureModule, sharedRoot } from './helpers.ts';",
        "const dir = import.meta.dirname;",
        "const migrations = new URL('./__fixtures__/migrations/', import.meta.url);",
        "const modules = [defineModule({ name: 'x', migrations })];",
        "const definition = { root: dir, modules };",
        "createApplication({ root: import.meta.dirname, modules: [defineModule({ name: 'x', migrations: new URL('./__fixtures__/m/', import.meta.url) })] });", // 7
        "createApplication({ root: join(import.meta.dirname, 'x'), modules: [defineModule({ name: 'x', migrations: join(import.meta.dirname, '__fixtures__', 'm') })] });", // 8
        'createApplication({ root: fileURLToPath(new URL(".", import.meta.url)), modules: [{ migrations: `${import.meta.dirname}/__fixtures__/m` }] });', // 9
        'createApplication({ root: import.meta.filename, modules: [{ migrations: "__fixtures__" }] });', // 10
        'createApplication({ root: dir, modules });', // 11: root and modules through constants
        'createApplication({ root: import.meta.dirname, modules: [defineModule({ name: "x", migrations })] });', // 12: migrations through a constant
        'createApplication(definition);', // 13: the whole definition through a constant, reported at its `root` on line 6
        "createApplication({ root: workspaceTempDir('marmeon-x-'), modules: [defineModule({ name: 'x', migrations: new URL('./__fixtures__/m/', import.meta.url) })] });",
        "createApplication({ root: import.meta.dirname, discover: false, providers: [] });",
        "createApplication({ root: import.meta.dirname, modules: [defineModule({ name: 'x', routes })] });",
        "createApplication({ root: import.meta.dirname, modules: [defineModule({ name: 'x', migrations: new URL('./migrations/', import.meta.url) })] });",
        'createApplication({ root: other });',
        'const app = (root) => createApplication({ root });',
        // The limit: a module or a root that comes from a helper or an import is not followed.
        'createApplication({ root: import.meta.dirname, modules: [fixtureModule()] });',
        'createApplication({ root: sharedRoot, modules: [defineModule({ name: "x", migrations })] });',
        '',
      ].join('\n'),
      // exact-body-assertion: a negative assertion on an awaited `.json()` or `.text()`, alone or inside `String` or `JSON.stringify`.
      'packages/demo/src/body.test.ts': [
        "expect(await response.text()).not.toMatch(/secret/);", // 1
        "expect(await (await fetch('/x')).json()).not.toEqual({ error: true });", // 2
        "expect(JSON.stringify(await visit.json())).not.toMatch(/nonce/i);", // 3
        "expect(await response.text()).not.toContain('secret');", // 4
        "expect(String(await response.text())).not.toContain('secret');", // 5
        "expect.soft(await response.text()).not.toContain('secret');", // 6
        "expect(JSON.stringify(value)).not.toContain('secret');",
        "expect(JSON.stringify(await visit.json())).toContain('ok');",
        "expect(await response.text()).toBe('ok');",
        "expect(list).not.toContain('secret');",
        "expect(response.text).not.toContain('secret');",
        // The limit: a body held in a variable and the other negative matchers are not followed.
        "const body = await response.text();",
        "expect(body).not.toContain('secret');",
        "expect(await response.text()).not.toBe('');",
        '',
      ].join('\n'),
      // identity-by-name: `constructor.name` compared — plain, optional, asserted, computed, in a `switch` — in source only.
      'packages/demo/src/identity.ts': [
        "export const a = (x: object) => x.constructor.name === 'Thing';", // 1
        "export const b = (x: object) => 'Thing' !== x.constructor.name;", // 2
        "export const c = (x: object) => { switch (x.constructor.name) { case 'Thing': return 1; default: return 0; } };", // 3
        "export const d = (x: any) => x.constructor?.name === 'AsyncFunction';", // 4
        "export const e = (x: any) => x?.constructor.name == 'Thing';", // 5
        "export const f = (x: any) => (x.constructor as any).name != 'Thing';", // 6
        "export const g = (x: any) => x['constructor'].name === 'Thing';", // 7
        "export const h = (x: any) => x!.constructor!.name === 'Thing';", // 8
        "export const i = (x: any) => { switch (x?.constructor?.name) { case 'Thing': return 1; default: return 0; } };", // 9
        "export const j = (x: object) => x instanceof Date;",
        "export const k = (x: { name: string }) => x.name === 'Thing';",
        'export const l = (x: object) => `${x.constructor.name} failed`;',
        "export const m = (x: any) => x.constructor === Thing;",
        "export const n = (x: any) => x.constructor?.name ?? 'Object';",
        '',
      ].join('\n'),
      // Out of scope: the identity rule skips tests, the two test rules skip source.
      'packages/demo/src/identity.test.ts': "export const g = (x: object) => x.constructor.name === 'Thing';\n",
      'packages/demo/src/body.ts': "expect(await response.text()).not.toContain('secret');\ncreateApplication({ root: import.meta.dirname, modules: [{ migrations: '__fixtures__' }] });\n",
  });

  it('reports exactly the expected hits and fails the run', () => {
    expect(flagged.status).toBe(1);
    expect([...flagged.hits].sort()).toEqual(
      [
        `packages/demo/src/root.test.ts:7:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:8:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:9:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:10:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:11:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:12:${own('fixture-app-root')}`,
        `packages/demo/src/root.test.ts:6:${own('fixture-app-root')}`,
        `packages/demo/src/body.test.ts:1:${own('exact-body-assertion')}`,
        `packages/demo/src/body.test.ts:2:${own('exact-body-assertion')}`,
        `packages/demo/src/body.test.ts:3:${own('exact-body-assertion')}`,
        `packages/demo/src/body.test.ts:4:${own('exact-body-assertion')}`,
        `packages/demo/src/body.test.ts:5:${own('exact-body-assertion')}`,
        `packages/demo/src/body.test.ts:6:${own('exact-body-assertion')}`,
        `packages/demo/src/identity.ts:1:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:2:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:3:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:4:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:5:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:6:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:7:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:8:${own('identity-by-name')}`,
        `packages/demo/src/identity.ts:9:${own('identity-by-name')}`,
      ].sort(),
    );
  });
});
