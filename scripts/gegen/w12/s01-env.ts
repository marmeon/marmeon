import { defineGegenproben } from '../define.ts';

/**
 * W12.1 — the environment is read by the core's env reader (`env()` of `@marmeon/core`): every package, app, the starter's template
 * and the lab read their variables through it; `r.env()` left `@marmeon/validation`. The measures, each with its own case:
 *
 * - **An empty variable is a missing one** — taken out of the whole reader (G1), the sites read `''` as a value again: `REDIS_PREFIX=`
 *   gives keys without a prefix. The reader asks in three places, each its own case: `.default()` (G1b — `AUTH_UNVERIFIED_DAYS=` stops
 *   the start as "required" instead of 7 days), a required block (G1c — `APP_NAME=` passes as `''`), `.optional()` (G1d —
 *   `REDIS_PREFIX=` stops the start). The block's own check stands behind `.default()` and `.optional()` (G1b, G1d: the variable is
 *   "required", never `''`); a required block has no other (G1c). Each alone turns its test red.
 * - **A boolean is true/false or 1/0, nothing else** — `yes` taken as true (G2). And a variable that boots on `true`/`false` only keeps
 *   that set: `AUTH_PRIVATE_REGISTRATION` read by `env.boolean()` lets `0` turn private registration off (G2b).
 * - **One message for every wrong variable** — the reader stops at the first (G3): the start error names one variable of five.
 * - **`r.env()` is gone** — a package (G4) or the starter's app config (G4b) that still writes it does not compile.
 * - **`REDIS_PREFIX=` is the app name's prefix** — a site that keeps `''` (as the old schema did) gives keys without one (G5).
 */
const ENV = 'packages/core/src/config/env.ts';
const CORE_TESTS = 'packages/core/src/config/env.test.ts';
const REDIS_PREFIX_TEST = { vitest: 'packages/redis/src/redis.test.ts', name: 'takes an empty REDIS_PREFIX as a missing one' };

/** `.default()`: a missing or empty variable takes the default. */
const DEFAULT_EMPTY = {
  file: ENV,
  find: "return { '~env': (raw, name) => (raw === undefined || raw === '' ? ok(Array.isArray(value)",
  replace: "return { '~env': (raw, name) => (raw === undefined ? ok(Array.isArray(value)",
};
/** `.optional()`: a missing or empty variable is undefined. */
const OPTIONAL_EMPTY = {
  file: ENV,
  find: "return { '~env': (raw, name) => (raw === undefined || raw === '' ? ok(undefined) : read(raw, name)) };",
  replace: "return { '~env': (raw, name) => (raw === undefined ? ok(undefined) : read(raw, name)) };",
};
/** A block: a missing or empty variable is required. */
const REQUIRED_EMPTY = {
  file: ENV,
  find: "    if (raw === undefined || raw === '') return fail(this.#spec.missing ?? `${name} is required.`);",
  replace: '    if (raw === undefined) return fail(this.#spec.missing ?? `${name} is required.`);',
};

