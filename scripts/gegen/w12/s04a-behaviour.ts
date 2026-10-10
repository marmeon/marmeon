import { defineGegenproben } from '../define.ts';

/**
 * W12.4a — the behaviour findings of the docs wave. A case per finding whose fix is a measure against recurrence; the case's id is
 * the finding's number.
 *
 * - **The image's health check follows `HEALTH_PATH=off`** (G6) — without the switch it fetches `http://127.0.0.1:3000off` and the
 *   container turns unhealthy although the app runs.
 * - **`marmeon <command> --help` prints the command's help** (G7) — without `wantsHelp()` the flag is an unknown option: exit 1.
 * - **A `<Link>` that sends is a real form** — four measures, each its own case: a `type="button"` again (G8) does nothing without
 *   JavaScript (the starter's sign-out among them); the page's token left out (G8b) gets the session's form a 419; the click not
 *   stopped (G8c) posts the form beside the visit — two requests, the second after the page changed; a link with `confirm` that
 *   submits anyway (G8d) sends without asking before the app started. Fix round 1: the page's token goes to this site only (G8e: a
 *   link to another origin carries it); a sending link back in a `<p>` (G8f: the web app's VerifyEmail) fails `assertHydrates()`,
 *   whose nesting check names it. Final review: another origin as the URL parser reads it, not by the href's first characters (G8g:
 *   `"/\t/elsewhere.example"`, `"/\n/…"` and `" //…"` get the token).
 * - **A read-only request's message names its own cause** — the layer's base (G9) and the deferred prop streamed after the headers
 *   (G9b) without a rule of their own fall back to an island's: "an island is read-only … Do that in the page".
 * - **A provider with only `static solutions` is one** (G11) — without the check's third static it stops the start.
 * - **`throttle()` with a list of limits** — three measures: the headers of the last limit again (G12: `100`/`99` beside a per-second
 *   limit with one attempt left); the server's start no longer asks the middleware (G12b: an undefined limiter boots, its route
 *   answers 500 at the first request); `ctx.user` not added to a limiter's context by `@marmeon/auth` (G12c: the web app's limiters
 *   do not compile without a cast).
 * - **An export goes on after the last row it wrote** (G13) — by OFFSET again, two rows of the first batch deleted meanwhile push
 *   "Bulk 0500" out of the file; a cursor that refuses booleans (G13b) ends a boolean-sorted export at its second batch.
 * - **`job.once` on a busy key releases the attempt and gives it back** — two measures: the worker treats the busy key as an error
 *   again (G14: a job with one try fails); it releases without giving the attempt back (G14b: the next claim is attempt 2 of 1 and
 *   fails as "attempted without finishing"). Run on SQLite; `pnpm test:pgsql` / `test:redis` run the same test on the other drivers.
 * - **`make:controller --request --view` on a writing name is refused** (G15) — without the check it writes a page its redirecting
 *   controller never renders.
 * - **`package:build` fails for a directory without a `tsconfig.json`** (G16) — skipped again, the command ends with exit 0.
 * - **`redirect().with()` on a route without a session names the route and the `web` group** (G17) — without the check of
 *   `Flasher.started` the session's own "add the StartSession middleware" comes through.
 * - **`key:generate` says what `--force` does** (G18) — the old text claims a new key makes sessions unreadable, while `--force`
 *   keeps the old key in `APP_PREVIOUS_KEYS`.
 * - **A mail's links need a scheme** (G19) — checked only for a leading `/`, `./`, `../` or `?` again, `notes/7` reaches the mail.
 * - **The error page names a `defineMiddleware()` by its name** (G21) — classes only again, the object shows as "(anonymous)".
 * - **`make:queue-table` and `make:notifications-table` write migrations on their configured connection** — the queue's stub
 *   without `connection` (G30) creates `jobs` on `default` whatever `DB_QUEUE_CONNECTION` says; the notifications' alike (G30b); a
 *   `QUEUE_FAILED_CONNECTION` of its own is not checked (G30c) and `failed_jobs` lands where nothing looks.
 * - **A refreshed test that closes its connections itself is cleaned up** (G31) — the driver's destroy leaves the isolation's
 *   transaction pinned again, and the rollback at the end fails with "database is not open".
 * - **`devtools:clear`/`devtools:prune` load `config/devtools.ts` in development only** (G32) — loaded always again, a production
 *   run imports the app's devtools settings.
 * - **The missing-`pg` message names a named connection** (G34) — `DB_CONNECTION=pgsql` for every connection again.
 * - **Readiness opens only the connections the app uses** (G35) — every configured one again: the unused `system` SQLite file is
 *   opened (and created) by `/up/ready`.
 * - **`LIVE_DRIVER=redis` loads the Redis client at the start** (G36) — without `verify()` a broken install boots and fails the
 *   first hint.
 */
