import { defineGegenproben } from '../define.ts';

/**
 * W10.9b — what the README pass found, fixed (Max's decisions of 08.10.: E206 a foreign schema never runs live, E207 the token prefix).
 *
 * Live validation: another library's schema does not run live (G1) ↔ the request's opt-in `live: true` runs it (G1b); with the opt-in
 * only the mark on our issues keeps a not-live rule out (G1c — G1 masks it otherwise). `.live()` on a container is refused (G2: the
 * refusal and the override gone → an object opened as a whole asks about the address) ↔ `.live()` on a field opens it (G2b).
 * Development routes: outside development a 404 (G3) ↔ the host check (G3b). A change of address keeps the confirmation (G4 web app,
 * G4b the stub through the make:auth fixture). Errors logged as text are masked (G5 a terminate hook, G5b the exception handler's
 * report). `marmeon build` next to a development .env builds for production (G6) ↔ an explicit NODE_ENV stays (G6b: a rule that
 * overrides it is red), and the launcher asks the rule (G6c, pack:smoke). A handler's ValidationError gets the request's labels (G7
 * the router, G7b the lab's race). A default sort on a hidden column is refused (G8). check:source covers apps and the template (G9)
 * and Vite's DEV (G9b), and the old token prefix (G10 the default, G10b the rule). A deleted account's data export goes (G11). The
 * reference apps carry the fair claim's index in a migration of their own (G12).
 */
const OLD_PREFIX = `${['b', 'c'].join('')}_`;
const REQUEST = 'packages/router/src/request-definition.ts';
const RULE = 'packages/validation/src/rule.ts';
const DEV = 'packages/core/src/dev.ts';
const ENV = 'packages/core/src/environment.ts';
const CHECK = 'scripts/check-source.ts';
const COALESCE = "    await this.db.updateTable('users').set({ first_verified_at: sql<Date>`coalesce(first_verified_at, email_verified_at)` }).where('id', '=', id).execute();\n";
const foreign = (name: string) => ({ vitest: 'packages/router/src/standard-schema.test.ts', name }) as const;
const requests = (name: string) => ({ vitest: 'packages/validation/src/request.test.ts', name }) as const;
const devGuard = (name: string) => ({ vitest: 'packages/core/src/dev.test.ts', name }) as const;
const kernel = (name: string) => ({ vitest: 'packages/server/src/kernel.test.ts', name }) as const;
const environment = (name: string) => ({ vitest: 'packages/core/src/environment.test.ts', name }) as const;
const ci = (name: string) => ({ vitest: 'scripts/ci.test.ts', name }) as const;
const prune = (name: string) => ({ vitest: 'apps/web-app/modules/auth/prune-unverified.test.ts', name }) as const;

