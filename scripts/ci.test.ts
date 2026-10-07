import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSource, oldNameHits, OLD_NAME } from './check-source.ts';
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
