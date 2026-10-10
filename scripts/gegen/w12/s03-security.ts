import { defineGegenproben } from '../define.ts';

/**
 * W12.3 — the security block (E219). The measures, each with its own cases:
 *
 * - **Flashed input is filtered wherever it is flashed** — one filter (`flashableInput` of `@marmeon/http`), asked by
 *   `redirect().withInput()`, the failed form and `Session.flashInput()`. The filter taken out (G1) lets a password into the session
 *   through every path; the session's call site alone (G1b) lets it in through `flashInput()` while `withInput()` still filters. G1
 *   masks G1b (one function behind both).
 * - **The logger redacts with the app's `Redactor`, errors under any key** — the wiring and the error's shape are separate measures:
 *   pino's logger with a `Redactor` of its own (G2) writes the session cookie's value a package added; the console fallback alike
 *   (G2b); errors handed on as objects (G2c) are written as `{}` under any key; pino's own error serializer left on (G2d) takes the
 *   redacted error for an object and writes `type: 'Object'`.
 * - **A new password revokes the API tokens with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, in its transaction** — the revocation
 *   taken out of the shared step (G3) leaves every token valid after a reset and a change; outside the transaction (G3b) a failed
 *   revocation keeps its delete while the reset fails; the default `true` (G3c) revokes without the option. Each caller asks the shared
 *   step: `Auth.updatePassword()` writing the hash itself (G3d), `PasswordBroker.reset()` alike (G3e). G3 masks G3d and G3e. The
 *   tokens go first (G3f: revoked after the hash, a provider outside the transaction keeps the new hash when the revocation fails).
 * - **`can()` and the gate see the token's user on API routes** — two halves, each its own case: the token guard does not tell the
 *   request's gate (G4), the gate does not ask what it was told (G4b); either way the author's token gets 403. The session's user
 *   still counts on pages (G4c: a gate that asks only the token refuses every signed-in page). The token's abilities stay checked
 *   on top (G4d: `abilities()` taken out lets a read-only token update through the policy).
 * - **The fingerprint is the account's: id, password hash and session key** — the key left out again (G5): a new key ends no
 *   other session, the other device stays signed in; the id left out (G5b): two accounts without a password share one;
 *   `updateSessionKey()` without the provider's method doing nothing instead of failing (G5c); a password sign-in stamped from
 *   `findForLogin()` instead of `findById()` (G5d).
 * - **`url.query` carries the keys only, unless `OTEL_RECORD_QUERY_VALUES=true`** — the span recording the values again (G6) exports
 *   an e-mail address and a search term; the option read as always on (G6b) does the same through the config; a part without `=`
 *   written as it is (G6c) exports a bare address.
 * - **The framework's own error lines mask their text with the app's `Redactor`** (final review, I1) — each path its own case, since
 *   each takes the Redactor on its own: the exception handler's report with the core's list alone (G7) writes the session id a cookie
 *   header quotes after another cookie; alike a failing terminate hook (G7b), deferred work (G7c), server rendering (G7d), a scheduled
 *   run and its listeners (G7e), the schedule:work loop's tick (G7f), the live hub (G7g), the broadcaster (G7h), the live package's
 *   session endings (G7i), a dispatch's failing listener (G7j) and the session clean-up (G7k).
 */
