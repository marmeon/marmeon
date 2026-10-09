import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSource, DOC_TEXT_RULES, ENGINE, engineHits, negativeEnvHits, oldNameHits, OLD_NAME, OLD_TOKEN_PREFIX, oldTokenPrefixHits, runtimeStringHits, textRuleHits, textRuleWhere } from './check-source.ts';
import { parts } from './ci.ts';
import { checkDriverRule, frameworkPackages } from './packages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('pnpm run ci (E111)', () => {
  it('never runs the Gegenproben — they patch the working tree (E188: pnpm gegen is run by hand, not by CI)', () => {
    const gegen = parts.filter((part) => /gegen/.test(`${part.name} ${part.command.join(' ')}`)).map((part) => part.name);
    expect(gegen).toEqual([]);
  });

  it('runs check:source', () => {
    expect(parts.find((part) => part.name === 'check:source')?.command).toEqual(['pnpm', 'run', 'check:source']);
  });
});

describe('check:source — the old name is gone (E196)', () => {
  const old = OLD_NAME; // spelled in parts by the script: this file passes the rule too
  const lower = old.toLowerCase();

  it('holds for the repository', () => {
    const problems = checkSource();
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('finds the old name in any case, in text and in paths', () => {
    const hits = oldNameHits([
      { path: 'packages/http/src/headers.ts', text: `const a = 1;\nexport const VERSION = 'x-${lower}-version';\n` },
      { path: 'packages/cli/src/env.ts', text: `process.env.${old.toUpperCase()}_CHILD` },
      { path: 'docs/guide.md', text: `${old}Core, the framework` },
      { path: `packages/${lower}-app/README.md`, text: '# An app' },
    ]);
    expect(hits).toEqual([
      `packages/http/src/headers.ts:2: export const VERSION = 'x-${lower}-version';`,
      `packages/cli/src/env.ts:1: process.env.${old.toUpperCase()}_CHILD`,
      `docs/guide.md:1: ${old}Core, the framework`,
      `packages/${lower}-app/README.md: the path says the old name — rename it (git mv)`,
    ]);
  });

  it('allows the old name only as the company name — no rename hint, not even in README.md or UPGRADING.md', () => {
    const hint = `Marmeon was called ${old}Core up to 0.1.0.`;
    expect(oldNameHits([{ path: 'packages/core/LICENSE', text: `MIT License\n\nCopyright (c) 2026 ${old}Code\n` }])).toEqual([]);
    const hits = oldNameHits([
      { path: 'README.md', text: hint },
      { path: 'UPGRADING.md', text: `**${hint}**` },
      { path: 'docs/versioning.md', text: hint },
    ]);
    // The hits as the message too: Vitest shortens the list in its own, and a Gegenprobe reads which file went missing.
    expect(hits, `found: ${hits.join(' | ') || 'nothing'}`).toEqual([`README.md:1: ${hint}`, `UPGRADING.md:1: **${hint}**`, `docs/versioning.md:1: ${hint}`]);
    // The company name does not cover another mention on its line.
    expect(oldNameHits([{ path: 'LICENSE', text: `${old}Code and ${old}Core` }])).toHaveLength(1);
  });
});

describe('check:source — no app, stub or template installs the validation engine (E197)', () => {
  const engine = ENGINE; // spelled in parts by the script: this file holds no import of it either
  const manifest = (dependencies: Record<string, string>) => JSON.stringify({ name: 'app', dependencies }, null, 2);

  it('finds an import outside a package\'s src/ — an app, a stub, the template, a script that writes app code, a generator', () => {
    const hits = engineHits([
      { path: 'apps/web-app/config/app.ts', text: `import { defineConfig } from '@marmeon/core';\nimport * as v from '${engine}';\n` },
      { path: 'packages/auth/stubs/react/modules/auth/controllers/LoginController.ts', text: `import { object } from "${engine}";` },
      { path: 'packages/create-marmeon/template/base/config/app.ts', text: `const v = await import('${engine}');` },
      { path: 'scripts/image-smoke.ts', text: `writeFileSync(file, "import * as v from '${engine}';");` },
      { path: 'packages/cli/src/commands/make.ts', text: `const JOB = \`import * as v from '${engine}/schemas';\`;` },
      // A package's own sources keep it inside (env schemas, tests) — and prose naming it is no import.
      { path: 'packages/queue/src/config.ts', text: `import * as v from '${engine}';` },
      { path: 'packages/validation/README.md', text: `${engine} is the engine — never re-exported.` },
      { path: 'apps/docs/modules/docs/notes.ts', text: `// ${engine} stays inside @marmeon/validation` },
    ]);
    expect(hits).toEqual([
      `apps/web-app/config/app.ts:2: import * as v from '${engine}';`,
      `packages/auth/stubs/react/modules/auth/controllers/LoginController.ts:1: import { object } from "${engine}";`,
      `packages/create-marmeon/template/base/config/app.ts:1: const v = await import('${engine}');`,
      `scripts/image-smoke.ts:1: writeFileSync(file, "import * as v from '${engine}';");`,
      `packages/cli/src/commands/make.ts:1: const JOB = \`import * as v from '${engine}/schemas';\`;`,
    ]);
  });

  it('finds it in the manifest of an app or of the template — not in a package\'s', () => {
    expect(engineHits([
      { path: 'apps/blank-app/package.json', text: manifest({ [engine]: '^1.5.0' }) },
      { path: 'packages/create-marmeon/template/base/_package.json', text: manifest({ '@marmeon/validation': 'workspace:*', [engine]: '^1.5.0' }) },
      { path: 'packages/validation/package.json', text: manifest({ [engine]: '^1.5.0' }) },
      { path: 'apps/docs/package.json', text: manifest({ '@marmeon/validation': 'workspace:*' }) },
    ])).toEqual([
      `apps/blank-app/package.json: dependencies lists ${engine} — an app validates with @marmeon/validation`,
      `packages/create-marmeon/template/base/_package.json: dependencies lists ${engine} — an app validates with @marmeon/validation`,
    ]);
  });
});

describe('check:source — NODE_ENV is checked positively (E201)', () => {
  it('finds a negative or a production check in a package\'s code — sources and stubs, any quotes, either side', () => {
    const hits = negativeEnvHits([
      { path: 'packages/react/src/app.tsx', text: "const a = 1;\nif (process.env.NODE_ENV !== 'production') console.warn('[marmeon] …');\n" },
      { path: 'packages/http/src/client/poll.ts', text: 'throw new RangeError(process.env.NODE_ENV != "production" ? long : short);' },
      { path: 'packages/table/src/client/table.ts', text: "refuse(code, name, 'production' !== process.env.NODE_ENV && text);" },
      { path: 'packages/vite/src/index.ts', text: "const source = command === 'serve' && mode !== `production` ? [SOURCE] : [];" },
      { path: 'packages/react/src/client.tsx', text: "if (process.env.NODE_ENV === 'production') return;" },
      { path: 'packages/server/src/kernel.ts', text: "const strict = 'production' == env.NODE_ENV;" },
      { path: 'packages/auth/stubs/react/modules/auth/views/Login.tsx', text: "{process.env.NODE_ENV !== 'production' && <DevHint />}" },
    ]);
    expect(hits).toEqual([
      "packages/react/src/app.tsx:2: if (process.env.NODE_ENV !== 'production') console.warn('[marmeon] …');",
      'packages/http/src/client/poll.ts:1: throw new RangeError(process.env.NODE_ENV != "production" ? long : short);',
      "packages/table/src/client/table.ts:1: refuse(code, name, 'production' !== process.env.NODE_ENV && text);",
      "packages/vite/src/index.ts:1: const source = command === 'serve' && mode !== `production` ? [SOURCE] : [];",
      "packages/react/src/client.tsx:1: if (process.env.NODE_ENV === 'production') return;",
      "packages/server/src/kernel.ts:1: const strict = 'production' == env.NODE_ENV;",
      "packages/auth/stubs/react/modules/auth/views/Login.tsx:1: {process.env.NODE_ENV !== 'production' && <DevHint />}",
    ]);
  });

  it('leaves the positive form, other comparisons with production, tests, fixtures, apps and prose alone', () => {
    expect(negativeEnvHits([
      { path: 'packages/react/src/app.tsx', text: "if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') warn();" },
      { path: 'packages/cli/src/commands/tinker.ts', text: "const label = name === undefined || name === 'production' ? 'PRODUCTION' : 'PROTECTED';" },
      { path: 'packages/cli/src/commands/build.ts', text: "await vite.resolveConfig(shared, 'build', 'production', 'production');" },
      { path: 'packages/react/src/bundle-size.test.ts', text: "// `process.env.NODE_ENV !== 'production'` stays out of a production bundle" },
      { path: 'packages/react/src/__fixtures__/bundle.ts', text: "if (process.env.NODE_ENV !== 'production') x();" },
      { path: 'apps/web-app/modules/lab/lab.test.ts', text: "if (process.env.NODE_ENV !== 'production') x();" },
      { path: 'packages/create-marmeon/template/base/modules/home/home.test.ts', text: 'if (import.meta.env.DEV) x();' },
      { path: 'packages/core/README.md', text: "never `!== 'production'`" },
      { path: 'packages/react/src/app.tsx', text: 'if (import.meta.env.PROD) x(); const devtools = import.meta.env.DEVTOOLS;' },
    ])).toEqual([]);
  });

  it('covers the apps and the starter\'s template too — what people copy — and Vite\'s DEV / !PROD (true in a staging build)', () => {
    expect(negativeEnvHits([
      { path: 'apps/web-app/modules/lab/views/Lab.tsx', text: "if (process.env.NODE_ENV !== 'production') x();" },
      { path: 'packages/create-marmeon/template/base/bootstrap/client.tsx', text: 'if (import.meta.env.DEV) console.info(\'dev\');' },
      { path: 'packages/create-marmeon/template/kit/modules/auth/views/Login.tsx', text: '{!import.meta.env.PROD && <DevHint />}' },
      { path: 'packages/react/src/app.tsx', text: 'const debug = import.meta.env.DEV;' },
    ])).toEqual([
      "apps/web-app/modules/lab/views/Lab.tsx:1: if (process.env.NODE_ENV !== 'production') x();",
      "packages/create-marmeon/template/base/bootstrap/client.tsx:1: if (import.meta.env.DEV) console.info('dev');",
      'packages/create-marmeon/template/kit/modules/auth/views/Login.tsx:1: {!import.meta.env.PROD && <DevHint />}',
      'packages/react/src/app.tsx:1: const debug = import.meta.env.DEV;',
    ]);
  });
});

describe('check:source — the old token prefix is gone (E207)', () => {
  const old = OLD_TOKEN_PREFIX; // spelled in parts by the script

  it('finds it before a digit, a pipe, a quote, whitespace or the line\'s end — not inside a word', () => {
    expect(oldTokenPrefixHits([
      { path: 'packages/auth/src/config.ts', text: `AUTH_TOKEN_PREFIX: v.optional(…, '${old}'),` },
      { path: 'packages/auth/README.md', text: `// plainText: '${old}12|<40 characters><crc32>'` },
      { path: 'apps/web-app/.env.example', text: `# AUTH_TOKEN_PREFIX=${old}` },
      { path: 'packages/http/src/client/layer.test.ts', text: `plainText: '${old}1|secret'` },
      { path: 'packages/validation/src/rules.test.ts', text: `tags: ['a', 'bc'], abc_x, my-${old}thing` },
    ])).toEqual([
      `packages/auth/src/config.ts:1: AUTH_TOKEN_PREFIX: v.optional(…, '${old}'),`,
      `packages/auth/README.md:1: // plainText: '${old}12|<40 characters><crc32>'`,
      `apps/web-app/.env.example:1: # AUTH_TOKEN_PREFIX=${old}`,
      `packages/http/src/client/layer.test.ts:1: plainText: '${old}1|secret'`,
    ]);
  });

  it('allows it nowhere — no release handed out a token with it, so the upgrade guide has no way back to it either', () => {
    expect(oldTokenPrefixHits([
      { path: 'UPGRADING.md', text: `The way back: \`AUTH_TOKEN_PREFIX=${old}\`.` },
      { path: 'README.md', text: `AUTH_TOKEN_PREFIX=${old}` },
    ])).toEqual([`UPGRADING.md:1: The way back: \`AUTH_TOKEN_PREFIX=${old}\`.`, `README.md:1: AUTH_TOKEN_PREFIX=${old}`]);
  });
});

describe('check:source — the docs speak to their readers (rule 5)', () => {
  const rule = (what: string) => DOC_TEXT_RULES.find((entry) => entry.what === what)!;
  const decisions = rule('a decision number');
  const waves = rule('a wave reference');
  const marker = rule('the pending marker');

  it('finds a decision number in the docs, the package cards, the root README, CONTRIBUTING, SECURITY and UPGRADING — not in code', () => {
    expect(textRuleHits([
      { path: 'docs/queues.md', text: 'A job runs once.\nThe claim is fair (E199).' },
      { path: 'packages/queue/README.md', text: 'Fair by default, E199.' },
      { path: 'README.md', text: 'See E36.' },
      { path: 'CONTRIBUTING.md', text: '(E123)' },
      { path: 'SECURITY.md', text: 'E210: the docs' },
      { path: 'UPGRADING.md', text: 'Since E199 the claim is fair.' },
      { path: 'packages/queue/src/worker.ts', text: '// E199' },
      { path: 'apps/web-app/README.md', text: 'E147' },
      { path: 'docs/sub/page.md', text: 'E12' },
    ], decisions)).toEqual([
      'docs/queues.md:2: The claim is fair (E199).',
      'packages/queue/README.md:1: Fair by default, E199.',
      'README.md:1: See E36.',
      'CONTRIBUTING.md:1: (E123)',
      'SECURITY.md:1: E210: the docs',
      'UPGRADING.md:1: Since E199 the claim is fair.',
    ]);
  });

  it('takes no hex value, exponent, E2E or E.164 for a decision number', () => {
    const text = ['`0xE12`, `#E1234`, 1E10 and 2e10', 'E2E tests, E.164 numbers, E1 and E1000', 'BE12, E12a, the E-mail'].join('\n');
    expect(textRuleHits([{ path: 'docs/notifications.md', text }], decisions)).toEqual([]);
  });

  it('finds a wave reference in the docs, the package cards and the upgrade guide — not in CONTRIBUTING (its Gegenproben\'s paths)', () => {
    expect(textRuleHits([
      { path: 'docs/routing.md', text: 'Since W9 the router is typed.' },
      { path: 'docs/forms.md', text: 'as of W10.4, and in wave 3' },
      { path: 'packages/live/README.md', text: 'New in Wave 9.' },
      { path: 'UPGRADING.md', text: '### Wave 10 — lean dependencies' },
      { path: 'CONTRIBUTING.md', text: "Wave 9 wrote it: `scripts/gegen/w10/s09-docs.ts`, step: 'W9.4'" },
      { path: 'docs/csp.md', text: 'W3C, HTTP/2, AW3 and W-9' },
    ], waves)).toEqual([
      'docs/routing.md:1: Since W9 the router is typed.',
      'docs/forms.md:1: as of W10.4, and in wave 3',
      'packages/live/README.md:1: New in Wave 9.',
      'UPGRADING.md:1: ### Wave 10 — lean dependencies',
    ]);
  });

  it('finds the pending marker as a line of its own in a docs page — not mentioned inline, not in CONTRIBUTING', () => {
    expect(textRuleHits([
      { path: 'docs/routing.md', text: '# Routing\n<!-- docs:pending -->\n\nText.' },
      { path: 'docs/middleware.md', text: '# Middleware\n  <!-- docs:pending -->  ' },
      { path: 'docs/csrf.md', text: 'A page carries `<!-- docs:pending -->` until it is written.' },
      { path: 'CONTRIBUTING.md', text: '<!-- docs:pending -->' },
    ], marker)).toEqual(['docs/routing.md:2: <!-- docs:pending -->', 'docs/middleware.md:2: <!-- docs:pending -->']);
  });

  it('reads what every new app copies too — the starter\'s template and the packages\' stubs — but not the code that copies it', () => {
    const files = [
      { path: 'packages/create-marmeon/template/base/.env.example', text: '# Behind a proxy, X-Forwarded-* count (E162)\n# since Wave 10' },
      { path: 'packages/create-marmeon/template/kit/bootstrap/client.tsx', text: '// the dialog asks (E64)' },
      { path: 'packages/auth/stubs/react/modules/auth/routes.ts', text: '// Private registration (E146): one answer (W9 step 11)' },
      { path: 'packages/queue/stubs/migrations/create_jobs_table.ts', text: '// the fair claim (E199) walks this index' },
      { path: 'packages/create-marmeon/src/main.ts', text: '// the template (E167), W10' },
      { path: 'packages/auth/src/make-auth.ts', text: '// the stubs (E30), W2' },
    ];
    expect(textRuleHits(files, decisions)).toEqual([
      'packages/create-marmeon/template/base/.env.example:1: # Behind a proxy, X-Forwarded-* count (E162)',
      'packages/create-marmeon/template/kit/bootstrap/client.tsx:1: // the dialog asks (E64)',
      'packages/auth/stubs/react/modules/auth/routes.ts:1: // Private registration (E146): one answer (W9 step 11)',
      'packages/queue/stubs/migrations/create_jobs_table.ts:1: // the fair claim (E199) walks this index',
    ]);
    expect(textRuleHits(files, waves)).toEqual([
      'packages/create-marmeon/template/base/.env.example:2: # since Wave 10',
      'packages/auth/stubs/react/modules/auth/routes.ts:1: // Private registration (E146): one answer (W9 step 11)',
    ]);
  });

  it('finds a personal date of the plan in what a new app copies — not a cookie\'s Max-Age, a version or an address', () => {
    const dates = rule('a personal date');
    expect(textRuleHits([
      { path: 'packages/auth/stubs/react/modules/auth/migrations/0001_create_users.ts', text: ' * set once (Max 07.10.) — never cleared' },
      { path: 'packages/auth/stubs/react/modules/auth/prune.test.ts', text: "it('keeps it for good (Max, 07.10.)', async () => {" },
      { path: 'packages/create-marmeon/template/base/.env.example', text: '# decided on 09.10. by the team' },
      { path: 'packages/create-marmeon/template/base/config/session.ts', text: "// Max-Age=0 ends it; max 255; Marmeon 0.2.0; 127.0.0.1 or 10.0.0.0/8" },
      { path: 'packages/create-marmeon/src/main.ts', text: '// Max 07.10.' },
    ], dates)).toEqual([
      'packages/auth/stubs/react/modules/auth/migrations/0001_create_users.ts:1: * set once (Max 07.10.) — never cleared',
      "packages/auth/stubs/react/modules/auth/prune.test.ts:1: it('keeps it for good (Max, 07.10.)', async () => {",
      'packages/create-marmeon/template/base/.env.example:1: # decided on 09.10. by the team',
    ]);
  });

  it('finds a comparison with another framework in the docs, the package cards, the root texts and what a new app copies', () => {
    const frameworks = rule('a comparison with another framework');
    expect(textRuleHits([
      { path: 'docs/authentication.md', text: 'Like Laravel Breeze, the module is yours.' },
      { path: 'packages/validation/README.md', text: "Inertia's partial reloads" },
      { path: 'packages/auth/stubs/react/modules/auth/controllers/LoginController.ts', text: "/** (Laravel Breeze's default). */" },
      { path: 'packages/create-marmeon/template/base/.env.example', text: "# like Laravel's starter kits" },
      { path: 'docs/routing.md', text: 'rails of a track, a breeze of air, laravel in lower case' },
      { path: 'packages/create-marmeon/src/main.ts', text: '// like create-nuxt and Laravel' },
      { path: 'README.md', text: 'A framework like Rails.' },
      { path: 'CONTRIBUTING.md', text: "Laravel's style guide" },
      { path: 'SECURITY.md', text: 'as Symfony does' },
      { path: 'UPGRADING.md', text: "in Laravel's manner" },
    ], frameworks)).toEqual([
      'docs/authentication.md:1: Like Laravel Breeze, the module is yours.',
      "packages/validation/README.md:1: Inertia's partial reloads",
      "packages/auth/stubs/react/modules/auth/controllers/LoginController.ts:1: /** (Laravel Breeze's default). */",
      "packages/create-marmeon/template/base/.env.example:1: # like Laravel's starter kits",
      'README.md:1: A framework like Rails.',
      "CONTRIBUTING.md:1: Laravel's style guide",
      'SECURITY.md:1: as Symfony does',
      "UPGRADING.md:1: in Laravel's manner",
    ]);
  });

  it('names each rule in the problems of check:source — and where it was found', () => {
    expect(DOC_TEXT_RULES.map((entry) => entry.what)).toEqual([
      'a decision number',
      'a wave reference',
      'the pending marker',
      'a personal date',
      'a comparison with another framework',
    ]);
    expect(textRuleWhere('docs/queues.md')).toBe('in the docs');
    expect(textRuleWhere('packages/queue/README.md')).toBe('in the docs');
    expect(textRuleWhere('UPGRADING.md')).toBe('in the docs');
    expect(textRuleWhere('packages/auth/stubs/react/modules/auth/routes.ts')).toBe('in what every new app copies');
    expect(textRuleWhere('packages/create-marmeon/template/base/.env.example')).toBe('in what every new app copies');
    expect(textRuleWhere('packages/session/stubs/migrations/create_sessions_table.ts')).toBe('in what every new app copies');
  });
});

describe("check:source — the framework's messages speak to app developers (rule 6)", () => {
  it('finds a decision number, a wave reference or another framework in a string of a package\'s code — the text an app sees', () => {
    const text = [
      "throw new Error('An app in the build phase is never booted (E187).');",
      'const hint = `read-only (W6.9) — ${what}`;',
      "const a = 'Laravel\\'s rules, typed';",
      'const view = <p>Development only (E115)</p>;',
      'const b = "fine (W10.4)";',
    ].join('\n');
    expect(runtimeStringHits([{ path: 'packages/core/src/application.tsx', text }])).toEqual([
      "packages/core/src/application.tsx:1: a decision number: 'An app in the build phase is never booted (E187).'",
      'packages/core/src/application.tsx:2: a wave reference: `read-only (W6.9) — ${',
      "packages/core/src/application.tsx:3: a comparison with another framework: 'Laravel\\'s rules, typed'",
      'packages/core/src/application.tsx:4: a decision number: Development only (E115)',
      'packages/core/src/application.tsx:5: a wave reference: "fine (W10.4)"',
    ]);
  });

  it('reads the launchers too — packages/<name>/bin/*.js print to every developer', () => {
    const text = ["// E108: one process (W8 step 4)", "console.error('marmeon needs Node 26 (E108).');", 'const w = `since Wave 10`;'].join('\n');
    expect(runtimeStringHits([
      { path: 'packages/cli/bin/marmeon.js', text },
      { path: 'packages/create-marmeon/bin/create-marmeon.js', text: "process.stderr.write('Laravel-like starter\\n');" },
      { path: 'packages/cli/bin/sub/helper.js', text: "const e = '(E62)';" },
      { path: 'packages/cli/scripts/build.js', text: "const e = '(E62)';" },
    ])).toEqual([
      "packages/cli/bin/marmeon.js:2: a decision number: 'marmeon needs Node 26 (E108).'",
      'packages/cli/bin/marmeon.js:3: a wave reference: since Wave 10',
      "packages/create-marmeon/bin/create-marmeon.js:1: a comparison with another framework: 'Laravel-like starter\\n'",
    ]);
  });

  it('leaves comments, regular expressions, names and the code of tests, fixtures, scripts and apps alone', () => {
    const code = [
      '// E187: the build phase (W10 step 9) — Laravel did it so',
      '/** (E108) */ const E108 = /\\bE\\d{2,3}\\b/;',
      "const fine = 'E2E, E.164, #E1234, 0xE12 and W3C';",
    ].join('\n');
    expect(runtimeStringHits([
      { path: 'packages/core/src/a.ts', text: code },
      { path: 'packages/core/src/a.test.ts', text: "it('builds (E187)', () => {});" },
      { path: 'packages/core/src/__fixtures__/b.ts', text: "export const b = 'E187';" },
      { path: 'scripts/check-source.ts', text: "const w = 'W8';" },
      { path: 'apps/web-app/modules/lab/a.ts', text: "const e = '(E62)';" },
    ])).toEqual([]);
  });
});

describe('the driver rule (E198)', () => {
  it('holds for every package: one wrapped driver a dependency, one of several an optional peer, a shared library a peer', () => {
    const problems = frameworkPackages(root).flatMap((pkg) => checkDriverRule(pkg.short, pkg.manifest).map((problem) => `${pkg.name}: ${problem}`));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('names what breaks it', () => {
    expect(checkDriverRule('redis', { peerDependencies: { redis: '^6.0.0' }, peerDependenciesMeta: { redis: { optional: true } } })).toEqual([
      'redis must be a dependency (E198: the one driver this package wraps — the app installs nothing else)',
    ]);
    expect(checkDriverRule('redis', { dependencies: { redis: '6.2.1' } })).toEqual(['dependencies.redis is "6.2.1" — a caret range of the tested major (^6.2.1, E198)']);
    expect(checkDriverRule('database', { dependencies: { pg: '^8.23.0' } })).toEqual([
      'pg must stay an optional peer, not a dependency (E198) — one of several drivers; every app would install it',
      'pg must be an optional peer of this package (E198)',
    ]);
    expect(checkDriverRule('database', { peerDependencies: { pg: '^8.23.0' } })).toEqual(['pg must be an optional peer (peerDependenciesMeta) — the app installs it only for that driver (E198)']);
    // One API instance: the app's SDK registers on the API the framework reads — a second copy would be a second instance.
    expect(checkDriverRule('otel', { dependencies: { '@opentelemetry/api': '^1.9.0' }, peerDependencies: { '@opentelemetry/api': '^1.9.0' } })).toEqual([
      '@opentelemetry/api must stay a peer, not a dependency (E198) — the app and the framework share one instance; a dependency installs a second copy',
      '@opentelemetry/api is a dependency — the app and the framework must share one instance of it: a peer (E198)',
    ]);
    expect(checkDriverRule('table', { dependencies: { react: '^19.3.0' } })).toEqual(['react is a dependency — the app and the framework must share one instance of it: a peer (E198)']);
  });
});
