import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkSource,
  DOC_TEXT_RULES,
  ENGINE,
  engineHits,
  INTERNAL,
  internalImportHits,
  negativeEnvHits,
  mutationCommentHits,
  oldNameHits,
  OLD_NAME,
  OLD_TOKEN_PREFIX,
  oldTokenPrefixHits,
  PRIVATE_RECORD_RULES,
  privateRecordHits,
  privateRecordWhy,
  runtimeStringHits,
  textRuleHits,
  textRuleWhere,
} from './check-source.ts';
import { commandFor, parts, parseShard } from './ci.ts';
import { checkTarball, privateRecordInTarball } from './pack-check.ts';
import { checkDriverRule, frameworkPackages } from './packages.ts';
import { tempDir } from './test/temp-dir.js';

const root = fileURLToPath(new URL('..', import.meta.url));
/** This file's samples of the private record carry a `·` inside each reference, so the file passes rule 7 itself; `ref()` takes it out. */
const ref = (text: string) => text.replaceAll('·', '');

describe('pnpm run ci', () => {
  it('runs check:source', () => {
    expect(parts.find((part) => part.name === 'check:source')?.command).toEqual(['pnpm', 'run', 'check:source']);
  });

  const part = (name: string) => parts.find((entry) => entry.name === name)!;
  const ci = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/ci.ts'), ...args], { cwd: root, encoding: 'utf8' });

  it('hands --shard to the test runs and to nothing else', () => {
    expect(commandFor(part('test'), '2/3')).toEqual(['pnpm', 'run', 'test', '--shard=2/3']);
    for (const name of ['test:pgsql', 'test:redis', 'test:s3']) expect(commandFor(part(name), '1/2')).toEqual([...part(name).command, '--shard=1/2']);
    expect(commandFor(part('test'))).toEqual(part('test').command);
    for (const name of ['build', 'size', 'lint']) expect(commandFor(part(name), '2/3')).toEqual(part(name).command);
  });

  it('accepts i/n from 1 with i not above n, and nothing else', () => {
    for (const ok of ['1/1', '1/3', '3/3', '10/12']) expect(parseShard(ok), ok).toBe(ok);
    for (const bad of ['0/3', '4/3', '1/0', 'a/b', '3', '1/', '/3', '-1/3', '1.5/3', '01/3', '1/3/3', ' 1/3', '']) expect(parseShard(bad), bad).toBeUndefined();
  });

  it('refuses a malformed --shard, and one with no test run selected, with exit 2', () => {
    for (const bad of ['0/3', '4/3', 'a/b', '3']) {
      const run = ci('--only', 'test', '--shard', bad);
      expect(run.status, bad).toBe(2);
      expect(run.stderr, bad).toContain('expected i/n');
    }
    const none = ci('--only', 'size', '--shard', '1/2');
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('none is selected');
  });

  it('shows which parts --shard splits in --list', () => {
    const lines = ci('--list').stdout.split('\n');
    const sharded = lines.filter((line) => line.includes('(--shard)')).map((line) => line.trim().split(/\s+/)[0]);
    expect(sharded).toEqual(['test', 'test:pgsql', 'test:redis', 'test:s3']);
  });

  it('splits the test run over three jobs in the workflow, the check job without it', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const job = /^  test:\n([\s\S]*?)(?=^  \S)/m.exec(workflow)?.[1] ?? '';
    const matrix = /shard:\s*\[([^\]]*)\]/.exec(job)?.[1]?.split(',').map((entry) => entry.trim());
    expect(matrix).toEqual(['1', '2', '3']);
    expect(job).toContain('--only build,test --shard "$SHARD/3"');
    expect(workflow).toMatch(/--only build,typecheck,lint,size,types:check,website:check,check-release\s*$/m);
  });

  it('splits test:pgsql over two shard jobs behind an aggregator that keeps the name test:pgsql', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const shards = /^  pgsql-shards:\n([\s\S]*?)(?=^  \S)/m.exec(workflow)?.[1] ?? '';
    expect(/shard:\s*\[([^\]]*)\]/.exec(shards)?.[1]?.split(',').map((entry) => entry.trim())).toEqual(['1', '2']);
    expect(shards).toContain('name: test:pgsql (${{ matrix.shard }}/2)');
    expect(shards).toContain('--only build,test:pgsql --no-compose --shard "$SHARD/2"');
    expect(shards).toMatch(/^ {6}pgsql:\n/m); // each shard has its own Postgres service
    const aggregate = /^  pgsql:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m.exec(workflow)?.[1] ?? '';
    expect(aggregate).toContain('name: test:pgsql\n');
    expect(aggregate).toContain('needs: pgsql-shards');
    expect(aggregate).toMatch(/^ {4}if: always\(\)$/m);
    expect(aggregate).toContain('RESULT: ${{ needs.pgsql-shards.result }}');
    expect(aggregate).toContain('test "$RESULT" = success');
    expect(aggregate).not.toMatch(/uses:/);
    expect(aggregate.replace(/^\s*RESULT: .*$/m, '')).not.toContain('${{');
  });
});