const SESSION_FLASH = { vitest: 'packages/session/src/session.test.ts', name: 'flashes input like redirect().withInput()' } as const;
const LOG_KEYS = { vitest: 'packages/log/src/log.test.ts', name: 'redacts the names the app' } as const;
const RESET_REVOKES = { vitest: 'packages/auth/src/password-reset.test.ts', name: 'revokes every API token of the user with AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true' } as const;
const CHANGE_REVOKES = { vitest: 'packages/auth/src/auth.test.ts', name: 'revokes every API token of the user with a new password' } as const;
const NEW_PASSWORD = 'packages/auth/src/new-password.ts';
const TOKEN_POLICIES = { vitest: 'packages/auth/src/gate.test.ts', name: 'lets a token user the policy allows through' } as const;
const GATE = 'packages/auth/src/gate.ts';
const AUTH = 'packages/auth/src/auth.ts';
const OTEL_QUERY = { vitest: 'packages/otel/src/otel.test.ts', name: 'records the keys of the query only' } as const;
const APP_REDACTOR = { vitest: 'packages/server/src/kernel.test.ts', name: "masks with the app's Redactor" } as const;
const SSR_REDACTOR = { vitest: 'packages/server/src/ssr.test.ts', name: "logs the failure masked by the app's Redactor" } as const;
const SCHEDULE_REDACTOR = { vitest: 'packages/scheduler/src/scheduler.test.ts', name: "masked by the app's Redactor" } as const;
const LIVE_REDACTOR = { vitest: 'packages/live/src/server.test.ts', name: "the live package's error lines" } as const;
/** What each case finds in the failure: the session id after `marmeon_session=`, with the cookie before it masked by the core's list. */
const leaked = (before: string) => new RegExp(`${before}Cookie: \\[redacted\\]; marmeon_session=s3ss10nvalue`);
const LOG_ERRORS = { vitest: 'packages/log/src/log.test.ts', name: 'writes an error under any key with its type, message and stack' } as const;

