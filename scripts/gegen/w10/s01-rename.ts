import { defineGegenproben } from '../define.ts';

/**
 * W10.1 — the rename to Marmeon (E194–E196): packages `@marmeon/*`, the CLI as the unscoped `marmeon`, the starter `create-marmeon`, and
 * every `x-marmeon-*`, `/_marmeon/*`, `MARMEON_*`, `[marmeon:…]`, `.marmeon/` and the discovery field `"marmeon"`; the company name stays.
 *
 * What keeps the repository renamed: `check:source` (G1, G7b) — and why it is needed: the temp hygiene finds leftovers by their prefix only,
 * so a helper with the old prefix slips through it (masking probe X1). The company name is guarded twice (G2 root, G2b the copies). The
 * unscoped names fall out of every `startsWith('@marmeon/')`: the scaffolder pins and vendors the CLI (G4, G5b), pack:smoke checks its
 * tarball (G5). The two ways a package counts as the framework's — its scope and its `"marmeon"` field — each with its own scenario
 * (masking pair G3b ↔ G3c); the field also decides discovery (G3). The error page's solutions read the new codes (G6).
 *
 * The old name is spelled in parts here: this file passes `check:source` itself.
 */
const OLD = ['bes', 'poke'].join('');
const sourceRule = { vitest: 'scripts/ci.test.ts', name: 'check:source — the old name is gone (E196) > holds for the repository' };
const createTest = (name: string) => ({ vitest: 'packages/create-marmeon/src/create.test.ts', name });

