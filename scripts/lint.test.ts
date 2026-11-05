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
 * Lints `files` (path to text) in a fresh directory with a literal copy of the root config. `node_modules` holds a link to the
 * plugin so that `jsPlugins` resolves; linking the whole directory would make oxlint walk every installed package. Returns the
 * exit code and the hits as `file:line:rule`. The timeout matters: `spawnSync` blocks the event loop, so Vitest's own timeout
 * could not stop a hanging oxlint.
 */
function lint(files: Record<string, string>) {
  const root = tempDir('marmeon-lint-');
  copyFileSync(join(repository, '.oxlintrc.json'), join(root, '.oxlintrc.json'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(repository, 'node_modules/eslint-plugin-regexp'), join(root, 'node_modules/eslint-plugin-regexp'), 'dir');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync(join(repository, 'node_modules/.bin/oxlint'), ['--deny-warnings', '-f', 'unix'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const hits = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(.+?):(\d+):\d+: .*\[\w+\/(regexp\([\w-]+\))\]$/.exec(line);
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