export default defineGegenproben({
  step: 'W12.3',
  cases: [
    // --- 1 · Flashed input is filtered wherever it is flashed ------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the shared filter keeps password fields: flashInput() (and withInput()) put the password into the session store',
      patch: [{ file: 'packages/http/src/redirect.ts', find: 'const DONT_FLASH = /password/i;', replace: 'const DONT_FLASH = /(?!)/;' }],
      run: SESSION_FLASH,
      expect: /"password":"secret".*: expected .* not to match/,
      masks: 'G1b',
    },
    {
      id: 'G1b',
      title: 'Session.flashInput() does not ask the filter: the raw input — password, _token — reaches the session store',
      patch: [{ file: 'packages/session/src/session.ts', find: '    this.flash(OLD_INPUT, flashableInput(input));', replace: '    this.flash(OLD_INPUT, input);' }],
      run: SESSION_FLASH,
      expect: /"password":"secret".*"_token":"csrf".*: expected .* not to match/,
      masks: 'G1',
    },
    // --- 2 · The logger redacts with the app's Redactor, errors under any key ---------------------------------------------------------
    {
      id: 'G2',
      title: "pino's logger takes a Redactor of its own, not the app's: the session cookie's value a package added is written",
      patch: [
        {
          file: 'packages/log/src/index.ts',
          find: '  return app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();',
          replace: '  return new Redactor();',
        },
      ],
      run: LOG_KEYS,
      expect: /bound-s3ss in \{.*"marmeon_session":"bound-s3ss"/,
      masks: 'G2c',
    },
    {
      id: 'G2b',
      title: "the console fallback takes a Redactor of its own, not the app's: the added names' values are written",
      patch: [
        {
          file: 'packages/core/src/logger.ts',
          find: '    this.#redactor = app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();',
          replace: '    this.#redactor = new Redactor();',
        },
      ],
      run: LOG_KEYS,
      expect: /\[info\] Visit .*bound-s3ss.*: expected .* not to match/,
    },
    {
      id: 'G2c',
      title: 'an error is handed on as an object: under any key but err, and under err too, it is written as {} — no message, no stack',
      patch: [{ file: 'packages/core/src/redact.ts', find: '    if (value instanceof Error) return this.#logError(value, depth + 1, new Set());\n', replace: '' }],
      run: LOG_ERRORS,
      expect: /"error":\{"code":"EIMPORT","secret":"\[redacted\]"\}/,
      masks: 'G2',
    },
    {
      id: 'G2d',
      title: "pino's own error serializer runs after the redaction: it takes the written error for an object — type 'Object'",
      patch: [{ file: 'packages/log/src/index.ts', find: '      serializers: { err: (value: unknown) => value },\n', replace: '' }],
      run: { vitest: 'packages/log/src/log.test.ts', name: "redacts inside lists, the bindings of a child logger and an error's fields" },
      expect: /"err":\{"type":"Object"/,
    },
    // --- 3 · A new password revokes the API tokens, with the option, in its transaction ---------------------------------------------
    {
      id: 'G3',
      title: 'the shared step stores the new password without revoking: every API token stays valid after a reset with the option on',
      patch: [{ file: NEW_PASSWORD, find: '      const revoked = revoke ? await this.#tokens().revokeAll(id) : 0;', replace: '      const revoked = revoke ? 0 : 0;' }],
      run: RESET_REVOKES,
      expect: /Ada's tokens still valid: \[true,true\]/,
      masks: 'G3d',
    },
    {
      id: 'G3b',
      title: 'the revocation runs outside a transaction: a failed revocation keeps its delete while the reset fails',
      patch: [{ file: NEW_PASSWORD, find: '    const revoked = await this.#connections().transaction(() => write(true));', replace: '    const revoked = await write(true);' }],
      run: { vitest: 'packages/auth/src/password-reset.test.ts', name: 'the revocation fails' },
      expect: /the delete of the failed transaction was kept: expected undefined to be defined/,
    },
    {
      id: 'G3c',
      title: 'AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE defaults to true: a new password revokes the tokens of an app that never asked',
      patch: [
        {
          file: 'packages/auth/src/config.ts',
          find: "    AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: env.in(['true', 'false']).default('false'),",
          replace: "    AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: env.in(['true', 'false']).default('true'),",
        },
      ],
      run: CHANGE_REVOKES,
      expect: /revoke=false: Ada's tokens still valid: \[false,false\]/,
    },
    {
      id: 'G3d',
      title: 'Auth.updatePassword() writes the hash itself, past the shared step: the tokens stay valid with the option on',
      patch: [
        {
          file: 'packages/auth/src/auth.ts',
          find: "    const revoked = await this.#newPassword.store(this.#users, this.#remember, idOf(user), hash, 'change');",
          replace: '    await this.#users.updatePasswordHash(idOf(user) as never, hash);\n    await this.#remember.forgetUser(idOf(user));\n    const revoked = 0;',
        },
      ],
      run: CHANGE_REVOKES,
      expect: /revoke=true: Ada's tokens still valid: \[true,true\]/,
      masks: 'G3',
    },
    {
      id: 'G3e',
      title: 'PasswordBroker.reset() writes the hash itself, past the shared step: the tokens stay valid with the option on',
      patch: [
        {
          file: 'packages/auth/src/password-reset.ts',
          find: "    const revoked = await this.#newPassword.store(this.#users, this.#remember, idOf(found.user), await this.#hasher.make(password), 'reset');",
          replace:
            '    await this.#users.updatePasswordHash(idOf(found.user) as never, await this.#hasher.make(password));\n    await this.#remember.forgetUser(idOf(found.user));\n    const revoked = 0;',
        },
      ],
      run: RESET_REVOKES,
      expect: /Ada's tokens still valid: \[true,true\]/,
      masks: 'G3',
    },
    {
      id: 'G3f',
      title: 'the hash is written before the revocation: a provider outside the transaction keeps a new hash next to live tokens',
      patch: [
        {
          file: NEW_PASSWORD,
          find: '      const revoked = revoke ? await this.#tokens().revokeAll(id) : 0;\n      await users.updatePasswordHash(id as never, hash);\n',
          replace: '      await users.updatePasswordHash(id as never, hash);\n      const revoked = revoke ? await this.#tokens().revokeAll(id) : 0;\n',
        },
      ],
      run: { vitest: 'packages/auth/src/password-reset.test.ts', name: 'the revocation fails' },
      expect: /a new hash next to live tokens: expected false to be true/,
    },
    // --- 4 · can() and the gate see the token's user on API routes ----------------------------------------------------------------------
    {
      id: 'G4',
      title: "the token guard does not tell the request's gate: can() on an API route finds no user — the author's token gets 403",
      patch: [{ file: 'packages/auth/src/middleware.ts', find: '      authenticatedByToken(this.#gate, found.user);\n', replace: '' }],
      run: TOKEN_POLICIES,
      expect: /the author's token: \{"status":403,"body":\{"message":"This action is unauthorized\."\}\}/,
      masks: 'G4b',
    },
    {
      id: 'G4b',
      title: 'the gate does not ask the user the token guard named: the session (none on an API route) decides — 403',
      patch: [
        {
          file: GATE,
          find: '    return this.#tokenUser === undefined ? this.#auth.user() : Promise.resolve(this.#tokenUser);',
          replace: '    return this.#auth.user();',
        },
      ],
      run: TOKEN_POLICIES,
      expect: /the author's token: \{"status":403,"body":\{"message":"This action is unauthorized\."\}\}/,
      masks: 'G4',
    },
    {
      id: 'G4c',
      title: "the gate asks only the token's user: a signed-in session on a page is a guest to every policy",
      patch: [
        {
          file: GATE,
          find: '    return this.#tokenUser === undefined ? this.#auth.user() : Promise.resolve(this.#tokenUser);',
          replace: '    return Promise.resolve(this.#tokenUser);',
        },
      ],
      run: { vitest: 'packages/auth/src/gate.test.ts', name: 'lets the author update and refuses others with the policy' },
      expect: /expected \{ status: 403.* to deeply equal \{ status: 200/,
    },
    {
      id: 'G4d',
      title: "abilities() lets every token through: the author's read-only token updates through the policy",
      patch: [{ file: 'packages/auth/src/middleware.ts', find: '      const missing = required.filter((ability) => !tokenCan(ctx.token, ability));', replace: '      const missing: string[] = [];' }],
      run: { vitest: 'packages/auth/src/gate.test.ts', name: "still asks the token's abilities on top" },
      expect: /expected \{ status: 200.* to deeply equal \{ status: 403/,
    },
    // --- 5 · The fingerprint is the account's -----------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'the fingerprint ignores the session key again: updateSessionKey() leaves the other device signed in',
      patch: [{ file: AUTH, find: "  const parts = [String(idOf(credentials.user)), credentials.passwordHash ?? '', credentials.sessionKey ?? ''];", replace: "  const parts = [String(idOf(credentials.user)), credentials.passwordHash ?? '', ''];" }],
      run: { vitest: 'packages/auth/src/session-key.test.ts', name: 'SESSION_DRIVER=memory' },
      expect: /the other session: expected 200 to be 401/,
    },
    {
      id: 'G5b',
      title: 'the fingerprint ignores the account: two accounts without a password share one',
      patch: [{ file: AUTH, find: "  const parts = [String(idOf(credentials.user)), credentials.passwordHash ?? '', credentials.sessionKey ?? ''];", replace: "  const parts = ['', credentials.passwordHash ?? '', credentials.sessionKey ?? ''];" }],
      run: { vitest: 'packages/auth/src/session-key.test.ts', name: 'differs between two accounts without a password' },
      expect: /two passwordless accounts: expected '[\w-]+…' not to be '[\w-]+…'/,
    },
    {
      id: 'G5c',
      title: 'updateSessionKey() without the provider\'s method returns as if it had worked: no error names what to implement',
      patch: [{ file: AUTH, find: "    if (typeof this.#users.updateSessionKey !== 'function') {", replace: "    if (typeof this.#users.updateSessionKey !== 'function') return;\n    if (typeof this.#users.updateSessionKey !== 'function') {" }],
      run: { vitest: 'packages/auth/src/session-key.test.ts', name: 'when the UserProvider cannot store a key' },
      expect: /\{"done":true\}: expected/,
    },
    {
      id: 'G5d',
      title: 'attempt() stamps the fingerprint from findForLogin(): a provider that leaves the key out there ends every password sign-in',
      patch: [{ file: AUTH, find: "    await this.#login(await this.#credentials(credentials.user), options, 'attempt');", replace: "    await this.#login(credentials, options, 'attempt');" }],
      run: { vitest: 'packages/auth/src/session-key.test.ts', name: 'stamps the fingerprint from findById()' },
      expect: /the next request after the sign-in: expected 401 to be 200/,
    },
    // --- 6 · url.query carries the keys only ------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'the server span records the whole query again: an e-mail address and a search term leave the process',
      patch: [
        {
          file: 'packages/otel/src/tracer.ts',
          find: "redactor.text(recordQueryValues ? url.search.slice(1) : queryKeys(url.search))",
          replace: 'redactor.text(url.search.slice(1))',
        },
      ],
      run: OTEL_QUERY,
      expect: /"url\.query":"q=ada%40example\.com&page=2&bare-ada%40example\.com&token=\[redacted\]&q=second"/,
      masks: 'G6b',
    },
    {
      id: 'G6b',
      title: 'OTEL_RECORD_QUERY_VALUES is read as on when unset: every app exports the values of its queries',
      patch: [
        {
          file: 'packages/otel/src/index.ts',
          find: "    recordQueryValues: e.OTEL_RECORD_QUERY_VALUES.toLowerCase() === 'true',",
          replace: "    recordQueryValues: e.OTEL_RECORD_QUERY_VALUES.toLowerCase() !== 'yes',",
        },
      ],
      run: OTEL_QUERY,
      expect: /"url\.query":"q=ada%40example\.com&page=2&bare-ada%40example\.com&token=\[redacted\]&q=second"/,
      masks: 'G6',
    },
    {
      id: 'G6c',
      title: 'a query part without = is written as it is: ?ada@example.com leaves the process as a "key"',
      patch: [{ file: 'packages/otel/src/tracer.ts', find: "`${part.slice(0, part.indexOf('='))}=` : REDACTED))", replace: "`${part.slice(0, part.indexOf('='))}=` : part))" }],
      run: OTEL_QUERY,
      expect: /"url\.query":"q=&page=&bare-ada%40example\.com&token=&q="/,
    },
    // --- 7 · The framework's own error lines mask with the app's Redactor -------------------------------------------------------------
    {
      id: 'G7',
      title: "the exception handler's report masks with the core's list alone: the session id a cookie header quotes after another cookie is written",
      patch: [
        {
          file: 'packages/http/src/errors.ts',
          find: 'this.#logger.error(this.#redactor.text(message), { exception: name, stack: this.#redactor.text(stack) });',
          replace: 'this.#logger.error(new Redactor().text(message), { exception: name, stack: new Redactor().text(stack) });',
        },
      ],
      run: APP_REDACTOR,
      expect: leaked('the upstream refused the request with '),
    },
    {
      id: 'G7b',
      title: "a failing terminate hook is logged masked by the core's list alone: the session id is written",
      patch: [
        {
          file: 'packages/server/src/kernel.ts',
          find: "logger.error('A terminate hook failed', { exception: redactor.text(String(error)) })",
          replace: "logger.error('A terminate hook failed', { exception: new Redactor().text(String(error)) })",
        },
      ],
      run: APP_REDACTOR,
      expect: leaked('a terminate hook refused '),
    },
    {
      id: 'G7c',
      title: "failed deferred work is logged masked by the core's list alone: the session id is written",
      patch: [{ file: 'packages/server/src/kernel.ts', find: "logger.error('Deferred work failed', { exception: redactor.text(", replace: "logger.error('Deferred work failed', { exception: new Redactor().text(" }],
      run: APP_REDACTOR,
      expect: leaked('deferred work refused '),
    },
    {
      id: 'G7d',
      title: "server rendering's error lines take a Redactor of their own: the session id an SSR error quotes is written",
      patch: [
        {
          file: 'packages/server/src/render.ts',
          find: '  const redactor = app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();',
          replace: '  const redactor = new Redactor();',
        },
      ],
      run: SSR_REDACTOR,
      expect: leaked('the renderer refused '),
    },
    {
      id: 'G7e',
      title: 'the scheduler takes a Redactor of its own: a failed run and its failing listener write the session id',
      patch: [
        {
          file: 'packages/scheduler/src/scheduler.ts',
          find: '    this.#redactor = container.has(Redactor) ? container.make(Redactor) : new Redactor();',
          replace: '    this.#redactor = new Redactor();',
        },
      ],
      run: SCHEDULE_REDACTOR,
      expect: leaked('the store refused '),
    },
    {
      id: 'G7f',
      title: "the schedule:work loop masks a failed tick with a Redactor of its own, not the one it is given: the session id is written",
      patch: [
        { file: 'packages/scheduler/src/worker.ts', find: "import type { Clock, Logger, Redactor } from '@marmeon/core';", replace: "import { Redactor, type Clock, type Logger } from '@marmeon/core';" },
        { file: 'packages/scheduler/src/worker.ts', find: '    this.#redactor = redactor;', replace: '    this.#redactor = redactor && new Redactor();' },
      ],
      run: SCHEDULE_REDACTOR,
      expect: leaked('the cache refused '),
    },
    {
      id: 'G7g',
      title: "the live provider builds its hub without the app's Redactor: a stream that cannot start writes the session id",
      patch: [{ file: 'packages/live/src/index.ts', find: 'c.make(ServerClosing).signal, c.make(Redactor));', replace: 'c.make(ServerClosing).signal);' }],
      run: LIVE_REDACTOR,
      expect: /A live stream could not start \(the live backend failed\)","context":\{"exception":"Error: the backend refused Cookie: \[redacted\]; marmeon_session=s3ss10nvalue/,
    },
    {
      id: 'G7h',
      title: "the live provider builds its broadcaster without the app's Redactor: a lost hint writes the session id",
      patch: [{ file: 'packages/live/src/index.ts', find: 'app: c.make(Application), redactor: c.make(Redactor) });', replace: 'app: c.make(Application) });' }],
      run: LIVE_REDACTOR,
      expect: /could not be sent","context":\{"channel":"users\.1","exception":"Error: the backend refused Cookie: \[redacted\]; marmeon_session=s3ss10nvalue/,
    },
    {
      id: 'G7i',
      title: "the live package masks a session ending's failure with the core's list alone: the session id is written",
      patch: [
        {
          file: 'packages/live/src/index.ts',
          find: "{ exception: redactor.text(String(error)) });",
          replace: "{ exception: new Redactor().text(String(error)) });",
        },
      ],
      run: LIVE_REDACTOR,
      expect: /session that ended could not be closed \(the live backend failed\)","context":\{"exception":"Error: the backend refused Cookie: \[redacted\]; marmeon_session=s3ss10nvalue/,
    },
    {
      id: 'G7j',
      title: "the queue provider builds the Queue without the app's Redactor: a dispatch's failing listener writes the session id",
      patch: [{ file: 'packages/queue/src/index.ts', find: '        redactor: c.make(Redactor),\n', replace: '' }],
      run: { vitest: 'packages/queue/src/queue.test.ts', name: "logs a failing listener of a dispatch masked by the app's Redactor" },
      expect: leaked('A listener of JobQueued failed: the audit log refused '),
    },
    {
      id: 'G7k',
      title: "the session clean-up masks its failure with a Redactor of its own: the session id is written",
      patch: [
        {
          file: 'packages/session/src/start-session.ts',
          find: '      const redactor = this.#container.has(Redactor) ? this.#container.make(Redactor) : new Redactor();',
          replace: '      const redactor = new Redactor();',
        },
      ],
      run: { vitest: 'packages/session/src/start-session.test.ts', name: "logs a failed clean-up masked by the app's Redactor" },
      expect: leaked('Session garbage collection failed: Error: the store refused '),
    },
  ],
});