const HEALTHCHECK = { vitest: 'packages/cli/src/make-docker.test.ts', name: 'checks nothing with HEALTH_PATH=off' } as const;
const COMMAND_HELP = { vitest: 'packages/cli/src/cli.test.ts', name: 'for --help, without running it' } as const;
const LINK_FORM = { vitest: 'packages/react/src/routes.test.tsx', name: 'renders a link that sends as a real form' } as const;
const LINK_VISIT = { vitest: 'packages/react/src/prefetch-poll.test.tsx', name: 'sends one visit with JavaScript' } as const;
const LINK = 'packages/react/src/link.tsx';
const KERNEL = 'packages/server/src/kernel.ts';

export default defineGegenproben({
  step: 'W12.4a',
  cases: [
    {
      id: 'G6',
      title: 'the health check ignores HEALTH_PATH=off: it fetches 127.0.0.1:3000off and fails, the container turns unhealthy',
      patch: [{ file: 'packages/cli/src/docker.ts', find: "p==='off'?process.exit(0):fetch(", replace: 'fetch(' }],
      run: HEALTHCHECK,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G7',
      title: '--help is not asked for: marmeon make:controller --help fails with "Unknown option" (exit 1)',
      patch: [{ file: 'packages/cli/src/command.ts', find: "return flags.some((flag) => (flag === '--help' || flag === '-h')", replace: "return flags.some((flag) => (flag === '--nohelp' || flag === '-h')" }],
      run: COMMAND_HELP,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G8',
      title: 'the button of a link that sends is type="button" again: without JavaScript the sign-out does nothing',
      patch: [{ file: LINK, find: "<button type={confirm === undefined ? 'submit' : 'button'}", replace: '<button type="button"' }],
      run: LINK_FORM,
      expect: /\["<form class=\\"marmeon-link\\" action=\\"\/logout\\" method=\\"post\\"><input type=\\"hidden\\" name=\\"_token\\" value=\\"t0ken\\"\/><button type=\\"button\\">Sign out<\/button>.*: expected/,
    },
    {
      id: 'G8b',
      title: "the form leaves the page's CSRF token out: a signed-in user's sign-out without JavaScript fails with 419",
      patch: [{ file: LINK, find: '        {page.csrf !== undefined && sameOrigin(href) && <input type="hidden" name={FORM_TOKEN_FIELD}', replace: '        {false && <input type="hidden" name={FORM_TOKEN_FIELD}' }],
      run: LINK_FORM,
      expect: /\["<form class=\\"marmeon-link\\" action=\\"\/logout\\" method=\\"post\\"><button type=\\"submit\\">Sign out<\/button><\/form>",.*: expected/,
    },
    {
      id: 'G8c',
      title: 'the click is not stopped: the browser posts the form beside the visit',
      patch: [{ file: LINK, find: "      event.preventDefault();\n      void visit(href, { method, data, ...options });", replace: '      void visit(href, { method, data, ...options });' }],
      run: LINK_VISIT,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G8d',
      title: 'a link with confirm submits its form: before the app started it sends without asking',
      patch: [{ file: LINK, find: "<button type={confirm === undefined ? 'submit' : 'button'}", replace: '<button type="submit"' }],
      run: LINK_FORM,
      expect: /<button type=\\"submit\\">Sign out everywhere<\/button><\/form>",.*: expected/,
    },
    {
      id: 'G8e',
      title: "a link that sends to another origin carries the page's CSRF token in its form",
      patch: [{ file: LINK, find: '{page.csrf !== undefined && sameOrigin(href) && <input', replace: '{page.csrf !== undefined && <input' }],
      run: LINK_FORM,
      expect: /action=\\"https:\/\/elsewhere\.example\/hook\\" method=\\"post\\"><input type=\\"hidden\\" name=\\"_token\\" value=\\"t0ken\\"\/>.*: expected/,
    },
    {
      id: 'G8g',
      title: "the link judges another origin by the href's first characters again: a tab, a newline or a leading space sends the page's CSRF token to another host",
      patch: [{ file: LINK, find: '{page.csrf !== undefined && sameOrigin(href) && <input', replace: '{page.csrf !== undefined && !/^(?:[a-z][a-z\\d+.-]*:|[/\\\\]{2})/i.test(href) && <input' }],
      run: LINK_FORM,
      expect: /action=\\"\/\\t\/elsewhere\.example\/hook\\" method=\\"post\\"><input type=\\"hidden\\" name=\\"_token\\" value=\\"t0ken\\"\/>.*action=\\" \/\/elsewhere\.example\/hook\\" method=\\"post\\"><input type=\\"hidden\\" name=\\"_token\\".*: expected/,
    },
    {
      id: 'G8f',
      title: "the web app's VerifyEmail holds its sending link in a <p> again: the browser closes the <p> at the form, the page does not hydrate",
      patch: [
        { file: 'apps/web-app/modules/auth/views/VerifyEmail.tsx', find: '      <div className="paragraph">', replace: '      <p>' },
        { file: 'apps/web-app/modules/auth/views/VerifyEmail.tsx', find: '      </div>\n    </main>', replace: '      </p>\n    </main>' },
      ],
      run: { vitest: 'apps/web-app/modules/user-profile/ssr.test.ts', name: 'hydrates the pages with a link that sends' },
      expect: /Expected the page to hydrate: <form> inside <p> \(.*main > p\): the browser closes the <p> first/,
    },
    {
      id: 'G9',
      title: "a layer's base has no rule of its own: its write is reported as an island's",
      patch: [{ file: KERNEL, find: "            : island\n              ? undefined\n              : \"a layer's base is read-only", replace: "            : true\n              ? undefined\n              : \"a layer's base is read-only" }],
      run: { vitest: 'packages/server/src/layers.test.ts', name: 'resolves the base read-only' },
      expect: /in a layer's base, resolved for its deep link \(GET \/writes\): an island is read-only .*: expected/,
    },
    {
      id: 'G9b',
      title: 'a deferred prop streamed after the headers has no rule of its own: its write is reported as an island\'s',
      patch: [{ file: KERNEL, find: "        rule: 'the response headers are out — ", replace: "        _rule: 'the response headers are out — " }],
      run: { vitest: 'packages/server/src/islands-ssr.test.ts', name: 'a deferred prop that writes after the headers throws in development' },
      expect: /after its response headers were sent \(a deferred prop, streamed with the page\): an island is read-only .*: expected/,
    },
    {
      id: 'G11',
      title: 'a provider that only brings solutions stops the start: "has no register(), boot(), …"',
      patch: [{ file: 'packages/core/src/application.ts', find: ' && !Provider.health?.length && !Provider.solutions?.length) {', replace: ' && !Provider.health?.length) {' }],
      run: { vitest: 'packages/core/src/application.test.ts', name: 'accepts a provider that only brings solutions' },
      expect: /promise rejected "TypeError: OnlySolutions is listed as a s…" instead of resolving/,
    },
    {
      id: 'G12',
      title: "a list of limits sends the last limit's headers: the per-minute 100/99 beside a per-second limit with one attempt left",
      patch: [{ file: 'packages/cache/src/rate-limiter.ts', find: '        if (remaining >= fewest) continue;\n', replace: '' }],
      run: { vitest: 'packages/cache/src/rate-limiter.test.ts', name: 'reports the remaining budget and applies every limit of a limiter' },
      expect: /expected \[ '100', '99' \] to deeply equal \[ '2', '1' \]/,
    },
    {
      id: 'G12b',
      title: 'the server does not ask the middleware when it starts: an undefined limiter boots and fails its first request',
      patch: [{ file: KERNEL, find: "      if (typeof verify !== 'function' || verified.has(middleware)) continue;", replace: '      if (true) continue;' }],
      run: { vitest: 'packages/cache/src/rate-limiter.test.ts', name: 'fails the start for an undefined limiter' },
      expect: /promise resolved "Hono\{ get: \[Function\], …\(\d+\) \}" instead of rejecting/,
    },
    {
      id: 'G12c',
      title: "@marmeon/auth does not add the user to a limiter's context: ctx.user does not compile without a cast",
      patch: [{ file: 'packages/auth/src/auth.ts', find: '    readonly user?: AuthUser | undefined;\n  }\n}', replace: '    readonly account?: AuthUser | undefined;\n  }\n}' }],
      run: { command: ['pnpm', '--dir', 'apps/web-app', 'exec', 'tsc', '--noEmit', '--pretty', 'false'] },
      expect: /modules\/auth\/cache\.type-test\.ts\(26,\d+\): error TS2339: Property 'user' does not exist on type/,
    },
    {
      id: 'G12d',
      title: "the server's start check calls any static verify again: an app's own middleware method runs at the start",
      patch: [
        {
          file: KERNEL,
          find: '(middleware as { [START_CHECK]?: unknown })[START_CHECK] : undefined;',
          replace: '((middleware as { [START_CHECK]?: unknown })[START_CHECK] ?? (middleware as { verify?: unknown }).verify) : undefined;',
        },
      ],
      run: { vitest: 'packages/cache/src/rate-limiter.test.ts', name: 'lets the allowed attempts through' },
      expect: /the start check called an app's own static verify/,
    },
    {
      id: 'G13',
      title: 'the export pages its later batches by OFFSET: a row deleted from the first batch pushes a later one out of the file',
      patch: [
        {
          file: 'packages/table/src/tables.ts',
          find: '    const batch = (cursor: string | null) =>\n      cursorPaginate(rows, {',
          replace:
            "    const offsets = new Map<string | null, number>();\n    const batch = async (cursor: string | null) => {\n      const at = offsets.get(cursor) ?? 0;\n      const data = (await ordered(definition, project(definition, filtered, view), state).limit(EXPORT_BATCH).offset(at).execute()) as Row[];\n      const nextCursor = data.length === EXPORT_BATCH ? String(at + data.length) : null;\n      if (nextCursor !== null) offsets.set(nextCursor, at + data.length);\n      return { data, meta: { nextCursor } };\n    };\n    const keyset = (cursor: string | null) =>\n      cursorPaginate(rows, {",
        },
      ],
      run: { vitest: 'packages/table/src/table.test.ts', name: 'not at an offset' },
      expect: /\{"missing":\["Bulk 0500"\],"twice":\[\]\}: expected/,
    },
    {
      id: 'G13b',
      title: 'the cursor refuses a boolean again: an export sorted by a boolean column ends at its second batch',
      patch: [{ file: 'packages/database/src/pagination.ts', find: " || typeof item === 'number' || typeof item === 'boolean') ? values", replace: " || typeof item === 'number') ? values" }],
      run: { vitest: 'packages/table/src/table.test.ts', name: 'also when sorted by a boolean column' },
      expect: /active: 0 rows — the stream failed: InvalidCursorError/,
    },
    {
      id: 'G14',
      title: 'a busy job.once key is an error again: a job with one try fails instead of running later',
      patch: [{ file: 'packages/queue/src/worker.ts', find: '        if (settled.error instanceof JobOnceBusyError) {', replace: '        if (settled.error instanceof Error && false) {' }],
      run: { vitest: 'packages/queue/src/reliability.test.ts', name: 'without using up a try' },
      expect: /\["JobFailed:\{\\"attempt\\":1\}"\]: expected/,
    },
    {
      id: 'G14b',
      title: 'the busy attempt is released but counted: its next claim is attempt 2 of 1 and fails',
      patch: [{ file: 'packages/queue/src/worker.ts', find: 'release(reserved, ONCE_BUSY_DELAY, { refund: true });', replace: 'release(reserved, ONCE_BUSY_DELAY, { refund: false });' }],
      run: { vitest: 'packages/queue/src/reliability.test.ts', name: 'without using up a try' },
      expect: /test\.once has been attempted 1 times without finishing .*it may run 1.*: expected/,
    },
    {
      id: 'G15',
      title: 'make:controller --request --view on a writing name writes a page its controller never renders (exit 0)',
      patch: [{ file: 'packages/cli/src/commands/make.ts', find: '    if (withView && input.options.request === true && !reads) {', replace: '    if (false) {' }],
      run: { vitest: 'packages/cli/src/cli.test.ts', name: 'scaffolds a module, controller with view' },
      expect: /expected \[ \+0, '' \] to deeply equal \[ 1, …\(1\) \]/,
    },
    {
      id: 'G16',
      title: 'package:build skips a directory without a tsconfig.json again: exit 0, nothing said',
      patch: [
        {
          file: 'packages/cli/src/commands/package-build.ts',
          find: "    const directories = (args.length ? args : ['.']).map((dir) => resolve(root, dir));",
          replace: "    const directories = (args.length ? args : ['.']).map((dir) => resolve(root, dir)).filter((dir) => existsSync(join(dir, 'tsconfig.json')));",
        },
      ],
      run: { vitest: 'packages/cli/src/package-build.test.ts', name: 'fails for a directory without a tsconfig.json' },
      expect: /expected \[ \+0, \[\] \] to deeply equal \[ 1, …\(1\) \]/,
    },
    {
      id: 'G17',
      title: "redirect().with() on an API route passes the unstarted session on: the message is the session's, not the route's",
      patch: [{ file: 'packages/http/src/redirect.ts', find: '  if (flasher.started === false) {', replace: '  if (flasher.started === undefined) {' }],
      run: { vitest: 'packages/session/src/session.test.ts', name: 'as the Flasher of a route without StartSession' },
      expect: /to throw error including 'redirect\(\)\.with\(\) needs a session, an…' but got 'The session has not been started — ad…'/,
    },
    {
      id: 'G18',
      title: 'key:generate warns that a new key makes sessions unreadable — what --force does not do',
      patch: [
        {
          file: 'packages/cli/src/commands/key-generate.ts',
          find: "'APP_KEY is already set. --force replaces it and moves the old key to APP_PREVIOUS_KEYS, so sessions, encrypted cookies and signed links stay valid.'",
          replace: "'APP_KEY is already set. Replacing it makes existing sessions and encrypted cookies unreadable — use --force.'",
        },
      ],
      run: { vitest: 'packages/cli/src/cli.test.ts', name: 'generates the application key into .env' },
      expect: /expected '✗ APP_KEY is already set\. Replacing i…' to be '✗ APP_KEY is already set\. --force rep…'/,
    },
    {
      id: 'G19',
      title: 'the mail link check looks for a leading /, ./, ../ or ? only: href="notes/7" reaches the mail',
      patch: [{ file: 'packages/mail/src/mailer.ts', find: "const ABSOLUTE = /^(?:[a-z][a-z\\d+.-]*:|#)/i;", replace: "const ABSOLUTE = /^(?!\\/(?!\\/)|\\.{1,2}\\/|\\?)/;" }],
      run: { vitest: 'packages/mail/src/queued.test.ts', name: 'refuses relative links' },
      expect: /relative links that passed: \["notes\/7","reset-password\?token=abc","\/\/app\.test\/reset","www\.app\.test\/reset",""\]: expected/,
    },
    {
      id: 'G21',
      title: 'the error page names classes only: a defineMiddleware() shows as "(anonymous)"',
      patch: [{ file: KERNEL, find: ".map((middleware) => middleware.name || '(anonymous)'),", replace: ".map((middleware) => (typeof middleware === 'function' && middleware.name) || '(anonymous)')," }],
      run: { vitest: 'packages/server/src/error-page.test.ts', name: 'shows the class, the message, the throwing line' },
      expect: /CheckAssetVersion, \(anonymous\): expected '.*' to contain 'AuditTrail'/,
    },
    {
      id: 'G30',
      title: "make:queue-table's migration has no connection: jobs land on default whatever DB_QUEUE_CONNECTION says",
      patch: [{ file: 'packages/queue/stubs/migrations/create_jobs_table.ts', find: '  connection: queueTablesConnection,\n', replace: '' }],
      run: { vitest: 'packages/queue/src/commands/commands.test.ts', name: "make:queue-table's migration runs on DB_QUEUE_CONNECTION" },
      expect: /expected 'default' to be 'queue'/,
    },
    {
      id: 'G30b',
      title: "make:notifications-table's migration has no connection: the table lands on default whatever NOTIFICATIONS_CONNECTION says",
      patch: [{ file: 'packages/notifications/stubs/migrations/create_notifications_table.ts', find: '  connection: notificationsTableConnection,\n', replace: '' }],
      run: { vitest: 'packages/notifications/src/commands.test.ts', name: 'writes a migration that runs on NOTIFICATIONS_CONNECTION' },
      expect: /expected 'default' to be 'inbox'/,
    },
    {
      id: 'G30c',
      title: 'a QUEUE_FAILED_CONNECTION of its own is not checked: failed_jobs is created on the jobs connection, where nothing looks',
      patch: [{ file: 'packages/queue/src/config.ts', find: "  if (config.failed.driver === 'database' && config.failed.connection !== jobs) {", replace: '  if (false) {' }],
      run: { vitest: 'packages/queue/src/commands/commands.test.ts', name: "make:queue-table's migration runs on DB_QUEUE_CONNECTION" },
      expect: /promise resolved "'default'" instead of rejecting/,
    },
    {
      id: 'G31',
      title: 'destroying an isolated connection leaves its transaction pinned: the cleanup fails with "database is not open"',
      patch: [{ file: 'packages/database/src/driver.ts', find: '    const pinned = this.#pinned;\n    if (pinned) {', replace: '    const pinned = this.#pinned;\n    if (pinned && false) {' }],
      run: { vitest: 'packages/testing/src/database.test.ts', name: 'closed its database connections itself' },
      expect: /expected 'Error: database is not open' to be 'closed'/,
    },
    {
      id: 'G32',
      title: 'the devtools commands load config/devtools.ts in every environment again',
      patch: [{ file: 'packages/devtools/src/commands.ts', find: "  const development = app.container.make(DevtoolsConfig).environment === 'development';", replace: '  const development = app.container.has(DevtoolsConfig);' }],
      run: { vitest: 'packages/devtools/src/commands.test.ts', name: 'never load config/devtools.ts outside development' },
      expect: /production devtools:clear: threw: config\/devtools\.ts was loaded/,
    },
    {
      id: 'G34',
      title: 'the missing-pg message says DB_CONNECTION=pgsql for a named Postgres connection too',
      patch: [{ file: 'packages/database/src/postgres.ts', find: "      const who = connection === 'default' ? 'DB_CONNECTION=pgsql' : `The Postgres connection \"${connection}\"`;", replace: "      const who = 'DB_CONNECTION=pgsql';" }],
      run: { vitest: 'packages/database/src/database.test.ts', name: 'without pg, DB_CONNECTION=pgsql says what to install' },
      expect: /^AssertionError: DB_CONNECTION=pgsql needs the "pg" package, which is not installed in this app: pnpm add pg@\^8: expected 'DB_CONNECTION=pgsql needs the "pg" pa…' to be 'The Postgres connection "repo/,
    },
    {
      id: 'G35',
      title: 'readiness asks every configured connection again: it opens the unused system SQLite file',
      patch: [{ file: 'packages/database/src/health.ts', find: '    const names = this.#connections.used();', replace: '    const names = this.#connections.names();' }],
      run: { vitest: 'packages/database/src/health.test.ts', name: 'never opens one it does not' },
      expect: /checked: default, system: expected/,
    },
    {
      id: 'G36',
      title: 'LIVE_DRIVER=redis does not load the client at the start: a broken install boots',
      patch: [{ file: 'packages/live/src/index.ts', find: '      await connections.verify();\n', replace: '' }],
      run: { vitest: 'packages/live/src/redis-boot.test.ts', name: 'loads the Redis client when the app starts' },
      expect: /expected 'started' to be 'Cannot find package "redis" \(a broken…'/,
    },
  ],
});