export default defineGegenproben({
  step: 'W10.1',
  cases: [
    // --- check:source ---------------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the old header name back in a package source: check:source names the line',
      patch: [{ file: 'packages/http/src/page.ts', find: "export const VERSION_HEADER = 'x-marmeon-version';", replace: `export const VERSION_HEADER = 'x-${OLD}-version';` }],
      run: sourceRule,
      expect: new RegExp(`the old name \\(E196\\): packages/http/src/page\\.ts:447: export const VERSION_HEADER = 'x-${OLD}-version';`),
    },
    // --- The company name stays (E153) ------------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: 'the rename took the company name along (the root LICENSE): check-changesets\' licence rule',
      patch: [{ file: 'LICENSE', find: 'Copyright (c) 2026 BespokeCode', replace: 'Copyright (c) 2026 MarmeonCode' }],
      run: { command: ['pnpm', 'run', 'check-changesets'] },
      expect: /LICENSE: MIT with "Copyright \(c\) <year> BespokeCode"/,
    },
    {
      id: 'G2b',
      title: 'the rename took the company name along in a package\'s copy: the licence check names the copy',
      patch: [{ file: 'packages/core/LICENSE', find: 'Copyright (c) 2026 BespokeCode', replace: 'Copyright (c) 2026 MarmeonCode' }],
      run: { command: ['node', 'scripts/sync-license.ts', '--check'] },
      expect: /license: packages\/core\/LICENSE is missing or not the root LICENSE/,
    },
    // --- The discovery field and the scope ---------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'a package keeps the old discovery field: discovery passes it by — its provider is never registered',
      patch: [{ file: 'packages/core/fixtures/discovery/acme-mailer/package.json', find: '"marmeon": { "providers"', replace: `"${OLD}": { "providers"` }],
      run: { vitest: 'packages/core/src/discovery/discovery.test.ts', name: 'makes classes of installed packages injectable and registers their providers' },
      expect: /Command failed: .*\/app\/main\.ts/,
    },
    {
      id: 'G3b',
      title: 'the Vite plugin reads the old field: a framework package without the scope (a third-party adapter) loses its deduped peer',
      patch: [{ file: 'packages/vite/src/index.ts', find: "name !== 'marmeon' && manifest.marmeon === undefined", replace: `name !== 'marmeon' && manifest.${OLD} === undefined` }],
      run: { vitest: 'packages/vite/src/index.test.ts', name: 'dedupes the required peers of framework packages only' },
      expect: /expected \[ 'react', 'react-dom' \] to deeply equal \[ 'react', 'react-dom', 'svelte' \]/,
    },
    {
      id: 'G3c',
      title: 'the Vite plugin knows the old scope: @marmeon/react (no field) loses react and react-dom — the field alone does not cover it',
      patch: [{ file: 'packages/vite/src/index.ts', find: "(!name.startsWith('@marmeon/') && name !== 'marmeon'", replace: `(!name.startsWith('@${OLD}core/') && name !== 'marmeon'` }],
      run: { vitest: 'packages/vite/src/index.test.ts', name: 'dedupes the required peers of framework packages only' },
      expect: /expected \[ 'svelte' \] to deeply equal \[ 'react', 'react-dom', 'svelte' \]/,
      masks: 'G3b',
    },
    // --- The unscoped CLI (E195) ------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the scaffolder\'s prefix check without the unscoped CLI: a new app keeps the template\'s range for marmeon',
      patch: [{ file: 'packages/create-marmeon/src/template.ts', find: "  return name.startsWith('@marmeon/') || name === 'marmeon';", replace: "  return name.startsWith('@marmeon/');" }],
      run: createTest('pins every @marmeon/* and the CLI to its own version'),
      expect: /expected \[ \[ 'marmeon', 'workspace:\*' \] \] to deeply equal \[\]/,
    },
    {
      id: 'G5b',
      title: 'the scaffolder\'s tarball pattern without the CLI (marmeon-<version>.tgz): no tarball for marmeon',
      patch: [{ file: 'packages/create-marmeon/src/template.ts', find: '/^marmeon(?:-(.+))?-\\d+', replace: '/^marmeon-(.+)-\\d+' }],
      run: createTest('vendors them into the app'),
      expect: /No tarball for marmeon in MARMEON_CREATE_TARBALLS/,
    },
    {
      id: 'G5',
      title: 'pack:smoke\'s check of the generated package.json without the CLI\'s tarball name: the kit\'s marmeon is "not its vendored tarball"',
      patch: [{ file: 'scripts/pack-smoke.ts', find: '\\/vendor\\/marmeon\\/marmeon(?:-[\\w-]+)?-\\d+', replace: '\\/vendor\\/marmeon\\/marmeon-[\\w-]+-\\d+' }],
      run: { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * 60_000 },
      expect: /package\.json dependencies\.marmeon is "file:\.\/vendor\/marmeon\/marmeon-0\.1\.0\.tgz", not its vendored tarball/,
    },
    // --- Codes -------------------------------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'the error page\'s solutions still read the old code: a missing view gets no solution',
      patch: [{ file: 'packages/http/src/solutions.ts', find: 'const MISSING_PAGE = /^\\[marmeon:R2\\]', replace: `const MISSING_PAGE = /^\\[${OLD}:R2\\]` }],
      run: { vitest: 'apps/web-app/modules/lab/errors.test.ts', name: 'a missing view (R2) has its solution too' },
      expect: /expected undefined to match object/,
    },
    // --- Why check:source: the temp hygiene sees prefixes only (R8) --------------------------------------------------------------
    {
      id: 'X1',
      title: 'masking probe: tempDir with the old prefix and without its clean-up — the hygiene (marmeon-*) never sees the leftover: green',
      patch: [
        { file: 'scripts/test/temp-dir.js', find: '  const dir = mkdtempSync(join(tmpdir(), prefix));', replace: `  const dir = mkdtempSync(join(tmpdir(), prefix.replace('marmeon-', '${OLD}-')));` },
        { file: 'scripts/test/temp-dir.js', find: '  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });\n', replace: '' },
      ],
      run: { vitest: 'packages/core/src/environment.test.ts' },
      expectGreen: true,
    },
    {
      id: 'G7',
      title: 'the same leftover under the new prefix: the hygiene fails the run (the control of X1)',
      patch: [{ file: 'scripts/test/temp-dir.js', find: '  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });\n', replace: '' }],
      run: { vitest: 'packages/core/src/environment.test.ts' },
      expect: /The tests left \d+ temporary entr(?:y|ies) behind[\s\S]*marmeon-env-/,
    },
    {
      id: 'G7b',
      title: 'the helper with the old prefix (X1\'s patch): check:source names it — what the hygiene cannot',
      patch: [{ file: 'scripts/test/temp-dir.js', find: '  const dir = mkdtempSync(join(tmpdir(), prefix));', replace: `  const dir = mkdtempSync(join(tmpdir(), prefix.replace('marmeon-', '${OLD}-')));` }],
      run: { command: ['pnpm', 'run', 'check:source'] },
      expect: new RegExp(`the old name \\(E196\\): scripts/test/temp-dir\\.js:\\d+: .*prefix\\.replace\\('marmeon-', '${OLD}-'\\)`),
    },
  ],
});
