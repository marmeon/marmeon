import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes.ts';
import { tempDir } from './test/temp-dir.js';

/** A repository whose packages have these changelogs (`undefined`: no CHANGELOG.md). */
function repositoryWith(changelogs: Record<string, string | undefined>): string {
  const dir = tempDir('marmeon-release-notes-');
  for (const [short, changelog] of Object.entries(changelogs)) {
    mkdirSync(join(dir, 'packages', short), { recursive: true });
    writeFileSync(join(dir, 'packages', short, 'package.json'), JSON.stringify({ name: `@marmeon/${short}`, version: '0.2.0' }));
    if (changelog !== undefined) writeFileSync(join(dir, 'packages', short, 'CHANGELOG.md'), changelog);
  }
  return dir;
}

const body = `### Breaking changes

- Rename the thing by @max in https://github.com/marmeon/marmeon/pull/7

### Features

- Add a thing by @ana in https://github.com/marmeon/marmeon/pull/5

### Fixes

- Fix the other thing by @max in https://github.com/marmeon/marmeon/pull/6

### New contributors

- @ana made their first contribution in https://github.com/marmeon/marmeon/pull/5

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.2...v0.2.0
`;

const changelog = (section: string, name = 'core') => `# @marmeon/${name}\n\n## 0.2.0\n\n${section}\n## 0.1.0\n\n### Minor Changes\n\n- The first release.\n`;

describe('releaseNotes', () => {
  it('prints the shared section once, verbatim', () => {
    const dir = repositoryWith({ core: changelog(body), http: changelog(body, 'http') });
    expect(releaseNotes(dir, '0.2.0')).toBe(`${body.trim()}\n`);
  });

  it('names a package without the section', () => {
    const dir = repositoryWith({ core: changelog(body), http: '# @marmeon/http\n\n## 0.1.0\n\n- Old.\n', auth: undefined });
    expect(() => releaseNotes(dir, '0.2.0')).toThrow(/No "## 0\.2\.0" section.*@marmeon\/http.*@marmeon\/auth|No "## 0\.2\.0" section.*@marmeon\/auth.*@marmeon\/http/);
  });

  it('names a package whose section differs', () => {
    const dir = repositoryWith({ core: changelog(body), http: changelog(`${body}\n- Extra.\n`, 'http') });
    expect(() => releaseNotes(dir, '0.2.0')).toThrow(/section of @marmeon\/http differs from @marmeon\/core/);
  });

  it('refuses an empty section', () => {
    const dir = repositoryWith({ core: changelog(''), http: changelog('', 'http') });
    expect(() => releaseNotes(dir, '0.2.0')).toThrow('the "## 0.2.0" section holds no changes');
  });
});