describe('check:source — the old name is gone', () => {
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

  it('allows the old name only as the company name and its website — no rename hint, not even in README.md or UPGRADING.md', () => {
    const hint = `Marmeon was called ${old}Core up to 0.1.0.`;
    expect(oldNameHits([{ path: 'packages/core/LICENSE', text: `MIT License\n\nCopyright (c) 2026 ${old}Code\n` }])).toEqual([]);
    const hits = oldNameHits([
      { path: 'README.md', text: hint },
      { path: 'UPGRADING.md', text: `**${hint}**` },
      { path: 'docs/versioning.md', text: hint },
    ]);
    // The hits as the message too: Vitest shortens the list in its own.
    expect(hits, `found: ${hits.join(' | ') || 'nothing'}`).toEqual([`README.md:1: ${hint}`, `UPGRADING.md:1: **${hint}**`, `docs/versioning.md:1: ${hint}`]);
    expect(oldNameHits([{ path: 'README.md', text: `[${old}Code](https://${lower}code.de)` }])).toEqual([]);
    expect(oldNameHits([{ path: 'a.md', text: `@${lower}code.de/core` }])).toHaveLength(1);
    expect(oldNameHits([{ path: 'a.md', text: `${lower}code.de-legacy` }])).toHaveLength(1);
    // The company name does not cover another mention on its line.
    expect(oldNameHits([{ path: 'LICENSE', text: `${old}Code and ${old}Core` }])).toHaveLength(1);
  });
});

describe('check:source — the internal subpath of a package is for the framework alone', () => {
  const internal = INTERNAL; // spelled in parts by the script: this file holds no import of one either

  it('finds an import outside packages/<name>/src/ — an app, a stub, a script, a third-party style package', () => {
    expect(
      internalImportHits([
        { path: 'apps/web-app/modules/x/routes.ts', text: `import { FRAMEWORK_ROUTES } from '@marmeon/router${internal}';\n` },
        { path: 'packages/auth/stubs/react/x.ts', text: `const m = await import("@marmeon/http${internal}");` },
        { path: 'scripts/x.ts', text: `export { y } from '@marmeon/router${internal}';` },
      ]),
    ).toEqual([
      `apps/web-app/modules/x/routes.ts:1: import { FRAMEWORK_ROUTES } from '@marmeon/router${internal}';`,
      `packages/auth/stubs/react/x.ts:1: const m = await import("@marmeon/http${internal}");`,
      `scripts/x.ts:1: export { y } from '@marmeon/router${internal}';`,
    ]);
  });

  it('lets the framework’s own sources, its docs and ordinary imports through', () => {
    expect(
      internalImportHits([
        { path: 'packages/live/src/index.ts', text: `import { FRAMEWORK_ROUTES } from '@marmeon/http${internal}';` },
        { path: 'docs/package-development.md', text: `@marmeon/router${internal} is not API` },
        { path: 'apps/web-app/modules/x/routes.ts', text: `import { defineRoutes } from '@marmeon/http';` },
      ]),
    ).toEqual([]);
  });
});

describe('check:source — no app, stub or template installs the validation engine', () => {
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
      { path: 'apps/website/modules/docs/notes.ts', text: `// ${engine} stays inside @marmeon/validation` },
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
      { path: 'apps/website/package.json', text: manifest({ '@marmeon/validation': 'workspace:*' }) },
    ])).toEqual([
      `apps/blank-app/package.json: dependencies lists ${engine} — an app validates with @marmeon/validation`,
      `packages/create-marmeon/template/base/_package.json: dependencies lists ${engine} — an app validates with @marmeon/validation`,
    ]);
  });
});

