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

const core = `# @marmeon/core

## 0.2.0

### Minor Changes

- aaa1111: A new thing,
  over two lines.

### Patch Changes

- bbb2222: A fix.

## 0.1.0

### Minor Changes

- The first release.
`;

const http = `# @marmeon/http

## 0.2.0

### Minor Changes

- aaa1111: A new thing,
  over two lines.

### Patch Changes

- bbb2222: A fix.
- ccc3333: Only in http.
- Updated dependencies [aaa1111]
  - @marmeon/core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @marmeon/core@0.1.0
`;

describe('releaseNotes', () => {
  it('merges the packages, lists a shared entry once and drops the dependency bullets', () => {
    expect(releaseNotes(repositoryWith({ core, http }), '0.2.0')).toBe(
      [
        '### Minor Changes\n\n- aaa1111: A new thing,\n  over two lines.',
        '### Patch Changes\n\n- bbb2222: A fix.\n- ccc3333: Only in http.',
      ].join('\n\n') + '\n',
    );
  });

  it('keeps a multi-paragraph entry with a code block whole', () => {
    const entry = '- ddd4444: First paragraph.\n\n  Second paragraph:\n\n  ```ts\n  const a = 1;\n\n  const b = 2;\n  ```\n\n  Last paragraph.';
    const changelog = `# @marmeon/core\n\n## 0.2.0\n\n### Minor Changes\n\n${entry}\n- eee5555: Next.\n\n### Patch Changes\n\n- fff6666: Fix.\n`;
    expect(releaseNotes(repositoryWith({ core: changelog }), '0.2.0')).toBe(`### Minor Changes\n\n${entry}\n- eee5555: Next.\n\n### Patch Changes\n\n- fff6666: Fix.\n`);
  });

  it('reads only the section of the version', () => {
    expect(releaseNotes(repositoryWith({ core }), '0.1.0')).toBe('### Minor Changes\n\n- The first release.\n');
  });

  it('refuses a version a package has no section for', () => {
    expect(() => releaseNotes(repositoryWith({ core, http }), '0.3.0')).toThrow('no "## 0.3.0" section in the CHANGELOG.md of @marmeon/core, @marmeon/http');
    expect(() => releaseNotes(repositoryWith({ core, http: undefined }), '0.2.0')).toThrow('of @marmeon/http');
  });

  it('refuses a section that holds only dependency updates', () => {
    expect(() => releaseNotes(repositoryWith({ http }), '0.1.0')).toThrow('hold no changes');
  });
});
