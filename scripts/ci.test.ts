import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSource, ENGINE, engineHits, oldNameHits, OLD_NAME } from './check-source.ts';
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

  it('allows the company name everywhere and the rename hint only in README.md and UPGRADING.md', () => {
    const hint = `Marmeon was called ${old}Core up to 0.1.0 (never published).`;
    expect(oldNameHits([
      { path: 'packages/core/LICENSE', text: `MIT License\n\nCopyright (c) 2026 ${old}Code\n` },
      { path: 'README.md', text: hint },
      { path: 'UPGRADING.md', text: `**${hint}**` },
    ])).toEqual([]);
    expect(oldNameHits([{ path: 'docs/versioning.md', text: hint }])).toEqual([`docs/versioning.md:1: ${hint}`]);
    // An allowed phrase does not cover another mention on its line.
    expect(oldNameHits([{ path: 'README.md', text: `${hint} Run ${lower} dev.` }])).toHaveLength(1);
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
