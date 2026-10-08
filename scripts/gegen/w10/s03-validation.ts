import { defineGegenproben } from '../define.ts';

/** The engine's name in parts — `check:source` (W10 step 4) finds an import of it outside a package's src/, this file's patches too. */
const ENGINE = ['vali', 'bot'].join('');

/**
 * W10.3 — `@marmeon/validation` (E197): Laravel's rules as Standard Schema objects, Valibot inside only, messages in the request's
 * language (en/de for every rule), database and async rules never in a live validation (E187/E193), the unique index as the truth.
 *
 * Masking pair G1 ↔ G1b: a rule that is not live does not run in a live validation (the rule), and the live validation drops an issue
 * marked not live should one run anyway (the router's filter). Either one alone keeps a free and a taken address apart in the app (X1,
 * X2 green) — each has its own scenario (G1: the database is asked; G1b: a rule inside another library's schema), and without both
 * the lab's live answers differ (G1c).
 */
const ruleSkip = { file: 'packages/validation/src/rule.ts', find: '      if (context.live && !context.liveOptIn) return undefined;\n      return engine.checkAsync(', replace: '      return engine.checkAsync(' };
const liveFilter = {
  file: 'packages/router/src/request-definition.ts',
  find: 'filter((issue) => issueOfFields(issue, only) && !(issue as { [NOT_LIVE]?: boolean })[NOT_LIVE]);',
  replace: 'filter((issue) => issueOfFields(issue, only));',
};
const labLive = { vitest: 'apps/web-app/modules/lab/validation.test.ts', name: 'a taken address: told on submit' } as const;

