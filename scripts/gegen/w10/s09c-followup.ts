import { defineGegenproben } from '../define.ts';

/**
 * W10.9c follow-up — two decisions of Max (08.10.) and two findings of the acceptance.
 *
 * E208, an empty string by type: `r.string()` keeps `''` (G1 the rules, G1b a page builder's JSON, G1c the web app's profile: a cleared
 * bio stays) ↔ where `''` never is a value it is missing (G2 a form's empty number field is a 422 without it, G2b the catalogue) — a
 * masking pair: one rule for all hides either half. `r.in()` decides by its options (G3 an empty `<select>` without `''` is missing ↔
 * G3b with `''` among them it is the value), the formats are missing (G4), a union keeps `''` when one of its rules does (G5), `r.env()`
 * takes every empty variable as missing (G6), and the lab's async check lets an empty code pass (G7: the app's own adjustment).
 *
 * E209, deleting unconfirmed accounts is opt-in: the stub's schedule line on again → the generated test "no deletion the module
 * schedules" fails (G8, the make:auth fixture); the boot warning about `AUTH_UNVERIFIED_DAYS=0` is gone (G9).
 *
 * Finding R, token-like path segments: a long base64url token without a digit or with many separators is a token (G10 the rule,
 * G10b the devtools recorder with its fixed token — deterministic now).
 *
 * Finding D, `marmeon dev`'s companions: the server keeps its signal listeners — a library's signal-exit (Rolldown under Vite 8)
 * would end it by the signal (G11, on the build `marmeon start` runs) ↔ a companion stops when its server dies without stopping it:
 * its IPC channel (G12) and the launcher's `disconnect` (G12b) — a masking pair in `marmeon dev`, where either keeps the worker from
 * outliving a SIGTERM; each has its own scenario here (a drain without companions, a SIGKILL no listener can catch).
 */
const RULES = 'packages/validation/src/rules.ts';
const RULE = 'packages/validation/src/rule.ts';
const ENGINE = 'packages/validation/src/engine.ts';
const rules = (name: string) => ({ vitest: 'packages/validation/src/rules.test.ts', name }) as const;
const requests = (name: string) => ({ vitest: 'packages/validation/src/request.test.ts', name }) as const;
const cli = (name: string) => ({ vitest: 'packages/cli/src/cli.test.ts', name }) as const;