export default defineGegenproben({
  step: 'W12.1',
  cases: [
    // --- An empty variable is a missing one ----------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: "the reader takes an empty variable for set again: REDIS_PREFIX= gives keys without a prefix, not the app name's",
      patch: [REQUIRED_EMPTY, OPTIONAL_EMPTY, DEFAULT_EMPTY],
      run: REDIS_PREFIX_TEST,
      expect: /expected '' to be 'shop:'/,
    },
    {
      id: 'G1b',
      title: '.default() reads an empty variable: AUTH_UNVERIFIED_DAYS= stops the start ("required") instead of the default 7 days',
      patch: [DEFAULT_EMPTY],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'is 7 unless set' },
      expect: /auth: AUTH_UNVERIFIED_DAYS — AUTH_UNVERIFIED_DAYS is required\./,
      masks: 'G1c',
    },
    {
      id: 'G1c',
      title: "a required block takes an empty variable: APP_NAME= passes as '' instead of \"APP_NAME is required.\"",
      patch: [REQUIRED_EMPTY],
      run: { vitest: CORE_TESTS, name: 'lists every problem of every definition at once' },
      // APP_NAME's line is gone: the first line names APP_URL.
      expect: /the application cannot start:\n {2}• app: APP_URL — /,
      masks: 'G1b',
    },
    {
      id: 'G1d',
      title: '.optional() reads an empty variable: REDIS_PREFIX= stops the start ("required") instead of taking the app name',
      patch: [OPTIONAL_EMPTY],
      run: REDIS_PREFIX_TEST,
      expect: /redis: REDIS_PREFIX — REDIS_PREFIX is required\./,
    },
    // --- A boolean is true/false or 1/0 --------------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: "env.boolean() takes yes: a typo'd yes/no switch boots as true",
      patch: [{ file: ENV, find: "[['true', true], ['false', false], ['1', true], ['0', false]]", replace: "[['true', true], ['false', false], ['1', true], ['0', false], ['yes', true]]" }],
      run: { vitest: CORE_TESTS, name: 'boolean: true/false and 1/0' },
      expect: /yes: expected \{ value: \{ X: true \} \} to deeply equal/,
    },
    {
      id: 'G2b',
      title: 'AUTH_PRIVATE_REGISTRATION read by env.boolean(): 0 turns private registration off instead of stopping the start',
      patch: [
        { file: 'packages/auth/src/config.ts', find: "AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('true'),", replace: 'AUTH_PRIVATE_REGISTRATION: env.boolean().default(true),' },
        { file: 'packages/auth/src/config.ts', find: "privateRegistration: e.AUTH_PRIVATE_REGISTRATION === 'true',", replace: 'privateRegistration: e.AUTH_PRIVATE_REGISTRATION,' },
      ],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'is on unless set to false' },
      expect: /promise resolved .* instead of rejecting/,
    },
    // --- One message for every wrong variable ---------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'the reader stops at the first wrong variable: the start error names one of the four wrong ones of the app',
      patch: [
        {
          file: ENV,
          find: '      if (read.problem !== undefined) issues.push({ message: read.problem, path: [name] });',
          replace: '      if (read.problem !== undefined) {\n        issues.push({ message: read.problem, path: [name] });\n        break;\n      }',
        },
      ],
      run: { vitest: CORE_TESTS, name: 'lists every problem of every definition at once' },
      // The app's first line, then the next definition's — APP_URL, PORT and ADMINS are not named.
      expect: /the application cannot start:\n {2}• app: APP_NAME — APP_NAME is required\.\n {2}• encryption: APP_KEY — /,
    },
    // --- r.env() is gone ------------------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'a package reads its variables with r.env() of @marmeon/validation: it does not compile',
      patch: [
        {
          file: 'packages/storage/src/uploads/config.ts',
          find: "import { defineConfig, env, type ConfigOf } from '@marmeon/core';",
          replace: "import { defineConfig, env, type ConfigOf } from '@marmeon/core';\nimport { rules as r } from '@marmeon/validation';",
        },
        { file: 'packages/storage/src/uploads/config.ts', find: '  env: env({', replace: '  env: r.env({' },
      ],
      run: { command: ['pnpm', 'exec', 'tsc', '-p', 'packages/storage', '--noEmit', '--pretty', 'false'] },
      expect: /packages\/storage\/src\/uploads\/config\.ts\(\d+,\d+\): error TS2339: Property 'env' does not exist on type/,
    },
    {
      id: 'G4b',
      title: "the starter's app config (the blank app) reads APP_NAME and APP_URL with r.env(): it does not compile",
      patch: [
        {
          file: 'apps/blank-app/config/app.ts',
          find: "import { defineConfig, env, type ConfigOf } from '@marmeon/core';",
          replace: "import { defineConfig, env, type ConfigOf } from '@marmeon/core';\nimport { rules as r } from '@marmeon/validation';",
        },
        { file: 'apps/blank-app/config/app.ts', find: '  env: env({', replace: '  env: r.env({' },
      ],
      run: { command: ['pnpm', '--dir', 'apps/blank-app', 'exec', 'tsc', '--noEmit', '--pretty', 'false'] },
      expect: /config\/app\.ts\(\d+,\d+\): error TS2339: Property 'env' does not exist on type/,
    },
    // --- REDIS_PREFIX= ----------------------------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: "the redis config keeps an empty REDIS_PREFIX as '' (as the old schema did): keys without a prefix instead of the app name's",
      patch: [{ file: 'packages/redis/src/index.ts', find: '    REDIS_PREFIX: env.string().optional(),', replace: "    REDIS_PREFIX: { '~env': (raw: string | undefined) => ({ value: raw }) }," }],
      run: REDIS_PREFIX_TEST,
      expect: /expected '' to be 'shop:'/,
    },
  ],
});
