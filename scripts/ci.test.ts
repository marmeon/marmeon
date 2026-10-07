import { describe, expect, it } from 'vitest';
import { checkSource, oldNameHits, OLD_NAME } from './check-source.ts';
import { parts } from './ci.ts';

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