export default defineGegenproben({
  step: 'W10.9c+',
  cases: [
    // --- E208: an empty string by type -------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: "r.string() takes '' for missing again: optional/nullable/default turn a cleared subtitle into undefined, null, the default",
      patch: [{ file: RULES, find: 'definition(engine.stringEngine, { keepsEmpty: true })', replace: 'definition(engine.stringEngine, { keepsEmpty: false })' }],
      run: rules("a string keeps ''"),
      expect: /'' was taken for missing: \{"value":\{"caption":null,"cta":"Read more","trimmed":"","plain":""\}\}/,
      masks: 'G2',
    },
    {
      id: 'G1b',
      title: "the same, through a request: a page builder's JSON with the subtitle cleared reaches the handler without it",
      patch: [{ file: RULES, find: 'definition(engine.stringEngine, { keepsEmpty: true })', replace: 'definition(engine.stringEngine, { keepsEmpty: false })' }],
      run: requests('JSON (a page builder)'),
      expect: /the cleared subtitle did not reach the handler: expected 'undefined' to be 'string'/,
    },
    {
      id: 'G1c',
      title: 'the same, in the web app: a bio cleared on purpose is not saved — the profile keeps the old one',
      patch: [{ file: RULES, find: 'definition(engine.stringEngine, { keepsEmpty: true })', replace: 'definition(engine.stringEngine, { keepsEmpty: false })' }],
      run: { vitest: 'apps/web-app/modules/user-profile/user-profile.test.ts', name: 'clears the bio on purpose' },
      expect: /Expected a row in "users" matching \{"id":\d+,"bio":""\} — found none/,
    },
    {
      id: 'G2',
      title: "'' is never missing outside .env: a form's empty number field is a 422 (\"required\") instead of undefined",
      patch: [{ file: ENGINE, find: "if (value === '' && (!keepsEmpty || (config", replace: "if (value === '' && ((config" }],
      run: requests('a form sends the same strings'),
      expect: /a form's empty fields were refused: \{"width":\["The width field is required\."\],"link":\["The link field must be a valid URL\."\],"align":\["The align field is required\."\]\}/,
      masks: 'G1',
    },
    {
      id: 'G2b',
      title: "the same, the catalogue: numbers, booleans, formats, lists, objects and r.value() refuse an empty field",
      patch: [{ file: ENGINE, find: "if (value === '' && (!keepsEmpty || (config", replace: "if (value === '' && ((config" }],
      run: rules("where '' never is a value"),
      expect: /'' refused where it is missing: \["age","price","newsletter","port","email","website","id","day","at","tags","address","token"\]/,
    },
    {
      id: 'G3',
      title: "r.in() keeps '' though it is no option: an empty <select> is an error instead of missing",
      patch: [{ file: RULES, find: "{ keepsEmpty: spelled.has('') }", replace: '{ keepsEmpty: true }' }],
      run: rules('r.in() and r.literal()'),
      expect: /an empty <select> without '' among its options is missing, no error: \["The align field is required\.","The size field is required\."\]/,
      masks: 'G3b',
    },
    {
      id: 'G3b',
      title: "r.in() never keeps '': an option '' (r.in(['', 'bold'])) becomes undefined",
      patch: [{ file: RULES, find: "{ keepsEmpty: spelled.has('') }", replace: '{ keepsEmpty: false }' }],
      run: rules('r.in() and r.literal()'),
      expect: /r\.in\(\['', 'bold'\]\) lost its option '': expected undefined to be ''/,
      masks: 'G3',
    },
    {
      id: 'G4',
      title: "the formats keep '' like a string: an empty optional e-mail address, URL, UUID or date is an error",
      patch: [{ file: RULE, find: 'const FORMAT = { keepsEmpty: false } as const;', replace: 'const FORMAT = {} as const;' }],
      run: rules("where '' never is a value"),
      expect: /'' refused where it is missing: \["email","website","id","day","at"\]/,
    },
    {
      id: 'G5',
      title: "a union never keeps '': r.union([r.integer(), r.string()]).optional() turns '' into undefined",
      patch: [{ file: RULES, find: "keepsEmpty: options.some((option) => option['~rule'].keepsEmpty),", replace: 'keepsEmpty: false,' }],
      run: rules('r.union()'),
      expect: /a union with r\.string\(\) lost '': expected undefined to be ''/,
    },
    {
      id: 'G6',
      title: "r.env() like a form: S3_BUCKET= is '' (\"set\") instead of missing",
      patch: [{ file: RULES, find: "objectRule(fields as S, 'raw', true)", replace: "objectRule(fields as S, 'raw')" }],
      run: rules('r.env()'),
      expect: /S3_BUCKET= is "not set": expected '' to be undefined/,
    },
    {
      id: 'G7',
      title: "the lab's invitation check asks for '' too: an empty code field is \"unknown\"",
      patch: [
        {
          file: 'apps/web-app/modules/lab/controllers/ValidationLabController.ts',
          find: "custom(async (code, { request }) => code === '' || (await request!",
          replace: 'custom(async (code, { request }) => (await request!',
        },
      ],
      run: { vitest: 'apps/web-app/modules/lab/validation.test.ts', name: 'an async custom' },
      expect: /Expected no validation errors, got: \{"invite":\["This invitation code is unknown\."\]\}/,
    },

    // --- E209: deleting unconfirmed accounts is the app's decision ---------------------------------------------------------------------
    {
      id: 'G8',
      title: "the stub schedules the deletion again: the generated app's test names it — the make:auth fixture fails",
      patch: [
        {
          file: 'packages/auth/stubs/react/modules/auth/schedule.ts',
          find: "  // s.command('auth:prune-unverified').daily().at('03:20').onOneServer();\n",
          replace: "  s.command('auth:prune-unverified').daily().at('03:20').onOneServer();\n",
        },
      ],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'working auth area', timeout: 15 * 60_000 },
      expect: /generated tests failed: modules\/auth\/prune-unverified\.test\.ts > pruning accounts whose address was never confirmed — the default > is no deletion the module schedules/,
    },
    {
      id: 'G9',
      title: 'the boot warns about AUTH_UNVERIFIED_DAYS=0 again — a default to warn about that is none',
      patch: [
        {
          file: 'packages/auth/src/index.ts',
          find: '    const cli = await import(',
          replace: "    if (config.protected && config.unverifiedDays === 0) app.container.make(Logger).warn('AUTH_UNVERIFIED_DAYS=0 outside development and tests: accounts are kept forever.');\n    const cli = await import(",
        },
      ],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: '0 is no boot warning' },
      expect: /production: expected \[ Array\(1\) \] to deeply equal \[\]/,
    },

    // --- Finding R: token-like path segments -----------------------------------------------------------------------------------------
    {
      id: 'G10',
      title: 'the token rule before: a 43-character reset token without a digit (or with many - and _) stays in the text',
      patch: [{ file: 'packages/core/src/redact.ts', find: '  if (segment.length >= LONG_SEGMENT) return mixedCase;\n', replace: '' }],
      run: { vitest: 'packages/core/src/redact.test.ts', name: 'masks every long random token' },
      expect: /xcTSGsRRdFsBwbUDGMbH_yNyUBMgdklqlolrXjzXiiI: expected 'Reset: http:\/\/localhost\/reset-passwor…' to be 'Reset: http:\/\/localhost\/reset-passwor…'/,
    },
    {
      id: 'G10b',
      title: "the same rule, the devtools: the recorder's mail and request keep the fixed token — red every run, not 1 in 370",
      patch: [{ file: 'packages/core/src/redact.ts', find: '  if (segment.length >= LONG_SEGMENT) return mixedCase;\n', replace: '' }],
      run: { vitest: 'packages/devtools/src/recorder.test.ts', name: 'mails with the tokens and signatures in their links masked' },
      expect: /expected '<a href="http:\/\/localhost\/reset-passw…' to contain '\/reset-password\/\[redacted\]\?email=ada%…'/,
    },

    // --- Finding D: the companions of `marmeon dev` ----------------------------------------------------------------------------------
    {
      id: 'G11',
      title: 'the server listens with once again (the build): a signal-exit that finds itself alone ends it by the signal, no drain',
      patch: [{ file: 'packages/cli/dist/commands/serve.js', find: "    process.on('SIGINT', onInt).on('SIGTERM', onTerm);", replace: "    process.once('SIGINT', onInt).once('SIGTERM', onTerm);" }],
      run: cli('a library that re-raises a signal it is alone with'),
      expect: /expected null to be \+0/,
      masks: 'G12',
    },
    {
      id: 'G12',
      title: 'no IPC channel to a companion: when its server is killed, the companion and its launcher\'s child keep running',
      patch: [{ file: 'packages/cli/src/spawn.ts', find: "stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });", replace: "stdio: 'inherit' });" }],
      run: cli('a companion stops by itself'),
      expect: /left running after its server was killed/,
      masks: 'G11',
    },
    {
      id: 'G12b',
      title: "the launcher ignores the closed channel: the companion lives on (the channel alone stops nothing)",
      patch: [{ file: 'packages/cli/bin/marmeon.js', find: "    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));\n", replace: '' }],
      run: cli('a companion stops by itself'),
      expect: /left running after its server was killed/,
    },
  ],
});
