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
 */
const SESSION_FLASH = { vitest: 'packages/session/src/session.test.ts', name: 'flashes input like redirect().withInput()' } as const;
const LOG_KEYS = { vitest: 'packages/log/src/log.test.ts', name: 'redacts the names the app' } as const;
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
  ],
});
