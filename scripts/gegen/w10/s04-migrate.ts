import { defineGegenproben } from '../define.ts';

/**
 * W10.4 — validation moved to `rules` (E197): apps, the starter's template, `make:auth`'s stubs and `make:*` validate with
 * `@marmeon/validation`, and the framework's helpers are rules — `pageQuery()`, `password()`, `upload()`, a table's query. No app,
 * stub or template imports or installs Valibot; `check:source` keeps it so (G1, G2, G2b, G2c), `pack:smoke` proves it on the kit
 * made from the tarballs (G7). The registration asks no database in its schema (E193/E197): a live `unique` tells whether an
 * address has an account (G4) — and a `unique` that is not live still tells on submit (G4b), which the rule's default (not live)
 * cannot hide from the byte test; X4 shows that default covering the live answer on its own (masking pair G4 ↔ G4b).
 */
/** The engine's name in parts — `check:source` finds an import of it outside a package's src/, this file's patches too. */
const ENGINE = ['vali', 'bot'].join('');
const checkSource = { command: ['pnpm', 'run', 'check:source'] } as const;
const smoke = { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * 60_000 } as const;
const TEMPLATE_MANIFEST = 'packages/create-marmeon/template/base/_package.json';
const engineInTemplate = { file: TEMPLATE_MANIFEST, find: '    "react-dom": "^19.3.0"\n  },', replace: `    "react-dom": "^19.3.0",\n    "${ENGINE}": "^1.5.0"\n  },` };
const REGISTER = 'apps/web-app/modules/auth/controllers/RegisterController.ts';
const registerEmail = "const email = r.string().trim().lowercase().required().max(255).email();";

export default defineGegenproben({
  step: 'W10.4',
  cases: [
    // --- No engine in apps, stubs, templates and generators (check:source) ---------------------------------------------------------
    {
      id: 'G1',
      title: 'the template lists valibot again: check:source names the manifest',
      patch: [engineInTemplate],
      run: checkSource,
      expect: /packages\/create-marmeon\/template\/base\/_package\.json: dependencies lists valibot — an app validates with @marmeon\/validation/,
    },
    {
      id: 'G2',
      title: 'a make:auth stub imports valibot: check:source names the line',
      patch: [{ file: 'packages/auth/stubs/react/modules/auth/controllers/LoginController.ts', find: "import { rules as r } from '@marmeon/validation';\n", replace: `import { rules as r } from '@marmeon/validation';\nimport * as v from '${ENGINE}';\n` }],
      run: checkSource,
      expect: /packages\/auth\/stubs\/react\/modules\/auth\/controllers\/LoginController\.ts:\d+: import \* as v from '[v]alibot';/,
    },
    {
      id: 'G2b',
      title: 'a make:* template imports valibot (its source sits in packages/cli/src, the code it writes is app code): check:source names it',
      patch: [{ file: 'packages/cli/src/commands/make.ts', find: "import type { JobContext, JobPayload } from '@marmeon/queue';\nimport { rules as r } from '@marmeon/validation';", replace: `import type { JobContext, JobPayload } from '@marmeon/queue';\nimport * as v from '${ENGINE}';` }],
      run: checkSource,
      expect: /packages\/cli\/src\/commands\/make\.ts:\d+: import \* as v from '[v]alibot';/,
    },
    {
      id: 'G2c',
      title: 'the web app lists valibot again: check:source names its manifest',
      patch: [{ file: 'apps/web-app/package.json', find: '    "react-dom": "^19.3.0"\n  },', replace: `    "react-dom": "^19.3.0",\n    "${ENGINE}": "^1.5.0"\n  },` }],
      run: checkSource,
      expect: /apps\/web-app\/package\.json: dependencies lists valibot/,
    },
    // --- The helpers are rules -----------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'pageQuery() without a default page: the query is not total any more — /people answers 500 instead of the first page',
      patch: [{ file: 'packages/database/src/pagination.ts', find: '    page: r.integer().min(1).default(1),', replace: '    page: r.integer().min(1),' }],
      run: { vitest: 'apps/web-app/modules/user-profile/people.test.ts', name: 'pages by the query schema (pageQuery)' },
      expect: /Expected status 200, got 500/,
    },
    {
      id: 'G5',
      title: 'upload() without its mark: the upload target finds no upload field on the route — 404, the avatar never uploads',
      patch: [{ file: 'packages/storage/src/uploads/rule.ts', find: '    { meta: { [UPLOAD_RULE]: rule } },', replace: '    {},' }],
      run: { vitest: 'apps/web-app/modules/user-profile/avatar.test.ts', name: 'uploads to the private uploads disk' },
      expect: /The upload target of user-profile\.avatar\.update \(avatar\) answered 404/,
    },
    {
      id: 'G6',
      title: 'an object rule without entries: a table\'s query cannot be spread into another query',
      patch: [{ file: 'packages/validation/src/rule.ts', find: '  get entries(): S {', replace: '  get fields(): S {' }],
      run: { vitest: 'packages/table/src/state.test.ts' },
      expect: /Cannot convert undefined or null to object/,
    },
    // --- The registration asks no database (E193/E197) ----------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the registration checks unique — live: a taken address is told while it is typed (private registration, E146)',
      patch: [{ file: REGISTER, find: registerEmail, replace: registerEmail.replace('.email();', ".email().unique(UserRepository, 'email', { message: 'auth.validation.email_taken' }).live();") }],
      run: { vitest: 'apps/web-app/modules/auth/live-validation.test.ts', name: 'never tells whether an address has an account — like the submit' },
      expect: /Expected the live validation to pass \(204 with x-marmeon-validated\), got status 422: \{"email":\["This e-mail address is already registered\."\]\}/,
      masks: 'G4b',
    },
    {
      id: 'X4',
      title: 'masking probe: unique without .live() — the rule\'s default keeps it out of a live check: the live test stays green',
      patch: [{ file: REGISTER, find: registerEmail, replace: registerEmail.replace('.email();', ".email().unique(UserRepository, 'email', { message: 'auth.validation.email_taken' });") }],
      run: { vitest: 'apps/web-app/modules/auth/live-validation.test.ts', name: 'never tells whether an address has an account — like the submit' },
      expectGreen: true,
    },
    {
      id: 'G4b',
      title: 'unique without .live(): the submit tells a known address from a new one — the byte test of private registration fails',
      patch: [{ file: REGISTER, find: registerEmail, replace: registerEmail.replace('.email();', ".email().unique(UserRepository, 'email', { message: 'auth.validation.email_taken' });") }],
      run: { vitest: 'apps/web-app/modules/auth/auth.test.ts', name: 'answers a new and a known address byte for byte alike' },
      expect: /a known address is answered differently from a new one: expected/,
      masks: 'G4',
    },
    // --- The kit from the tarballs -------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'the kit installs valibot (the template lists it): pack:smoke refuses the generated package.json',
      patch: [engineInTemplate],
      run: smoke,
      expect: /package\.json dependencies list valibot — a new app validates with @marmeon\/validation and installs no engine \(E197\)/,
    },
  ],
});
