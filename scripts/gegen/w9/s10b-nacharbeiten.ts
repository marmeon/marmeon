import { defineGegenproben } from '../define.ts';

/**
 * W9.10b — the follow-ups of Wave 9 and what the README pass found in the code. Each measure taken out on its own:
 *
 * - **`useForm`** — a `reset()` inside `onSuccess`/`onFinish` read the defaults of before the submit, and the saved form stayed dirty
 *   (the guard asked on leaving): the saved defaults are taken in the next render, after the callbacks (G1).
 * - **One query at a time per connection** (`MarmeonDriver`) — a transaction's and a test's pinned connection run `Promise.all`'s
 *   queries in turns: the driver's wrapper (G2), the wrapper's queue itself (G2b), and on Postgres per `pg` client (G2c, needs the
 *   container: `MARMEON_TEST_PGSQL_URL`).
 * - **A server render with `router.reloading()`** — failed with R11 since Wave 9 step 3 (`/notifications`): an inert target (G3).
 * - **A filter on a hidden column** is hidden with it — its counts would tell the column's values (G4).
 * - **No CORS in development** — Vite's default answered any localhost page with `Access-Control-Allow-Origin` (G5).
 * - **S3 temporary URLs** name the type by the file name, never the stored type (G6, needs the S3 container), and a private S3 disk
 *   may not share a prefix of one bucket with a public one (G7).
 * - **`verified()` fails closed** for a user without the column (G8).
 * - **The start says so** when another program holds 127.0.0.1 at its port while it listens on every interface (G9), and a taken
 *   chosen interface fails the start with Node's error (G9b).
 * - **No inline styles** in the web app's server markup (G10).
 * - **E146 timing** with runs of four and ABBA pairs still finds a sign-up that skips the hash for a known address (G11).
 * - **SMTP requires STARTTLS** (E192, Max 06.10.): without the measure a server that does not upgrade gets the mail in plain text (G12),
 *   and the configuration's default asks for it (G12b).
 */
const PGSQL = { MARMEON_TEST_PGSQL_URL: 'postgres://marmeon:secret@localhost:55432/marmeon', DB_CONNECTION: 'pgsql', DB_URL: 'postgres://marmeon:secret@localhost:55432/marmeon' };
const SERIAL = 'packages/database/src/serial-queries.test.ts';
const START = 'packages/server/src/start-server.test.ts';

