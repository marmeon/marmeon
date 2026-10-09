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
 *   step: `Auth.updatePassword()` writing the hash itself (G3d), `PasswordBroker.reset()` alike (G3e). G3 masks G3d and G3e.
 */
const SESSION_FLASH = { vitest: 'packages/session/src/session.test.ts', name: 'flashes input like redirect().withInput()' } as const;
const LOG_KEYS = { vitest: 'packages/log/src/log.test.ts', name: 'redacts the names the app' } as const;
const RESET_REVOKES = { vitest: 'packages/auth/src/password-reset.test.ts', name: 'revokes every API token of the user with AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true' } as const;
const CHANGE_REVOKES = { vitest: 'packages/auth/src/auth.test.ts', name: 'revokes every API token of the user with a new password' } as const;
const NEW_PASSWORD = 'packages/auth/src/new-password.ts';
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
      patch: [{ file: NEW_PASSWORD, find: '      return revoke ? this.#tokens().revokeAll(id) : 0;', replace: '      return revoke ? 0 : 0;' }],
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
  ],
});