export default defineGegenproben({
  step: 'W10.9b',
  cases: [
    // --- E206: a schema of another library never runs live ------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'no vendor check: a Zod-like schema runs live — a taken and a free address get different answers, its refine ran',
      patch: [{ file: REQUEST, find: '  if (only && !definition.live && !runsLive(schema)) return query ? { query } : {};\n', replace: '' }],
      run: foreign('without `live: true` the schema never runs live'),
      expect: /a live validation ran a foreign schema: expected \[ …\(3\) \] to deeply equal \[ \{ status: 204 \}/,
      masks: 'G1c',
    },
    {
      id: 'G1b',
      title: 'the opt-in ignored: `live: true` does not run the foreign schema live — the app\'s word counts for nothing',
      patch: [{ file: REQUEST, find: '  if (only && !definition.live && !runsLive(schema))', replace: '  if (only && !runsLive(schema))' }],
      run: foreign('`live: true` lets it run'),
      expect: /expected \{ status: 204 \} to deeply equal \{ status: 422/,
      masks: 'G1',
    },
    {
      id: 'G1c',
      title: 'without the NOT_LIVE filter: a foreign schema let run live (`live: true`) calls our async custom without the request — it tells',
      patch: [{ file: REQUEST, find: ' && !(issue as { [NOT_LIVE]?: boolean })[NOT_LIVE]', replace: '' }],
      run: requests('a rule that ran anyway'),
      expect: /a live validation told what a not-live rule found: expected \{ Object \(code\) \} to be undefined/,
      masks: 'G1',
    },
    // --- E197: .live() goes on the field -----------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: '.live() on a container not refused (the check and the object\'s override): the object opens every rule inside — the address too',
      patch: [
        { file: RULE, find: "    if (this['~rule'].container) throw new TypeError(LIVE_ON_CONTAINER);\n", replace: '' },
        {
          file: RULE,
          find: 'whose being taken is no secret — it throws here. */\n  override live(this: typeof LIVE_ON_CONTAINER): never {\n    throw new TypeError(LIVE_ON_CONTAINER);',
          replace: 'whose being taken is no secret — it throws here. */\n  override live(this: typeof LIVE_ON_CONTAINER): never {\n    return super.live() as never;',
        },
      ],
      run: requests('what the refusal on a container prevents'),
      expect: /a live validation asked about the address: expected \[ 'ada@example\.com', 'ada' \] to deeply equal \[\]/,
      masks: 'G2b',
    },
    {
      id: 'G2b',
      title: '.live() on the field does nothing: the slug\'s unique stays closed in a live validation — the opt-in is lost',
      patch: [{ file: RULE, find: '    const own = definition.live && !context.liveOptIn ? { ...context, liveOptIn: true } : context;', replace: '    const own = context;' }],
      run: requests('.live() opts in: the rule runs and tells'),
      expect: /expected undefined to deeply equal \{ Object \(email\) \}/,
      masks: 'G2',
    },
    // --- devOnly: the environment and the host -----------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'devOnly without the environment check: under NODE_ENV=production a route of APP_URL\'s (public) host answers 200',
      patch: [{ file: DEV, find: '    if (!devEnvironment()) return notInDevelopment();\n', replace: '' }],
      run: devGuard('NODE_ENV=production: the handler never runs'),
      expect: /shop\.example under NODE_ENV=production: expected 200 to be 404/,
      masks: 'G3b',
    },
    {
      id: 'G3b',
      title: 'devOnly without the host check: in development a foreign Host gets the page (DNS rebinding)',
      patch: [{ file: DEV, find: '    return hostAllowed(args[0].request, hosts) ? devSecured(await handler(...args)) : forbiddenDevHost();', replace: '    return devSecured(await handler(...args));' }],
      run: devGuard('development and test: the host decides'),
      expect: /development: expected 200 to be 403/,
      masks: 'G3',
    },
    // --- E203: a change of address keeps the confirmation --------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the web app\'s changeEmail without the coalesce: an account confirmed by email_verified_at alone loses it — and is pruned',
      patch: [{ file: 'apps/web-app/modules/auth/UserRepository.ts', find: COALESCE, replace: '' }],
      run: prune('keeps that through a change of address (open mode)'),
      expect: /the change dropped the only confirmation: expected null not to be null/,
    },
    {
      id: 'G4b',
      title: 'the stub\'s changeEmail without the coalesce: the generated app\'s test fails — the make:auth fixture names it',
      patch: [{ file: 'packages/auth/stubs/react/modules/auth/UserRepository.ts', find: COALESCE, replace: '' }],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'working auth area', timeout: 15 * 60_000 },
      expect: /generated tests failed: modules\/auth\/prune-unverified\.test\.ts > pruning accounts whose address was never confirmed with AUTH_PRIVATE_REGISTRATION=false \(E193\) > an account confirmed by email_verified_at alone/,
    },
    // --- E125: errors logged as text -----------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'a terminate hook\'s failure as String(error): the connection URL\'s password reaches the log line in clear',
      patch: [{ file: 'packages/server/src/kernel.ts', find: "logger.error('A terminate hook failed', { exception: redactText(String(error)) })", replace: "logger.error('A terminate hook failed', { exception: String(error) })" }],
      run: kernel('logs a failing terminate hook'),
      expect: /a terminate hook's failure logged its message in clear: expected .*s3cretPW/,
    },
    {
      id: 'G5b',
      title: 'the exception handler\'s report unmasked: an error\'s message (the log line\'s text) carries the URL password',
      patch: [{ file: 'packages/http/src/errors.ts', find: 'this.#logger.error(redactText(message), { exception: name, stack: redactText(stack) });', replace: 'this.#logger.error(message, { exception: name, stack });' }],
      run: kernel('hides unexpected errors from clients'),
      expect: /the report logged a URL password in clear: expected .*hunter3/,
    },
    // --- marmeon build next to a development .env ----------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'buildEnvironment without the .env rule: NODE_ENV=development of .env reaches the build (a development client)',
      patch: [{ file: ENV, find: '  if (environment.isDevelopment(env) && environment.fromDotEnv(env)) {', replace: '  if (false) {' }],
      run: environment('is set aside'),
      expect: /the development NODE_ENV of \.env reached the build: expected 'development' to be 'production'/,
      masks: 'G6b',
    },
    {
      id: 'G6b',
      title: 'the rule over-reaching: an explicit NODE_ENV=development of the shell is overridden too — the environment no longer wins',
      patch: [{ file: ENV, find: '  if (environment.isDevelopment(env) && environment.fromDotEnv(env)) {', replace: '  if (environment.isDevelopment(env)) {' }],
      run: environment('a NODE_ENV the environment sets is respected'),
      expect: /an explicit NODE_ENV was overridden: expected 'production' to be 'development'/,
      masks: 'G6',
    },
    {
      id: 'G6c',
      title: 'the launcher does not ask the rule: npm run build next to the kit\'s development .env builds a development client',
      patch: [
        {
          file: 'packages/cli/bin/marmeon.js',
          find: "  if (launch === 'build') {\n    // What the build bakes into dist/client",
          replace: "  if (launch === 'build' && false) {\n    // What the build bakes into dist/client",
        },
      ],
      run: { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * 60_000 },
      expect: /npm run build with the development \.env built a development client — assets\/[\w.-]+\.js/,
    },
    // --- a handler's ValidationError speaks with the request's labels --------------------------------------------------------------
    {
      id: 'G7',
      title: 'the router lends no labels: failOnDuplicate\'s 422 after a race ignores messages and attributes',
      patch: [{ file: 'packages/router/src/router.ts', find: '            throw action.request ? withRequestLabels(error, action.request) : error;', replace: '            throw error;' }],
      run: requests('a ValidationError of the handler'),
      expect: /the router did not lend the request's labels: expected undefined to deeply equal/,
    },
    {
      id: 'G7b',
      title: 'the same in the web app: the lab\'s race answers "Der Wert für email …" instead of the field\'s name (E-Mail)',
      patch: [{ file: 'packages/router/src/router.ts', find: '            throw action.request ? withRequestLabels(error, action.request) : error;', replace: '            throw error;' }],
      run: { vitest: 'apps/web-app/modules/lab/validation.test.ts', name: 'as after a race' },
      expect: /Expected "email" to fail with Der Wert für E-Mail ist bereits vergeben\., got: Der Wert für email ist bereits vergeben\./,
    },
    // --- a table's default sort ---------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'defaultSort on a .visible() column accepted: whoever may not see it gets a 400 on the page itself',
      patch: [{ file: 'packages/table/src/define.ts', find: "  if (typeof defaultSort === 'string' && !forEveryone.includes(defaultSort.replace(/^-/, ''))) {", replace: '  if (false) {' }],
      run: { vitest: 'packages/table/src/state.test.ts', name: 'a default sort is every user' },
      expect: /expected \[Function\] to throw an error/,
    },
    // --- check:source ------------------------------------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'rule 3 over packages only again: a negative NODE_ENV check in an app or the starter\'s template passes',
      patch: [{ file: CHECK, find: '|packages\\/create-marmeon\\/template\\/|apps\\/[^/]+\\/)', replace: ')' }],
      run: ci('covers the apps and the starter'),
      expect: /expected \[ Array\(1\) \] to deeply equal \[ …\(4\) \]/,
      masks: 'G9b',
    },
    {
      id: 'G9b',
      title: 'rule 3 without Vite\'s DEV: `import.meta.env.DEV` (true in a staging build) passes',
      patch: [{ file: CHECK, find: "    `\\\\bimport\\\\.meta\\\\.env\\\\.DEV\\\\b`, // Vite's DEV: true for any NODE_ENV but production (a staging build)\n", replace: '' }],
      run: ci('covers the apps and the starter'),
      expect: /expected \[ …\(2\) \] to deeply equal \[ …\(4\) \]/,
      masks: 'G9',
    },
    {
      id: 'G10',
      title: 'the old default prefix of API tokens back in the auth config: check:source names it (E207)',
      patch: [{ file: 'packages/auth/src/config.ts', find: "'lower-case letters, digits and _ only')), 'marmeon_'),", replace: `'lower-case letters, digits and _ only')), '${OLD_PREFIX}'),` }],
      run: { command: ['pnpm', 'run', 'check:source'] },
      expect: /the old token prefix \(E207 — API tokens start with marmeon_\): packages\/auth\/src\/config\.ts:19/,
    },
    {
      id: 'G10b',
      title: 'rule 4 without its pattern: the old prefix in a README or a test passes',
      patch: [{ file: CHECK, find: '    if (!OLD_PREFIX.test(text)) continue;\n', replace: '    continue;\n' }],
      run: ci('finds it before a digit'),
      expect: /expected \[\] to deeply equal \[/,
    },
    // --- E203: what goes with an account -------------------------------------------------------------------------------------------
    {
      id: 'G11',
      title: 'no listener for the data export: a deleted account\'s address and name stay on the private disk',
      patch: [{ file: 'apps/web-app/modules/user-profile/index.ts', find: ', listen(AccountDeleted, DeleteDataExport)]', replace: ']' }],
      run: prune('data export goes too'),
      expect: /Expected no "exports\/user-\d+\.json" on the disk "local"/,
    },
    // --- the fair claim's index in the reference apps ------------------------------------------------------------------------------
    {
      id: 'G12',
      title: 'the web app\'s index migration without the index: the reference app no longer shows the way an older app goes',
      patch: [
        {
          file: 'apps/web-app/modules/system/migrations/2026_10_08_090000_add_fair_claim_index_to_jobs_table.ts',
          find: "table.index(['reserved_at', 'available_at', 'id'])",
          replace: "table.index(['reserved_at', 'available_at'])",
        },
      ],
      run: { vitest: 'packages/queue/src/commands/commands.test.ts', name: "jobs tables are the stub's" },
      expect: /apps\/web-app\/modules\/system\/migrations\/: expected .* to contain/,
    },
  ],
});