export default defineGegenproben({
  step: 'W9.10b',
  cases: [
    {
      id: 'G1',
      title: 'useForm takes the sent data as its defaults at once: a reset() in the callback reads the old ones, the form stays dirty',
      patch: [{ file: 'packages/react/src/use-form.ts', find: '          setSaved(true);\n', replace: '          setDefaults(data);\n' }],
      run: { vitest: 'packages/react/src/interaction.test.tsx', name: 'resets to the defaults before the submit' },
      expect: /expected true to be false/,
    },
    {
      id: 'G2',
      title: 'the driver hands out the connection itself: two "requests" on a test\'s pinned connection overlap',
      patch: [{ file: 'packages/database/src/driver.ts', find: '    let serial = this.#serial.get(connection);\n', replace: '    return connection;\n    let serial = this.#serial.get(connection);\n' }],
      run: { vitest: SERIAL, name: 'never overlap on it' },
      expect: /expected [2-9] to be 1/,
    },
    {
      id: 'G2b',
      title: 'the wrapper runs every query at once: no turns',
      patch: [{ file: 'packages/database/src/driver.ts', find: '    const result = tail ? tail.then(run, run) : run();', replace: '    const result = run();' }],
      run: { vitest: SERIAL, name: 'one at a time, in the order they were sent' },
      expect: /expected 3 to be 1/,
    },
    {
      id: 'G2c',
      title: 'on Postgres: Promise.all inside a transaction sends a pg client a query while another is under way',
      patch: [{ file: 'packages/database/src/driver.ts', find: '    let serial = this.#serial.get(connection);\n', replace: '    return connection;\n    let serial = this.#serial.get(connection);\n' }],
      run: { vitest: SERIAL, name: 'Promise.all inside a transaction', env: PGSQL },
      expect: /expected [2-9]\d* to be 1/,
    },
    {
      id: 'G3',
      title: 'a page that builds its reloads while rendering fails the server render (R11)',
      patch: [
        {
          file: 'packages/react/src/app.tsx',
          find: '  if (!navigator) return laterTarget(new Promise(() => {}));',
          replace: "  if (!navigator) throw new Error('[marmeon:R11] Visits run in the browser, not while rendering on the server.');",
        },
      ],
      run: { vitest: 'packages/react/src/server.test.tsx', name: 'renders a page that builds reloads and optimistic patches' },
      expect: /\[marmeon:R11\] Visits run in the browser/,
    },
    {
      id: 'G4',
      title: 'a filter on a hidden column keeps its own visibility: its counts tell the hidden values',
      patch: [
        {
          file: 'packages/table/src/tables.ts',
          find: '    const filters = (await keep(definition.filters)).filter(([, filter]) => !hidden.some((col) => sameColumn(col.ref, filter.ref)));',
          replace: '    const filters = (await keep(definition.filters)).filter(() => hidden !== undefined);',
        },
      ],
      run: { vitest: 'packages/table/src/table.test.ts', name: 'a filter on a hidden column is hidden with it' },
      expect: /a filter on a hidden column was used: expected 200 to be 400/,
    },
    {
      id: 'G5',
      title: 'Vite\'s CORS left on: a page on another localhost port is answered with Access-Control-Allow-Origin',
      patch: [{ file: 'packages/server/src/vite.ts', find: 'middlewareMode: true, cors: false, ', replace: 'middlewareMode: true, ' }],
      run: { vitest: START, name: 'answers no other origin in development' },
      expect: /\/nope answered another origin: expected 'http:\/\/localhost:5555' to be null/,
    },
    {
      id: 'G6',
      title: 'an S3 temporary URL without the type: HTML stored under .png is served inline as HTML',
      patch: [{ file: 'packages/storage/src/drivers/s3.ts', find: '      ResponseContentType: type,\n', replace: '' }],
      run: { vitest: 'packages/storage/src/s3.test.ts', name: 'names the type by the file name', env: { MARMEON_TEST_S3_ENDPOINT: 'http://127.0.0.1:56333' } },
      expect: /expected \[ 'text\/html', 'inline' \] to deeply equal \[ 'image\/png', 'inline' \]/,
    },
    {
      id: 'G7',
      title: 'a private S3 disk inside a public one\'s prefix: the start goes on',
      patch: [
        {
          file: 'packages/storage/src/storage.ts',
          find: "      if (open.root === '' || closed.root === '' || nests(`${open.root}/`, `${closed.root}/`)) {",
          replace: '      if (open.root === closed.name) {',
        },
      ],
      run: { vitest: 'packages/storage/src/provider.test.ts', name: 'a private S3 disk whose prefix nests with a public one' },
      expect: /promise resolved .* instead of rejecting/,
    },
    {
      id: 'G8',
      title: 'verified() lets a user without the column through',
      patch: [{ file: 'packages/auth/src/verification.ts', find: '      if (ctx.user.email_verified_at != null) return next();', replace: '      if (ctx.user.email_verified_at !== null) return next();' }],
      run: { vitest: 'packages/auth/src/verification.test.ts', name: 'a user without the column' },
      expect: /expected 200 to be 302/,
    },
    {
      id: 'G9',
      title: 'the start says nothing about a program on 127.0.0.1 at its port',
      patch: [{ file: 'packages/server/src/loopback.ts', find: '  if (!held) return undefined;', replace: '  if (held || !held) return undefined;' }],
      run: { vitest: START, name: 'on every interface (no HOST' },
      expect: /HOST undefined: no warning/,
    },
    {
      id: 'G9b',
      title: 'a taken interface without an error listener: an uncaught exception instead of a failed start',
      patch: [{ file: 'packages/server/src/kernel.ts', find: "    server.once('error', failed);\n", replace: '' }],
      run: { vitest: START, name: 'says nothing when the port is free there' },
      expect: /EADDRINUSE|timed out/,
    },
    {
      id: 'G10',
      title: 'an inline style in a view: the server markup carries a style attribute',
      patch: [{ file: 'apps/web-app/modules/members/views/Index.tsx', find: 'onSubmit={applyFilters} className="filters">', replace: "onSubmit={applyFilters} style={{ display: 'flex' }}>" }],
      run: { vitest: 'apps/web-app/modules/user-profile/ssr.test.ts', name: 'carry no style attribute' },
      expect: /\/members: inline styles in the server's markup/,
    },
    {
      id: 'G11',
      title: 'the sign-up hashes only for a new address: the paired runs of four still see it',
      patch: [
        {
          file: 'apps/web-app/modules/auth/controllers/RegisterController.ts',
          find: '    const hash = await this.#hasher.make(ctx.body.password);',
          replace: "    const hash = email === 'ada@example.com' ? 'skipped' : await this.#hasher.make(ctx.body.password);",
        },
      ],
      run: { vitest: 'apps/web-app/modules/auth/auth.test.ts', name: 'takes as long for a known address as for a new one' },
      expect: /median of 21 paired ratios 0\.\d+ .* expected 0\.\d+ to be greater than 0\.75/,
    },
    {
      id: 'G12',
      title: 'SMTP without requireTLS: a server that does not offer STARTTLS gets the mail in plain text',
      patch: [{ file: 'packages/mail/src/transports.ts', find: 'requireTLS: !secure && requireTls,', replace: 'requireTLS: false,' }],
      run: { vitest: 'packages/mail/src/mail.test.ts', name: 'smtp sends nothing to a server that does not upgrade to TLS' },
      expect: /a mail went out without TLS: expected 'undefined' to match/,
    },
    {
      id: 'G12b',
      title: 'MAIL_REQUIRE_TLS defaults to false: an app that sets nothing sends in plain text',
      patch: [{ file: 'packages/mail/src/index.ts', find: "v.transform((value) => value === 'true')), 'true'),", replace: "v.transform((value) => value === 'true')), 'false')," }],
      run: { vitest: 'packages/mail/src/mail.test.ts', name: 'asks nodemailer for STARTTLS unless MAIL_REQUIRE_TLS=false' },
      // Vitest shortens the strings: the reason is the default's line, its value cut after "fa…" (false).
      expect: /the default: expected 'port 587, secure false, requireTLS fa…' to be 'port 587, secure false, requireTLS tr…'/,
    },
  ],
});