export default defineGegenproben({
  step: 'W10.3',
  cases: [
    // --- Live validation never tells what the database knows (E187/E193/E197) ------------------------------------------------------
    {
      id: 'G1',
      title: 'unique runs in a live validation (no skip at the rule): the database is asked while a field is typed',
      patch: [ruleSkip],
      run: { vitest: 'packages/validation/src/request.test.ts', name: 'the rule does not run: no query' },
      expect: /the database was asked in a live validation/,
    },
    {
      id: 'X1',
      title: 'masking probe: the same in the app — green, the live validation drops the issue marked not live (the filter covers it)',
      patch: [ruleSkip],
      run: labLive,
      expectGreen: true,
    },
    {
      id: 'G1b',
      title: 'the live validation keeps issues marked not live (no filter): a rule inside another library\'s schema tells taken from free',
      patch: [liveFilter],
      run: { vitest: 'packages/validation/src/request.test.ts', name: 'a rule that ran anyway' },
      expect: /a live validation told what a not-live rule found/,
      masks: 'G1',
    },
    {
      id: 'X2',
      title: 'masking probe: the same in the app — green, the rule does not run live (the skip covers it)',
      patch: [liveFilter],
      run: labLive,
      expectGreen: true,
    },
    {
      id: 'G1c',
      title: 'neither: the lab\'s live validation answers a taken address with 422 and a free one with 204',
      patch: [ruleSkip, liveFilter],
      run: labLive,
      expect: /Expected the live validation to pass \(204 with x-marmeon-validated\), got status 422: \{"email":\["The E-mail has already been taken\."\]\}/,
    },
    // --- Messages ------------------------------------------------------------------------------------------------------------------
    {
      id: 'G2',
      title: 'no German text for max.string: a German request reads the English one',
      patch: [{ file: 'packages/i18n/src/lang/de.ts', find: "      string: 'Das Feld {attribute} darf höchstens {max} Zeichen haben.',\n", replace: '' }],
      run: { vitest: 'packages/i18n/src/validation.test.ts', name: 'a German request reads the rules in German' },
      expect: /German max\.string: expected 'The E-Mail field must not be longer/,
    },
    {
      id: 'G6',
      title: 'attributes ignored: the message names the field by its path, not by the request\'s name for it',
      patch: [{ file: 'packages/router/src/request-definition.ts', find: '  const label = labelOf(labels?.attributes, field);', replace: '  const label: string | undefined = undefined;' }],
      run: { vitest: 'packages/validation/src/request.test.ts', name: 'the field\'s name from attributes' },
      expect: /the name of attributes: expected 'The email field must be a valid/,
    },
    // --- Types and structure -------------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'default() no longer makes a field optional: a query is not total — parseQuery refuses it instead of falling back',
      patch: [{ file: 'packages/validation/src/rule.ts', find: 'return this.#modified({ optional: true, nullable: false, fallback: { value } });', replace: 'return this.#modified({ optional: false, nullable: false, fallback: { value } });' }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'default() makes the query total' },
      expect: /A query schema must accept an empty query/,
    },
    {
      id: 'G4',
      title: 'unique not marked async: the rule is built synchronously — its Promise passes for a valid answer, a taken address goes through',
      patch: [{ file: 'packages/validation/src/rule.ts', find: '  return {\n    async: true,\n    contextual: true,', replace: '  return {\n    async: false,\n    contextual: true,' }],
      run: { vitest: 'packages/validation/src/request.test.ts', name: 'unique gets its repository from the request' },
      expect: /expected \{ status: 200, body: \{ name: 'Ada' \} \} to deeply equal \{ status: 200, body:/,
    },
    {
      id: 'G5',
      title: 'issues keep only their last key: users.1.email becomes email — the live validation cannot find the nested field',
      patch: [{ file: 'packages/validation/src/engine.ts', find: 'issue.path?.map((item: { key: PropertyKey }) => item.key);', replace: 'issue.path?.slice(-1).map((item: { key: PropertyKey }) => item.key);' }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'nested paths' },
      expect: /\[ 'users', 1, 'email' \]/,
    },
    {
      id: 'G11',
      title: 'a default list shared between validations: what a handler pushed is the next request\'s default',
      patch: [{ file: 'packages/validation/src/engine.ts', find: 'dataset.value = fallback === undefined ? undefined : copy(fallback.value);', replace: 'dataset.value = fallback === undefined ? undefined : fallback.value;' }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'a default list or object is a copy each time' },
      expect: /the next validation's default: \["changed by a handler"\]/,
    },
    // --- Security of single rules --------------------------------------------------------------------------------------------------
    {
      id: 'G10',
      title: 'url() takes any protocol: javascript:alert(1) is a valid URL',
      patch: [{ file: 'packages/validation/src/rule.ts', find: '  if (!protocols.has(url.protocol)) return false;\n', replace: '' }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'url: absolute http(s) only' },
      expect: /javascript:alert\(1\)/,
    },
    {
      id: 'G13',
      title: 'a regex keeps its g flag: the second test of the same value fails (lastIndex)',
      patch: [{ file: 'packages/validation/src/engine.ts', find: "new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))", replace: 'pattern' }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'never stateful' },
      expect: /the second validation of the same value: .*The code field format is invalid/,
    },
    {
      id: 'G14',
      title: 'a string with a NUL character is a string: Postgres would answer 500 instead of a 422',
      patch: [{ file: 'packages/validation/src/engine.ts', find: "typeof value === 'string' && !value.includes('\\0')", replace: "typeof value === 'string'" }],
      run: { vitest: 'packages/validation/src/rules.test.ts', name: 'no NUL character' },
      expect: /a string with a NUL character: expected undefined to be 'The name field must be a string\.'/,
    },
    {
      id: 'G12',
      title: 'the lab form without its gate: with the lab off, the schema still runs (it asks the database) — a 422, not a 404',
      patch: [{ file: 'apps/web-app/modules/lab/controllers/ValidationLabController.ts', find: '  attributes,\n  authorize: (_ctx, resolve) => resolve(LabGate).open(),\n});\n\n/**\n * The same form', replace: '  attributes,\n});\n\n/**\n * The same form' }],
      run: { vitest: 'apps/web-app/modules/lab/validation.test.ts', name: 'a 404 before the schema runs' },
      expect: /Expected status 404, got 422/,
    },
    // --- The unique index is the truth ---------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'failOnDuplicate passes the conflict on: a race past unique is a 500, not the 422 at the field',
      patch: [{ file: 'packages/database/src/errors.ts', find: '    throw duplicate(byColumn[column]!, input);', replace: '    throw error;' }],
      run: { vitest: 'packages/database/src/unique.test.ts', name: 'failOnDuplicate: a conflict' },
      expect: /expected .* to be an instance of ValidationError/,
    },
    // --- Valibot stays inside, the client stays without it -------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'a declaration names valibot (dist/, what is published): an app emitting .d.ts would need it (TS2742)',
      patch: [{ file: 'packages/validation/dist/index.d.ts', find: "export { VALIDATION_TEXTS } from './texts.ts';", replace: `export { VALIDATION_TEXTS } from './texts.ts';\nexport type { GenericSchema } from '${ENGINE}';` }],
      run: { vitest: 'packages/validation/src/package.test.ts', name: 'no declaration file names it' },
      expect: /declarations that name valibot: .*index\.d\.ts/,
    },
    {
      id: 'G9',
      title: 'a page imports a rule as a value: @marmeon/validation and Valibot land in a client chunk',
      patch: [
        { file: 'apps/web-app/modules/lab/views/Validation.tsx', find: "import { Head, useForm } from '@marmeon/react';\n", replace: "import { Head, useForm } from '@marmeon/react';\nimport { rules } from '@marmeon/validation';\n" },
        { file: 'apps/web-app/modules/lab/views/Validation.tsx', find: '      <h1>Validation lab</h1>\n', replace: '      <h1>Validation lab {String(rules.string()[\'~standard\'].vendor)}</h1>\n' },
      ],
      run: { vitest: 'packages/react/src/bundle-size.test.ts', name: 'the web app opens its layers from a chunk of their own', timeout: 5 * 60_000 },
      expect: /web-app client chunks with validation code: node_modules\/valibot\/.*validation\/dist\/rules\.js/,
    },
  ],
});
