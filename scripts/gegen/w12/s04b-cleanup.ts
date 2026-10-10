import { defineGegenproben } from '../define.ts';

/**
 * W12.4b — the cleanup before the first release. A case per measure against recurrence; the id is the finding's number.
 *
 * - **What existed only for older apps stays gone** (45–47, E216): `make:session-table` takes `--upgrade` again (G45); the database
 *   session store wraps a driver's error in the upgrade advice again (G45b); the web app's sessions table no longer the stub's
 *   (G46: made without `version`); `paginationFrom` exported again (G47); `create-marmeon` parses `--private-registration` again
 *   (G47b); the starter's users table made without `first_verified_at` again, as if a later migration added it (G47c). Final
 *   review: the web app's users table alike — made without `first_verified_at`, a later migration adding it with a backfill (G47d);
 *   a later migration that names one of the folded columns beside the full table (G47e).
 * - **A named connection reads the server in parts or as one URL** (50) — `defineConnection` without the conversion hands the parts
 *   to the connections as they are (G50); the URL no longer wins over the parts (G50b: the default connection's DB_URL).
 * - **The small items** — the lint preset warns about `#event` again (G27); the configuration hint takes the first capital word
 *   again (G28: "Set A in .env" for a nested `SMTP.HOST`); the scheduler's 30 s in the Compose file (G28b) and in its systemd unit
 *   (G28c), which its own drain fills; factory `make()` typed as insertable rows again (G37, a type test — `tsc`); the OpenTelemetry
 *   install command without the tested minor (G38); a job that fails without throwing without `error.type` (G40).
 * - **The docs' search** (48) — the heading of a name's words not counted (G48: "One server only" 7th for onOneServer); code blocks
 *   counted like prose again (G48b: five calls beat one sentence); a heading of the words counted without the section using the
 *   name (G48c: "One server with Compose" comes up).
 * - **Rule 5 reads the apps** (44) — the apps' texts out of the decision-number rule (G44: its unit test); a wave back in the web
 *   app's .env.example (G44b: check:source names it).
 * - **A failed job's text is masked by the app's Redactor** (carry-over) — `describeError` without it (GR1: the session cookie's
 *   value in `failed_jobs`); the worker's log line by the core's list only (GR2). Two cases: one masking cannot hide the other's
 *   path — the stored text is checked before the log line.
 */
const SESSIONS = { vitest: 'packages/session/src/provider.test.ts' } as const;
const SOURCE = { command: ['node', 'scripts/check-source.ts'] } as const;
const SEARCH = 'apps/docs/modules/docs/search.ts';
const SEARCH_UNIT = (name: string) => ({ vitest: 'apps/docs/modules/docs/search.test.ts', name }) as const;
const CONNECTIONS = (name: string) => ({ vitest: 'packages/database/src/database.test.ts', name }) as const;
const WEB_USERS = 'apps/web-app/modules/auth/migrations/2026_10_01_120000_create_users_table.ts';
const WEB_AVATAR = 'apps/web-app/modules/auth/migrations/2026_10_03_120000_add_avatar_path_to_users_table.ts';
const WEB_USERS_FOLDED = { vitest: 'packages/auth/src/make-auth.test.ts', name: "the web app's users table is made with the starter's account columns" } as const;
const LEAKY = { vitest: 'packages/queue/src/queue.test.ts', name: "masked by the app's Redactor" } as const;

