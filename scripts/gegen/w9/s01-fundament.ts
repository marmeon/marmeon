import { defineGegenproben } from '../define.ts';

/**
 * W9.1 — the foundation: the Gegenproben runner itself (E188), the budget's reset with a reserve that stays (E186), the test suite's
 * temporary files (E187), the bench's checkouts. The runner's own guarantees are proven against a fixture repository
 * (`scripts/gegen/run.test.ts`); the size cases need `pnpm build` first (the size test measures `dist/`).
 */
const RUNNER = 'scripts/gegen/run.ts';
const runnerTest = (name: string) => ({ vitest: 'scripts/gegen/run.test.ts', name });
const BUNDLE = 'packages/react/src/__fixtures__/bundle.ts';
const coreSize = { vitest: 'packages/react/src/bundle-size.test.ts', name: 'stays within its budget (E75: a ratchet) > core' };
const budgetTest = (name: string) => ({ vitest: 'packages/react/src/size-budget.test.ts', name });

export default defineGegenproben({
  step: 'W9.1',
  cases: [
    // --- The runner (E188) ---------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'without the anchor pre-check a two-file patch with a missing second anchor is applied half',
      patch: [{ file: RUNNER, find: '    if (count !== 1) {', replace: '    if (count > 1) {' }],
      run: runnerTest('a missing anchor in a two-file patch changes nothing — not even the file whose anchor is there'),
      expect: /to contain 'anchor problem — nothing was patched/,
    },
    {
      id: 'G2',
      title: 'without the count of tests that ran, a filter that matches nothing counts as GREEN',
      patch: [{ file: RUNNER, find: "    if (!failed && tests === 0) return { kind: 'zero'", replace: "    if (false) return { kind: 'zero'" }],
      run: runnerTest('a name filter that matches no test is "0 tests" — never red, never green'),
      expect: /to contain '✗ 0 tests ran/,
    },
    {
      id: 'G2b',
      title: 'without escaping, a test name with () matches nothing under -t (a regex): 0 tests instead of red',
      patch: [{ file: RUNNER, find: "['-t', escapeTestName(run.name)]", replace: "['-t', run.name]" }],
      run: runnerTest('a case turns red for its reason — the name with () is escaped for -t, the patch is taken back'),
      expect: /to contain '✓ red \(reason matches\): AssertionErro/,
    },
    {
      id: 'G3',
      title: 'without the reason check, red for another reason counts as red',
      patch: [{ file: RUNNER, find: "  return entry.expect!.test(outcome.reason) ? 'red' : 'wrong-reason';", replace: "  return 'red';" }],
      run: runnerTest('a failure with another message is "red for another reason", not counted as red'),
      expect: /to contain '✗ red for another reason/,
    },
    {
      id: 'G4',
      title: 'without the signal handlers, SIGINT in the middle of a run leaves the patch in the tree',
      patch: [{ file: RUNNER, find: '  onSignals();\n', replace: '' }],
      run: runnerTest('SIGINT in the middle of a run stops it and takes the patch back'),
      expect: /expected null to be 130/,
    },
    {
      id: 'G5',
      title: 'without the git status comparison, a run that writes an untouched file goes unnoticed',
      patch: [{ file: RUNNER, find: '  if (status !== snapshot.status) {', replace: '  if (false) {' }],
      run: runnerTest('a run that writes a file no patch touched stops the runner loudly (exit 3)'),
      expect: /to contain 'STOPPED — git status changed during t/,
    },
    {
      id: 'G6',
      title: 'gegen as a part of pnpm run ci',
      patch: [
        {
          file: 'scripts/ci.ts',
          find: "  { name: 'check-changesets', command: pnpm('check-changesets') },\n",
          replace: "  { name: 'check-changesets', command: pnpm('check-changesets') },\n  { name: 'gegen', command: pnpm('gegen') },\n",
        },
      ],
      run: { vitest: 'scripts/ci.test.ts', name: 'never runs the Gegenproben' },
      expect: /expected \[ 'gegen' \] to deeply equal \[\]/,
    },

    // --- The budget: reset, the reserve stays (E186) ------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'SHRINK_KB back at 0.3: every reset limit (measured + 0.5) counts as shrunk',
      patch: [{ file: BUNDLE, find: 'export const SHRINK_KB = 0.6;', replace: 'export const SHRINK_KB = 0.3;' }],
      run: coreSize,
      expect: /core shrank to [\d.]+ KB gzip, more than 0\.3 KB under its limit/,
    },
    {
      id: 'G8',
      title: 'a limit more than measured + 0.6 (a hidden extra reserve) fails the size test',
      patch: [{ file: 'packages/react/size-budget.json', find: '"core": { "limit": 11.57 }', replace: '"core": { "limit": 11.68 }' }],
      run: coreSize,
      expect: /core shrank to [\d.]+ KB gzip, more than 0\.6 KB under its limit of 11\.68 KB/,
    },
    {
      id: 'G9',
      title: 'update after a saving lowers to measured + 0.1 (the old tolerance): the reserve would be gone',
      patch: [{ file: BUNDLE, find: 'export const RESERVE_KB = 0.5;', replace: 'export const RESERVE_KB = 0.1;' }],
      run: budgetTest('update lowers a limit after a saving to the measured size + 0.5, to 0.01 KB'),
      expect: /expected 11\.17 to be 11\.57/,
    },
    {
      id: 'G10',
      title: 'update with extra cost: the limit it computes is not capped — it would refill the reserve',
      patch: [{ file: BUNDLE, find: '  return limit < line.limit ? limit : undefined;', replace: '  return limit;' }],
      run: budgetTest('update never raises a limit — extra cost eats the reserve'),
      expect: /expected 11\.57 to be undefined/,
      masks: 'G10b',
    },
    {
      id: 'G10b',
      title: 'update with extra cost: the file writer raises a limit it is given',
      patch: [{ file: BUNDLE, find: '      limit < Number(current) ? `${head}${limit.toFixed(2)}` : whole,', replace: '      `${head}${limit.toFixed(2)}`,' }],
      run: budgetTest('lowerLimits writes two decimals in place, keeps the layout and never raises a limit'),
      expect: /expected 14\.5 to be 14\.08/,
      masks: 'G10',
    },

    // --- Temporary files (E187) ---------------------------------------------------------------------------------------------------
    {
      id: 'G11',
      title: 'tempDir without its clean-up: the run fails and lists what is left',
      patch: [{ file: 'scripts/test/temp-dir.js', find: '  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });\n', replace: '' }],
      run: { vitest: 'packages/core/src/environment.test.ts' },
      expect: /The tests left \d+ temporary entr(?:y|ies) behind[\s\S]*bespoke-env-/,
    },
    {
      id: 'X1',
      title: 'masking probe: tempDir without its clean-up and the run without its check — green, the run directory hides the leak',
      patch: [
        { file: 'scripts/test/temp-dir.js', find: '  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });\n', replace: '' },
        { file: 'scripts/test/temp-hygiene.ts', find: '    if (left.length > 0) {', replace: '    if (false) {' },
      ],
      run: { vitest: 'packages/core/src/environment.test.ts' },
      expectGreen: true,
    },

    // --- The bench's checkouts ------------------------------------------------------------------------------------------------------
    {
      id: 'G12',
      title: 'damaged node_modules in a bench checkout are not removed and installed again: ERR_MODULE_NOT_FOUND',
      patch: [{ file: 'scripts/bench/integrity.ts', find: '  removeNodeModules(checkout);\n  install(checkout);\n', replace: '' }],
      run: { vitest: 'scripts/bench/integrity.test.ts', name: 'damaged node_modules (a file gone) are removed' },
      expect: /still cannot import what the measurement needs after a fresh install:\s+[\s\S]*ERR_MODULE_NOT_FOUND/,
    },
  ],
});