describe('check:source — NODE_ENV is checked positively', () => {
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

  it('covers the examples too — what a demo adds to a new app, but not its tests', () => {
    expect(negativeEnvHits([
      { path: 'examples/x.ts', text: "if (process.env.NODE_ENV !== 'production') x();" },
      { path: 'examples/notes/files/modules/notes/routes.ts', text: "if (process.env.NODE_ENV === 'production') x();" },
      { path: 'examples/notes/files/modules/notes/notes.test.ts', text: "if (process.env.NODE_ENV !== 'production') x();" },
    ])).toEqual([
      "examples/x.ts:1: if (process.env.NODE_ENV !== 'production') x();",
      "examples/notes/files/modules/notes/routes.ts:1: if (process.env.NODE_ENV === 'production') x();",
    ]);
  });

  it('covers the apps and the starter\'s template too — what people copy — and Vite\'s DEV / !PROD (true in a build without NODE_ENV=production)', () => {
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

describe('check:source — the old token prefix is gone', () => {
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
  const marker = rule('the pending marker');
  const frameworks = rule('a comparison with another framework');

  it('finds the pending marker as a line of its own in a docs page — not mentioned inline, not in CONTRIBUTING', () => {
    expect(textRuleHits([
      { path: 'docs/routing.md', text: '# Routing\n<!-- docs:pending -->\n\nText.' },
      { path: 'docs/middleware.md', text: '# Middleware\n  <!-- docs:pending -->  ' },
      { path: 'docs/csrf.md', text: 'A page carries `<!-- docs:pending -->` until it is written.' },
      { path: 'CONTRIBUTING.md', text: '<!-- docs:pending -->' },
    ], marker)).toEqual(['docs/routing.md:2: <!-- docs:pending -->', 'docs/middleware.md:2: <!-- docs:pending -->']);
  });

  it("reads the apps' READMEs and .env files — what a reader of an app sees first and copies — not the apps' code", () => {
    expect(textRuleHits([
      { path: 'apps/website/.env.test', text: '# like Laravel' },
      { path: 'apps/blank-app/README.md', text: 'as in Rails' },
      { path: 'apps/web-app/modules/auth/routes.ts', text: '// like Laravel' },
      { path: 'apps/web-app/sub/README.md', text: 'like Laravel' },
    ], frameworks)).toEqual(['apps/website/.env.test:1: # like Laravel', 'apps/blank-app/README.md:1: as in Rails']);
    expect(textRuleWhere('apps/web-app/.env.example')).toBe("in an app's README or .env files");
  });

  it('finds a comparison with another framework in the docs, the package cards, the root texts and what a new app copies', () => {
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

  it('reads the examples — their code and their README — for comparisons with other frameworks', () => {
    expect(textRuleHits([
      { path: 'examples/notes/README.md', text: 'Like Laravel, but typed.' },
      { path: 'examples/notes/files/modules/notes/lang/en.ts', text: "// as in Rails" },
      { path: 'examples/notes/files/modules/notes/NoteRepository.ts', text: '// a plain repository' },
    ], frameworks)).toEqual(['examples/notes/README.md:1: Like Laravel, but typed.', 'examples/notes/files/modules/notes/lang/en.ts:1: // as in Rails']);
    expect(textRuleWhere('examples/notes/README.md:1: x')).toBe('in the examples');
  });

  it("reads the website's own pages, not the docs module's code", () => {
    expect(textRuleHits([
      { path: 'apps/website/modules/docs/views/Page.tsx', text: '// like Laravel' },
      { path: 'apps/website/modules/site/views/Landing.tsx', text: '<p>Like Laravel, but typed.</p>' },
      { path: 'apps/website/modules/site/snippets.ts', text: "const a = 'Rails'" },
      { path: 'apps/website/modules/site/styles.css', text: '/* Rails */' },
    ], frameworks)).toEqual([
      'apps/website/modules/site/views/Landing.tsx:1: <p>Like Laravel, but typed.</p>',
      "apps/website/modules/site/snippets.ts:1: const a = 'Rails'",
    ]);
    expect(textRuleWhere('apps/website/modules/site/views/Landing.tsx:1: x')).toBe('on the website');
    expect(textRuleWhere('apps/website/modules/docs/views/Page.tsx:1: x')).toBe('in the docs');
  });

  it('names each rule in the problems of check:source — and where it was found', () => {
    expect(DOC_TEXT_RULES.map((entry) => entry.what)).toEqual(['the pending marker', 'a comparison with another framework']);
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
    const text = ref([
      "throw new Error('An app in the build phase is never booted (E·187).');",
      'const hint = `read-only (W·6.9) — ${what}`;',
      "const a = 'Laravel\\'s rules, typed';",
      'const view = <p>Development only (E·115)</p>;',
      'const b = "fine (W·10.4)";',
    ].join('\n'));
    expect(runtimeStringHits([{ path: 'packages/core/src/application.tsx', text }])).toEqual([
      ref("packages/core/src/application.tsx:1: a decision number: 'An app in the build phase is never booted (E·187).'"),
      ref('packages/core/src/application.tsx:2: a wave reference: `read-only (W·6.9) — ${'),
      "packages/core/src/application.tsx:3: a comparison with another framework: 'Laravel\\'s rules, typed'",
      ref('packages/core/src/application.tsx:4: a decision number: Development only (E·115)'),
      ref('packages/core/src/application.tsx:5: a wave reference: "fine (W·10.4)"'),
    ]);
  });

  it('reads the launchers too — packages/<name>/bin/*.js print to every developer', () => {
    const text = ref(["// E·108: one process (W·8 step 4)", "console.error('marmeon needs Node 26 (E·108).');", 'const w = `since Wa·ve 10`;'].join('\n'));
    expect(runtimeStringHits([
      { path: 'packages/cli/bin/marmeon.js', text },
      { path: 'packages/create-marmeon/bin/create-marmeon.js', text: "process.stderr.write('Laravel-like starter\\n');" },
      { path: 'packages/cli/bin/sub/helper.js', text: ref("const e = '(E·62)';") },
      { path: 'packages/cli/scripts/build.js', text: ref("const e = '(E·62)';") },
    ])).toEqual([
      ref("packages/cli/bin/marmeon.js:2: a decision number: 'marmeon needs Node 26 (E·108).'"),
      ref('packages/cli/bin/marmeon.js:3: a wave reference: since Wa·ve 10'),
      "packages/create-marmeon/bin/create-marmeon.js:1: a comparison with another framework: 'Laravel-like starter\\n'",
    ]);
  });

  it('leaves comments, regular expressions, names and the code of tests, fixtures, scripts and apps alone', () => {
    const code = ref([
      '// E·187: the build phase (W·10 step 9) — Laravel did it so',
      '/** (E·108) */ const E·108 = /\\bE\\d{2,3}\\b/;',
      "const fine = 'E2E, E.164, #E1234, 0xE12 and W3C';",
    ].join('\n'));
    expect(runtimeStringHits([
      { path: 'packages/core/src/a.ts', text: code },
      { path: 'packages/core/src/a.test.ts', text: ref("it('builds (E·187)', () => {});") },
      { path: 'packages/core/src/__fixtures__/b.ts', text: ref("export const b = 'E·187';") },
      { path: 'scripts/check-source.ts', text: ref("const w = 'W·8';") },
      { path: 'apps/web-app/modules/lab/a.ts', text: ref("const e = '(E·62)';") },
    ])).toEqual([]);
  });
});

describe('rule 7: no references to the private record', () => {
  const what = (text: string, path = 'scripts/ci.ts') => privateRecordHits([{ path, text: ref(text) }]).map((hit) => hit.replace(/^[^:]+:\d+: ([^:]+): .*$/, '$1'));

  it('finds a decision number, a wave or a step, a personal date and a path into the private record — in any file', () => {
    expect(what('// allowed (E·170)')).toEqual(['a decision number']);
    expect(what("it('W·9.5: …', () => {});", 'scripts/bench/boot.ts')).toEqual(['a wave reference']);
    expect(what('# the Docker image, since Wa·ve 10', '.github/workflows/ci.yml')).toEqual(['a wave reference']);
    expect(what('// done in W·12 step 4b', 'vitest.config.ts')).toEqual(['a wave reference']);
    expect(what('// red without the lock (G·12b)', 'scripts/pack-smoke.ts')).toEqual(['a wave reference']);
    expect(what('// red without the lock (T·8b)', 'scripts/pack-smoke.ts')).toEqual(['a wave reference']);
    expect(what('// red without the lock (Gegen·probe G·3)', 'scripts/pack-smoke.ts')).toEqual(['a wave reference']);
    expect(what('// the island (E·7)')).toEqual(['a decision number']);
    expect(what('as E·1 says')).toEqual(['a decision number']);
    for (const wave of ['W·5b', 'W·5b.10', 'W·5c.6', 'Wa·ve 5c', 'Wa·ve 5c step 4', 'W·12 step 4b']) {
      expect(what(`// added in ${wave}`), wave).toEqual(['a wave reference']);
    }
    for (const word of ["it('counter-·check: refuses it')", '// see the Counter-·Checks at the end', '// a Gegen·probe', '// the Gegen·proben of the step']) {
      expect(what(word), word).toEqual(['a wave reference']);
    }
    expect(what('kept for good (Ma·x, 07.·10.)', 'deploy/website/compose.yaml')).toEqual(['a personal date']);
    // A day and a month with their dots count in a test's title too: write the month's name (`29 March`, below).
    expect(what("it('runs once on the day the clocks go forward (29.·03.)', () => {});", 'scripts/bench/stats.test.ts')).toEqual(['a personal date']);
    expect(what('the plan in Marmeon/Naechste-·Schritte.md', 'docs/queues.md')).toEqual(['a path into the private record']);
    expect(what('written to /private/·tmp/claude-501/x', 'README.md')).toEqual(['a path into the private record']);
    expect(what('a template in scratch·pad/w8s8/tabs.mjs', 'CONTRIBUTING.md')).toEqual(['a path into the private record']);
    expect(what('the deployment guide in the Obsi·dian va·ult', 'deploy/website/Caddyfile')).toEqual(['a path into the private record']);
  });

  it('takes no hex value, exponent, phone format, test name, cookie attribute, date of test data, version or CSS for one', () => {
    const text = [
      'W3C, HTTP/2, AW3 and W-9, T3 and TS2345',
      'Set-Cookie: a=b; Max-Age=60',
      'E164, E.164 numbers, E2E tests and E1000',
      'https://example.test/?q=%E2%82%AC and %E0%A4%A',
      '`0xE12`, `#E1234`, 1E10 and 2e10, BE12, E12a, the E-mail',
      "const day = '10.10.2026';",
      "it('runs once on the day the clocks go forward (29 March)', () => {});",
      'Math.max(a, b); max-width: 40rem; max 255; Marmeon 0.2.0; 127.0.0.1 or 10.0.0.0/8',
    ].join('\n');
    expect(privateRecordHits([{ path: 'scripts/check-source.ts', text }])).toEqual([]);
  });

  it('reads no integrity hash of the lockfile — base64 holds a decision number or a wave by chance', () => {
    const text = ref('    resolution: {integrity: sha512-dLJDGaLZ1D4H+E·8/d1g+W·5b/x3TU==}');
    expect(privateRecordHits([{ path: 'pnpm-lock.yaml', text }])).toEqual([]);
    expect(privateRecordHits([{ path: 'scripts/lock.yaml', text }]).map((hit) => hit.split(': ')[1])).toEqual(['a decision number', 'a wave reference']);
  });

  it('names each rule in the problems of check:source', () => {
    expect(PRIVATE_RECORD_RULES.map((rule) => rule.what)).toEqual(['a decision number', 'a wave reference', 'a personal date', 'a path into the private record']);
  });

  it('finds the why of a hit by its rule', () => {
    for (const rule of PRIVATE_RECORD_RULES) expect(privateRecordWhy(`a.ts:1: ${rule.what}: text`)).toBe(rule.why);
    expect(privateRecordWhy('a.ts:1: something else: text')).toBeUndefined();
  });
});

describe('check:source — a problem names its rule and why', () => {
  /** A repository of its own (`git init`) holding `files`, read by `checkSource` as the real one is. */
  const problemsOf = (files: Record<string, string>) => {
    const dir = tempDir('marmeon-ci-test-');
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), ref(text));
    }
    return checkSource(dir);
  };

  it('names the rule and its why for rules 3, 4, 6 and 8, and the rule for rules 1 and 2', () => {
    const problems = problemsOf({
      'notes/name.txt': OLD_NAME,
      'apps/x/engine.ts': `import * as v from '${ENGINE}';`,
      'apps/x/env.ts': "if (process.env.NODE_ENV !== 'production') run();",
      'notes/token.txt': `${OLD_TOKEN_PREFIX}1`,
      'packages/x/src/message.ts': "export const message = 'works like Laravel';",
      'packages/x/src/mutant.ts': '// Stryker disable next-line StringLiteral',
    });
    const label = (start: string, path: string) => expect(problems, start).toContainEqual(expect.stringMatching(new RegExp(`^${start}.*${path}:1:`)));
    label('the old name: ', 'notes/name.txt');
    label(`no ${ENGINE} in apps, stubs and templates: `, 'apps/x/engine.ts');
    label('NODE_ENV checked positively \\(only development and test are development; a missing NODE_ENV is production\\): ', 'apps/x/env.ts');
    label('the old token prefix \\(API tokens start with marmeon_\\): ', 'notes/token.txt');
    label("the framework's messages speak to app developers \\(say what holds, not its decision or wave\\): ", 'packages/x/src/message.ts');
    label('mutation testing \\(a disabled mutant hides the test gap it would show; CONTRIBUTING.md › Rules over the source\\): ', 'packages/x/src/mutant.ts');
  });

  it('names the what and the why of each docs rule', () => {
    const samples: Record<string, [string, string]> = {
      'the pending marker': ['docs/draft.md', '<!-- docs:pending -->'],
      'a comparison with another framework': ['docs/compare.md', 'Like Laravel, but typed.'],
    };
    expect(Object.keys(samples)).toEqual(DOC_TEXT_RULES.map((rule) => rule.what));
    const problems = problemsOf(Object.fromEntries(Object.values(samples)));
    for (const rule of DOC_TEXT_RULES) {
      const [path, text] = samples[rule.what]!;
      expect(problems).toContainEqual(`${rule.what} in the docs (${rule.why}): ${path}:1: ${text}`);
    }
  });

  it('names the what and the why of each rule on the private record', () => {
    const samples: Record<string, string> = {
      'a decision number': '// kept (E·12)',
      'a wave reference': '// added in Wa·ve 3',
      'a personal date': '// agreed on 07.·10.',
      'a path into the private record': '// see scratch·pad/x',
    };
    expect(Object.keys(samples)).toEqual(PRIVATE_RECORD_RULES.map((rule) => rule.what));
    const problems = problemsOf(Object.fromEntries(Object.values(samples).map((text, index) => [`notes/${index}.txt`, text])));
    PRIVATE_RECORD_RULES.forEach((rule, index) => {
      expect(problems).toContainEqual(expect.stringContaining(`no references to the private record (${rule.why}): notes/${index}.txt:1: ${rule.what}: `));
    });
  });
});

describe('rule 8: no mutant is disabled without a reason', () => {
  const tool = 'Stryker';
  const comment = (action: string, rest: string) => `// ${tool} ${action} ${rest}`;
  const hits = (...lines: string[]) => mutationCommentHits([{ path: 'packages/database/src/x.ts', text: lines.join('\n') }]);

  it('accepts a next-line disable with a reason and a range that is restored', () => {
    expect(hits(comment('disable next-line', 'EqualityOperator: the loop ends at the same index either way'))).toEqual([]);
    expect(hits(comment('disable', 'StringLiteral: only the text of a log line changes'), 'log();', comment('restore', 'StringLiteral'))).toEqual([]);
    expect(hits(comment('disable', 'StringLiteral,ArrayDeclaration: only labels change here'), comment('restore', 'StringLiteral, ArrayDeclaration'))).toEqual([]);
    expect(hits(comment('disable', 'StringLiteral: only the text of a log line changes'), comment('restore', 'all'))).toEqual([]);
    expect(hits(`/* ${tool} disable next-line ObjectLiteral: an empty object and the default are the same */`)).toEqual([]);
  });

  it('names a disable without a reason or with too short a reason', () => {
    expect(hits(comment('disable next-line', 'StringLiteral'))).toEqual([expect.stringContaining('x.ts:1: a disabled mutant needs a reason')]);
    expect(hits(comment('disable next-line', 'StringLiteral: because'))).toHaveLength(1);
    expect(hits(comment('disable next-line', 'StringLiteral: not needed'))).toHaveLength(1);
    expect(hits(comment('disable next-line', 'StringLiteral:   '))).toHaveLength(1);
    expect(hits(`/* ${tool} disable next-line ObjectLiteral */`)).toHaveLength(1);
  });

  it('names a disabled range that is never restored, or restored for other mutators only', () => {
    expect(hits('a();', comment('disable', 'StringLiteral: only the text of a log line changes'), 'b();')).toEqual([
      expect.stringContaining('x.ts:2: the range disabled for StringLiteral is never restored'),
    ]);
    expect(hits(comment('disable', 'StringLiteral: only the text of a log line changes'), comment('restore', 'ArrayDeclaration'))).toHaveLength(1);
    expect(hits(comment('restore', 'StringLiteral'), comment('disable', 'StringLiteral: only the text of a log line changes'))).toHaveLength(1);
  });

  it('refuses a range over all mutators; a next-line disable of all needs its reason only', () => {
    expect(hits(comment('disable', 'all: nothing in here is worth a mutant'), comment('restore', 'all'))).toEqual([expect.stringContaining('must name its mutators')]);
    expect(hits(comment('disable next-line', 'all: nothing in this line is worth a mutant'))).toEqual([]);
  });

  it('reads a directive as the mutation tester does: mutators up to the first other character, the reason right behind a colon', () => {
    expect(hits(comment('disable', 'all - see: one two three'), comment('restore', 'all'))).toEqual([expect.stringContaining('needs a reason'), expect.stringContaining('must name its mutators')]);
    expect(hits(comment('disable next-line', 'all; x: a b c'))).toEqual([expect.stringContaining('needs a reason')]);
  });

  it('reads comments, not lines: a block over several lines, a second directive on one line, JSX; a string is no comment', () => {
    expect(hits(`/*\n${tool} disable all: nothing to see here */`, comment('restore', 'all'))).toEqual([expect.stringContaining('x.ts:1: a disabled range must name')]);
    expect(hits(`/* note */ ${comment('disable next-line', 'StringLiteral')}`)).toEqual([expect.stringContaining('needs a reason')]);
    expect(mutationCommentHits([{ path: 'packages/react/src/x.tsx', text: `const a = <p>{/* ${tool} disable next-line StringLiteral */}</p>;` }])).toHaveLength(1);
    expect(hits(`const a = '${comment('disable', 'StringLiteral')}';`, `const b = \`${comment('disable', 'all')}\`;`)).toEqual([]);
  });

  it('closes a range name by name: a restore split across two comments counts, one name left open does not', () => {
    const disable = comment('disable', 'StringLiteral, ArrayDeclaration: only labels change here');
    expect(hits(disable, comment('restore', 'StringLiteral'), comment('restore', 'ArrayDeclaration'))).toEqual([]);
    expect(hits(disable, comment('restore', 'StringLiteral'))).toEqual([expect.stringContaining('disabled for ArrayDeclaration is never restored')]);
  });

  it('reads code files only, and holds for the repository', () => {
    expect(mutationCommentHits([{ path: 'CONTRIBUTING.md', text: comment('disable', 'x') }])).toEqual([]);
    expect(checkSource(root).filter((problem) => problem.startsWith('mutation testing'))).toEqual([]);
  });
});

describe('pack:check — no references to the private record in the tarballs', () => {
  it('reads every text file of an unpacked tarball and names the package and the path of a hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-ci-test-'));
    try {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist/index.js'), ref('export const a = 1;\n// the fair claim (E·199)\n'));
      writeFileSync(join(dir, 'dist/index.d.ts'), '/** The queue. */\nexport declare const a = 1;\n');
      writeFileSync(join(dir, 'icon.png'), Buffer.from(ref('\0PNG E·199'), 'latin1'));
      const packed = { name: '@marmeon/queue', files: ['dist/index.js', 'dist/index.d.ts', 'icon.png'] };
      expect(privateRecordInTarball(packed, dir)).toEqual([ref('@marmeon/queue/dist/index.js:2: a decision number: // the fair claim (E·199)')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pack:check — the rules over an unpacked tarball', () => {
  const manifest = { name: '@marmeon/sample', version: '0.1.0', license: 'MIT' };

  /** Unpacks a tarball of `files` into a temporary directory and returns what `checkTarball` says about it. */
  const problemsOf = (files: Record<string, string>) => {
    const dir = tempDir('marmeon-ci-test-');
    for (const [path, text] of Object.entries({ 'package.json': JSON.stringify(manifest), ...files })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const packed = { name: manifest.name, version: manifest.version, tarball: join(dir, 'sample.tgz'), files: Object.keys({ 'package.json': '', ...files }) };
    const pkg = { name: manifest.name, short: 'sample', dir: join(dir, 'no-such-package'), manifest };
    return checkTarball(packed, dir, pkg, 'The license.\n');
  };

  it('names a missing LICENSE and a test file', () => {
    const problems = problemsOf({ 'README.md': '# Sample\n', 'dist/index.js': '', 'src/index.ts': '', 'dist/index.test.js': '', 'src/index.test.ts': '' });
    expect(problems).toContain('LICENSE is missing — pnpm license:sync');
    expect(problems).toContain('dist/index.test.js is a test — exclude it in "files"');
  });

  it('names a LICENSE that is not the root one, and a missing README', () => {
    const problems = problemsOf({ LICENSE: 'Another license.\n' });
    expect(problems).toContain('LICENSE is not the root LICENSE — pnpm license:sync');
    expect(problems).toContain('README.md is missing');
  });

  it('names a missing CHANGELOG', () => {
    expect(problemsOf({ LICENSE: 'The license.\n', 'README.md': '# Sample\n' })).toContain('CHANGELOG.md is missing — add it to "files"');
    expect(problemsOf({ 'CHANGELOG.md': '# Sample\n' })).not.toContain('CHANGELOG.md is missing — add it to "files"');
  });

  it('finds nothing to name when LICENSE and README are there and no test ships', () => {
    const problems = problemsOf({ LICENSE: 'The license.\n', 'README.md': '# Sample\n', 'CHANGELOG.md': '# Sample\n' });
    expect(problems.filter((problem) => /LICENSE|README|CHANGELOG|is a test/.test(problem))).toEqual([]);
  });
});

describe('the driver rule', () => {
  it('holds for every package: one wrapped driver a dependency, one of several an optional peer, a shared library a peer', () => {
    const problems = frameworkPackages(root).flatMap((pkg) => checkDriverRule(pkg.short, pkg.manifest).map((problem) => `${pkg.name}: ${problem}`));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('names what breaks it', () => {
    expect(checkDriverRule('redis', { peerDependencies: { redis: '^6.0.0' }, peerDependenciesMeta: { redis: { optional: true } } })).toEqual([
      'redis must be a dependency (the one driver this package wraps — the app installs nothing else)',
    ]);
    expect(checkDriverRule('auth', { dependencies: {} })).toEqual(['@simplewebauthn/server must be a dependency (the one driver this package wraps — the app installs nothing else)']);
    expect(checkDriverRule('auth', { dependencies: { '@simplewebauthn/server': '^14.0.3' } })).toEqual([]);
    expect(checkDriverRule('redis', { dependencies: { redis: '6.2.1' } })).toEqual(['dependencies.redis is "6.2.1" — a caret range of the tested major (^6.2.1)']);
    expect(checkDriverRule('database', { dependencies: { pg: '^8.23.0' } })).toEqual([
      'pg must stay an optional peer, not a dependency — one of several drivers; every app would install it',
      'pg must be an optional peer of this package',
    ]);
    expect(checkDriverRule('database', { peerDependencies: { pg: '^8.23.0' } })).toEqual(['pg must be an optional peer (peerDependenciesMeta) — the app installs it only for that driver']);
    // One API instance: the app's SDK registers on the API the framework reads — a second copy would be a second instance.
    expect(checkDriverRule('otel', { dependencies: { '@opentelemetry/api': '^1.9.0' }, peerDependencies: { '@opentelemetry/api': '^1.9.0' } })).toEqual([
      '@opentelemetry/api must stay a peer, not a dependency — the app and the framework share one instance; a dependency installs a second copy',
      '@opentelemetry/api is a dependency — the app and the framework must share one instance of it: a peer',
    ]);
    expect(checkDriverRule('table', { dependencies: { react: '^19.3.0' } })).toEqual(['react is a dependency — the app and the framework must share one instance of it: a peer']);
  });
});