export default defineGegenproben({
  step: 'W12.4b',
  cases: [
    // --- What existed only for older apps -------------------------------------------------------------------------------------
    {
      id: 'G45',
      title: 'make:session-table takes --upgrade again: a second migration to choose for a table no app has',
      patch: [
        {
          file: 'packages/session/src/commands/make-session-table.ts',
          find: "  static options = { module: { type: 'string', short: 'm' } } as const;",
          replace: "  static options = { module: { type: 'string', short: 'm' }, upgrade: { type: 'boolean' } } as const;",
        },
      ],
      run: { ...SESSIONS, name: 'writes one migration' },
      expect: /expected \[ 'module', 'upgrade' \] to deeply equal \[ 'module' \]/,
    },
    {
      id: 'G45b',
      title: 'the database session store names the upgrade again when a query of its table fails',
      patch: [
        {
          file: 'packages/session/src/stores/database.ts',
          find: '`select payload, version from sessions where id = ${key} and last_activity > ${this.#oldest()}`.execute(db);',
          replace:
            '`select payload, version from sessions where id = ${key} and last_activity > ${this.#oldest()}`.execute(db).catch((error: Error) => { throw new Error(`${error.message} — run marmeon make:session-table --upgrade`); });',
        },
      ],
      run: { ...SESSIONS, name: 'goes out as the driver wrote it' },
      expect: /not to contain 'make:session-table'/,
    },
    {
      id: 'G46',
      title: "the web app's sessions table made without version, as before the fold: no longer the stub's",
      patch: [{ file: 'apps/web-app/modules/system/migrations/2026_10_02_203103_create_sessions_table.ts', find: "      table.integer('version').default(1);\n", replace: '' }],
      run: { ...SESSIONS, name: "the web app's sessions table is the stub's" },
      expect: /\/\/ Object\.is equality/,
    },
    {
      id: 'G47',
      title: 'paginationFrom exported again: a second way to a page beside pageQuery()',
      patch: [{ file: 'packages/database/src/index.ts', find: "pageQuery, paginate } from './pagination.ts';", replace: "pageQuery, paginate, pageQuery as paginationFrom } from './pagination.ts';" }],
      run: { vitest: 'packages/database/src/pagination.test.ts', name: "comes from the route's parsed query alone" },
      expect: /to not include 'paginationFrom'/,
    },
    {
      id: 'G47b',
      title: 'create-marmeon parses --private-registration again: the flag is taken, the kit made',
      patch: [{ file: 'packages/create-marmeon/src/main.ts', find: "        minimal: { type: 'boolean' },\n", replace: "        minimal: { type: 'boolean' },\n        'private-registration': { type: 'boolean' },\n" }],
      run: { vitest: 'packages/create-marmeon/src/create.test.ts', name: 'the starter kit adds the home module' },
      expect: /expected \+0 to be 2/,
    },
    {
      id: 'G47c',
      title: "the starter's users table made without first_verified_at, as if a later migration added it",
      patch: [{ file: 'packages/auth/stubs/react/modules/auth/migrations/0001_01_01_000000_create_users_table.ts', find: "      table.timestamp('first_verified_at').nullable();\n", replace: '' }],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'makes one module, private by default' },
      expect: /to contain '\\'first_verified_at\\''/,
    },
    {
      id: 'G47d',
      title: "the web app's users table made without first_verified_at again, a later migration adding it with a backfill for rows no app has",
      patch: [
        { file: WEB_USERS, find: "      table.timestamp('first_verified_at').nullable();\n", replace: '' },
        {
          file: WEB_AVATAR,
          find: "  up: (schema) => schema.alter('users', (table) => table.string('avatar_path', 255).nullable()),",
          replace:
            "  up: async (schema) => {\n    await schema.alter('users', (table) => table.string('avatar_path', 255).nullable());\n    await schema.alter('users', (table) => table.timestamp('first_verified_at').nullable());\n    await sql`update users set first_verified_at = email_verified_at where email_verified_at is not null`.execute(schema.db);\n  },",
        },
        { file: WEB_AVATAR, find: "import { defineMigration } from '@marmeon/database';", replace: "import { defineMigration, sql } from '@marmeon/database';" },
      ],
      run: WEB_USERS_FOLDED,
      expect: /2026_10_01_120000_create_users_table\.ts makes no first_verified_at/,
    },
    {
      id: 'G47e',
      title: "a later migration of the web app's users table names a folded column again, beside the table that has it",
      patch: [
        {
          file: WEB_AVATAR,
          find: "  down: (schema) => schema.alter('users', (table) => table.dropColumn('avatar_path')),",
          replace: "  down: (schema) => schema.alter('users', (table) => (table.dropColumn('avatar_path'), table.dropColumn('pending_email'))),",
        },
      ],
      run: WEB_USERS_FOLDED,
      expect: /later migrations of the users table add the starter's account columns: 2026_10_03_120000_add_avatar_path_to_users_table\.ts/,
    },
    // --- The database's variables -----------------------------------------------------------------------------------------------
    {
      id: 'G50',
      title: "a named connection's parts go to the connections as they are: no URL is made of host, port and database",
      patch: [
        {
          file: 'packages/database/src/config.ts',
          find: 'resolve: (e: InferOutput<Schema>) => connectionOptions(name, definition.resolve(e))',
          replace: 'resolve: (e: InferOutput<Schema>) => definition.resolve(e) as ConnectionOptions',
        },
      ],
      run: CONNECTIONS('a connection of its own reads the same two ways'),
      expect: /expected \{ driver: 'pgsql', …\(\d+\) \} to deeply equal \{ driver: 'pgsql', …\(\d+\) \}/,
    },
    {
      id: 'G50b',
      title: 'DB_URL no longer wins: with DB_DATABASE set, the parts make the address',
      patch: [{ file: 'packages/database/src/config.ts', find: '  if (options.url !== undefined) return', replace: '  if (options.url !== undefined && options.database === undefined) return' }],
      run: CONNECTIONS('DB_URL wins over DB_HOST & co.'),
      expect: /to deeply equal \{ driver: 'pgsql', …\(\d+\) \}/,
    },
    // --- The small items --------------------------------------------------------------------------------------------------------
    {
      id: 'G27',
      title: "the lint preset warns about an event's `readonly #event = true` again: make:event's class fails --deny-warnings",
      patch: [{ file: 'packages/cli/src/commands/make-lint-config.ts', find: ", 'no-unused-private-class-members': 'off' },", replace: ' },' }],
      run: { vitest: 'packages/cli/src/make-lint-config.test.ts', name: 'lets an event be a type of its own' },
      expect: /not to contain 'no-unused-private-class-members'/,
    },
    {
      id: 'G28',
      title: 'the configuration hint takes the first capital word again: "Set A in .env" for a nested SMTP.HOST',
      patch: [{ file: 'packages/core/src/core-solutions.ts', find: '/•\\s*[\\w.-]+:\\s*([^\\s—]+) — /g', replace: '/•\\s*[\\w.-]+:\\s*([A-Z][A-Z0-9_]*)\\s/g' }],
      run: { vitest: 'packages/core/src/solutions.test.ts', name: 'a nested variable keeps its whole path' },
      expect: /Set A in \.env/,
    },
    {
      id: 'G28b',
      title: "the scheduler's Compose grace is 30 s again — what its drain alone may take",
      patch: [{ file: 'packages/cli/src/docker.ts', find: "    '    stop_grace_period: 45s',", replace: "    '    stop_grace_period: 30s'," }],
      run: { vitest: 'packages/cli/src/make-docker.test.ts', name: 'more time to stop than its runs get' },
      expect: /expected 30 to be greater than 40/,
    },
    {
      id: 'G28c',
      title: "the scheduler's systemd TimeoutStopSec is 30 again",
      patch: [{ file: 'packages/cli/src/docker.ts', find: "'schedule:work', 45, [", replace: "'schedule:work', 30, [" }],
      run: { vitest: 'packages/cli/src/make-docker.test.ts', name: 'more time to stop than its runs get' },
      expect: /expected 30 to be greater than 40/,
    },
    {
      id: 'G37',
      title: 'factory make() typed as insertable rows again: a related factory\'s column claims to be a number',
      patch: [
        {
          file: 'packages/database/src/factories.ts',
          find: '  ): Many extends true ? MadeAttributes<Insertable<DB[T]>, O>[] : MadeAttributes<Insertable<DB[T]>, O> {',
          replace: '  ): Many extends true ? Insertable<DB[T]>[] : Insertable<DB[T]> {',
        },
      ],
      run: { command: ['node_modules/.bin/tsc', '--noEmit', '-p', 'packages/database'] },
      expect: /factories\.test\.ts\(\d+,\d+\): error TS2344/,
    },
    {
      id: 'G38',
      title: 'the OpenTelemetry install command names ^1 again — a range the package was never tested with',
      patch: [{ file: 'packages/otel/src/api.ts', find: "export const OTEL_INSTALL = 'pnpm add @opentelemetry/api@^1.9.0';", replace: "export const OTEL_INSTALL = 'pnpm add @opentelemetry/api@^1';" }],
      run: { vitest: 'packages/otel/src/otel.test.ts', name: 'without @opentelemetry/api' },
      expect: /to contain '@marmeon\/otel needs the OpenTelemetry/,
    },
    {
      id: 'G40',
      title: 'a job that fails without throwing gets the error status only — no error.type',
      patch: [{ file: 'packages/otel/src/tracer.ts', find: "    span.setAttribute('error.type', OTHER_ERROR);\n", replace: '' }],
      run: { vitest: 'packages/otel/src/otel.test.ts', name: 'fails without throwing' },
      expect: /expected undefined to be '_OTHER'/,
    },
    // --- The docs' search -------------------------------------------------------------------------------------------------------
    {
      id: 'G48',
      title: 'a heading of the words of a name does not count: "One server only" behind code that calls onOneServer()',
      patch: [{ file: SEARCH, find: '        const named = (inText > 0 || inCode) && words.length > 1 &&', replace: '        const named = false && words.length > 1 &&' }],
      run: { vitest: 'apps/docs/modules/docs/docs.test.ts', name: 'puts a section that explains a word before code' },
      expect: /expected \d+ to be less than 3/,
    },
    {
      id: 'G48b',
      title: 'code blocks count like prose again: five calls in an example beat the sentence that explains the word',
      patch: [{ file: SEARCH, find: '(inCode ? CODE_WEIGHT : 0)', replace: 'occurrences(entry.lowerCode, term, 5)' }],
      run: SEARCH_UNIT('puts a sentence that names a word before code'),
      expect: /expected \[ 'Examples', 'Clearing' \] to deeply equal \[ 'Clearing', 'Examples' \]/,
    },
    {
      id: 'G48c',
      title: 'a heading of the words counts without the name in the section: "One server with Compose" is a hit',
      patch: [{ file: SEARCH, find: '        const named = (inText > 0 || inCode) && words.length > 1 &&', replace: '        const named = words.length > 1 &&' }],
      run: SEARCH_UNIT('takes a heading of the words of a name'),
      expect: /\["One server only","One server with Compose","Missed runs"\]/,
    },
    // --- Rule 5 reads the apps --------------------------------------------------------------------------------------------------
    {
      id: 'G44',
      title: "the apps' READMEs and .env files out of the decision-number rule: its unit test is red",
      patch: [
        {
          file: 'scripts/check-source.ts',
          find: "    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES, APP_TEXTS],\n    why: 'say what was decided",
          replace: "    files: [DOCS_PAGES, PACKAGE_CARDS, ROOT_TEXTS, APP_COPIES],\n    why: 'say what was decided",
        },
      ],
      run: { vitest: 'scripts/ci.test.ts', name: "reads the apps' READMEs and .env files" },
      expect: /a decision number: \[\]: expected \[\] to deeply equal/,
    },
    {
      id: 'G44b',
      title: "a wave back in the web app's .env.example: check:source names it",
      patch: [{ file: 'apps/web-app/.env.example', find: '# Live props: a page', replace: '# Live props (W6.10): a page' }],
      run: SOURCE,
      expect: /a wave reference in an app's README or \.env files \([^)]*\): apps\/web-app\/\.env\.example:99: # Live props \(W6\.10\)/,
    },
    // --- A failed job's text and the app's Redactor ----------------------------------------------------------------------------
    {
      id: 'GR1',
      title: "describeError without the app's Redactor: the session cookie's value reaches failed_jobs",
      patch: [{ file: 'packages/queue/src/worker.ts', find: '      exception: describeError(error, this.#redactor),', replace: '      exception: describeError(error),' }],
      run: LEAKY,
      expect: /to contain 'the store refused shop_session=\[redac/,
    },
    {
      id: 'GR2',
      title: "the worker's log line masked by the core's list only: the value reaches the log",
      patch: [{ file: 'packages/queue/src/worker.ts', find: '    return this.#redactor.text(error instanceof Error ? error.message : String(error));', replace: '    return new Redactor().text(error instanceof Error ? error.message : String(error));' }],
      run: LEAKY,
      expect: /\["Failed test\.leaky: the store refused shop_session=s3ss10nvalue"\]/,
    },
  ],
});
