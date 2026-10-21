import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import docsConfig from '../apps/website/docs.config.ts';
import { repositoryFiles } from './check-source.ts';
import { docsIndex } from './docs-ship.ts';
import { tempDir } from './test/temp-dir.js';
import { addLine, gitIn, lineOf, LINES_DIR, PINS_FILE, readDocsConfig, readPins, verifyLines, type Git } from './website-lines.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));

const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const CONFIG = `export default defineDocs({
  sections: [
    { title: 'Basics', pages: [{ slug: 'routing', label: 'Routing' }, { slug: 'mail', label: 'Mail' }] },
    { title: 'Prologue', pages: [{ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true }] },
  ],
});
`;

type Entry = string | { link: string } | { text: string; executable: true } | null;
interface Fixture {
  /** The checkout the tool runs in. */
  readonly work: string;
  /** The bare repository behind `origin`. */
  readonly remote: string;
}

/** Writes `version` into both manifests and `extra` over the files, commits on the current branch; `null` removes a file. */
function commit(f: Fixture, version: string, extra: Record<string, Entry> = {}): string {
  const files: Record<string, Entry> = {
    'docs/routing.md': '# Routing\r\n\nSee [upgrading](../UPGRADING.md).\n```md\n# not a title\n```\n',
    'docs/mail.md': '# Mail\n',
    'UPGRADING.md': '# Upgrade Guide\n',
    'SECURITY.md': '# Security\n',
    'CONTRIBUTING.md': '# Contributing\n',
    'apps/website/docs.config.ts': CONFIG,
    'packages/core/package.json': `${JSON.stringify({ name: '@marmeon/core', version })}\n`,
    'packages/cli/package.json': `${JSON.stringify({ name: 'marmeon', version })}\n`,
    ...extra,
  };
  for (const [path, entry] of Object.entries(files)) {
    const file = join(f.work, path);
    rmSync(file, { force: true });
    if (entry === null) continue;
    mkdirSync(dirname(file), { recursive: true });
    if (typeof entry === 'string') writeFileSync(file, entry);
    else if ('link' in entry) symlinkSync(entry.link, file);
    else {
      writeFileSync(file, entry.text);
      chmodSync(file, 0o755);
    }
  }
  git(f.work, 'add', '-A');
  git(f.work, 'commit', '-m', `Release ${version}`);
  return git(f.work, 'rev-parse', 'HEAD');
}

/** A checkout with `origin` and main pushed, nothing committed yet. */
function fixture(): Fixture {
  const base = tempDir('marmeon-website-lines-');
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(work);
  git(base, 'init', '--bare', '-b', 'main', remote);
  git(work, 'init', '-b', 'main');
  git(work, 'remote', 'add', 'origin', remote);
  return { work, remote };
}

/** A release on main: the commit, an annotated tag, both pushed. */
function release(f: Fixture, version: string, extra: Record<string, Entry> = {}): string {
  const sha = commit(f, version, extra);
  git(f.work, 'tag', '-a', `v${version}`, '-m', `v${version}`);
  git(f.work, 'push', 'origin', 'main', `v${version}`);
  return sha;
}

const read = (f: Fixture, path: string) => readFileSync(join(f.work, path));
const lines = (f: Fixture) => verifyLines({ root: f.work });
const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort();

/** Asserts that `add` refuses and leaves neither a pin nor a snapshot behind. */
function refuses(f: Fixture, tag: string, message: RegExp): void {
  expect(() => addLine(tag, { root: f.work })).toThrow(message);
  expect(existsSync(join(f.work, PINS_FILE))).toBe(false);
  expect(existsSync(join(f.work, LINES_DIR))).toBe(false);
}

describe('lineOf', () => {
  it('names the line of a release and none for anything else', () => {
    expect(lineOf('0.3.0')).toBe('0.3.x');
    expect(lineOf('0.10.7')).toBe('0.10.x');
    expect(lineOf('1.0.0')).toBe('1.x');
    expect(lineOf('12.4.1')).toBe('12.x');
    for (const version of ['1.0.0-rc.1', '0.3', '00.3.0', '01.0.0', 'v0.3.0', '', '0.3.0 ', '0.3.x']) expect(lineOf(version), version).toBeUndefined();
  });
});

describe('readDocsConfig', () => {
  it('reads the navigation of this repository as the module defines it', () => {
    expect(readDocsConfig(readFileSync(join(repository, 'apps/website/docs.config.ts'), 'utf8'))).toEqual(docsConfig);
  });

  const tagged = (() => {
    try {
      return execFileSync('git', ['show', 'v0.3.0:apps/website/docs.config.ts'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined; // a checkout without the tags
    }
  })();
  it.skipIf(tagged === undefined)('reads the navigation as the first release line has it', () => {
    const config = readDocsConfig(tagged as string);
    expect(config.sections.length).toBeGreaterThan(5);
    expect(config.sections.flatMap((section) => section.pages).some((page) => page.file === 'UPGRADING.md' && page.changes === true)).toBe(true);
  });

  const wrap = (argument: string) => `import { defineDocs } from './docs.config.ts';\nexport default defineDocs(${argument});\n`;
  it.each([
    ['a spread', wrap('{ ...base }'), /:2: SpreadElement/],
    ['a call', wrap('make()'), /:2: CallExpression/],
    ['an identifier', wrap('base'), /:2: Identifier/],
    ['a template with an expression', wrap('{ sections: [{ title: `${x}`, pages: [] }] }'), /:2: TemplateLiteral has an expression/],
    ['a number', wrap('{ sections: 1 }'), /:2: Literal is a literal that is neither/],
    ['a computed key', wrap("{ ['sections']: [] }"), /:2: Property is not a plain property/],
    ['a getter', wrap('{ get sections() { return []; } }'), /Property/],
    ['a hole in an array', wrap('{ sections: [,] }'), /ArrayExpression has a hole/],
    ['a wrapped call', 'export default make({ sections: [] });\n', /is not defineDocs/],
    ['a cast', wrap('{ sections: [] } as const'), /TSAsExpression/],
    ['two default exports', `${wrap('{ sections: [] }')}export default 1;\n`, /not parse|exactly one/],
    ['no default export', 'export const x = 1;\n', /exactly one export default, found 0/],
    ['a key of its own', wrap("{ sections: [], extra: 'x' }"), /needs \{ sections/],
    ['a page with a key of its own', wrap("{ sections: [{ title: 'A', pages: [{ slug: 'a', label: 'A', run: 'x' }] }] }"), /key other than/],
    ['a slug that is no word', wrap("{ sections: [{ title: 'A', pages: [{ slug: '../a', label: 'A' }] }] }"), /not lower-case words/],
    ['a text that does not parse', 'export default defineDocs({\n', /does not parse/],
  ])('refuses %s', (_name, text, message) => {
    expect(() => readDocsConfig(text)).toThrow(message);
  });

  it('names the line of the node it refuses', () => {
    expect(() => readDocsConfig('\n\n\nexport default defineDocs({\n  sections: [\n    ...rest,\n  ],\n});\n')).toThrow(/docs\.config\.ts:6: SpreadElement/);
  });

  it('accepts a template without an expression and quoted keys', () => {
    expect(readDocsConfig(wrap("{ 'sections': [{ title: `A`, pages: [{ slug: 'a', label: 'A', changes: true }] }] }"))).toEqual({
      sections: [{ title: 'A', pages: [{ slug: 'a', label: 'A', changes: true }] }],
    });
  });
});

describe('readPins', () => {
  const root = (text?: string) => {
    const dir = tempDir('marmeon-website-lines-');
    mkdirSync(join(dir, 'apps/website'), { recursive: true });
    if (text !== undefined) writeFileSync(join(dir, PINS_FILE), text);
    return dir;
  };
  const pin = (line: string, entry: object) => JSON.stringify({ format: 1, lines: { [line]: entry } });
  const good = { version: '0.3.0', tag: 'v0.3.0', commit: 'a'.repeat(40) };

  it('has no lines without the file', () => {
    expect(readPins(root())).toEqual({});
  });

  it('reads a pin', () => {
    expect(readPins(root(pin('0.3.x', good)))).toEqual({ '0.3.x': good });
  });

  it.each([
    ['another format', JSON.stringify({ format: 2, lines: {} }), /format 2 is not 1/],
    ['a key of its own at the top', JSON.stringify({ format: 1, lines: {}, extra: 1 }), /nothing else/],
    ['a line key without its minor', pin('0.3', good), /does not belong to the line 0\.3/],
    ['a tag of another version', pin('0.3.x', { ...good, tag: 'v0.3.1' }), /tag of 0\.3\.x is not v0\.3\.0/],
    ['a key of its own in a pin', pin('0.3.x', { ...good, extra: 1 }), /version, tag and commit and nothing else/],
    ['a short commit', pin('0.3.x', { ...good, commit: 'abc' }), /40 hexadecimal/],
    ['an upper-case commit', pin('0.3.x', { ...good, commit: 'A'.repeat(40) }), /40 hexadecimal/],
    ['a pre-release', pin('1.x', { version: '1.0.0-rc.1', tag: 'v1.0.0-rc.1', commit: 'a'.repeat(40) }), /not <major>/],
    ['text that is no JSON', '{', /not JSON/],
  ])('refuses %s', (_name, text, message) => {
    expect(() => readPins(root(text))).toThrow(message);
  });
});

describe('addLine', { timeout: 30_000 }, () => {
  it('pins the tag and writes the snapshot from the commit', () => {
    const f = fixture();
    const sha = release(f, '0.3.0');
    const logged: string[] = [];
    const result = addLine('v0.3.0', { root: f.work, log: (line) => logged.push(line) });

    expect(result).toMatchObject({ line: '0.3.x', pin: { version: '0.3.0', tag: 'v0.3.0', commit: sha }, files: 6 });
    expect(read(f, PINS_FILE).toString()).toBe(`${JSON.stringify({ format: 1, lines: { '0.3.x': { version: '0.3.0', tag: 'v0.3.0', commit: sha } } }, null, 2)}\n`);
    const dir = `${LINES_DIR}/0.3.x`;
    expect(tree(join(f.work, dir))).toEqual(['CONTRIBUTING.md', 'SECURITY.md', 'UPGRADING.md', 'docs', 'docs/index.json', 'docs/mail.md', 'docs/routing.md']);
    for (const path of ['docs/routing.md', 'docs/mail.md', 'UPGRADING.md', 'SECURITY.md', 'CONTRIBUTING.md']) expect(read(f, `${dir}/${path}`).equals(read(f, path)), path).toBe(true);
    expect(read(f, `${dir}/docs/routing.md`).includes('\r\n')).toBe(true);

    // The index is what the package carries: the same function over the same pages.
    const pages = new Map(['docs/routing.md', 'docs/mail.md', 'UPGRADING.md'].map((path) => [path, read(f, path)]));
    const index = docsIndex(readDocsConfig(CONFIG), pages, '0.3.0');
    expect(read(f, `${dir}/docs/index.json`).toString()).toBe(`${JSON.stringify(index, null, 2)}\n`);
    expect(index.sections[1]?.pages[0]).toEqual({ slug: 'upgrading', label: 'Upgrade Guide', title: 'Upgrade Guide', file: 'UPGRADING.md' });
    expect(logged.join('\n')).toContain('open a pull request with apps/website/docs-lines.json and apps/website/content/lines/0.3.x/');

    expect(lines(f)).toEqual([]);
    expect(readdirSync(join(f.work, LINES_DIR))).toEqual(['0.3.x']); // no staging directory left
  });

  it('pins a later release of the line over the earlier one and keeps the lines in order of version', () => {
    const f = fixture();
    release(f, '0.3.0');
    addLine('v0.3.0', { root: f.work });
    release(f, '0.4.0', { 'docs/new.md': '# New\n' });
    addLine('v0.4.0', { root: f.work });
    const newer = release(f, '0.3.1', { 'docs/new.md': null });
    // 0.3.1 sits on main behind 0.4.0 here; the line is what its version says.
    addLine('v0.3.1', { root: f.work });

    const pins = readPins(f.work);
    expect(Object.keys(pins)).toEqual(['0.3.x', '0.4.x']);
    expect(pins['0.3.x']).toEqual({ version: '0.3.1', tag: 'v0.3.1', commit: newer });
    expect(lines(f)).toEqual([]);
    expect(existsSync(join(f.work, LINES_DIR, '0.4.x/docs/new.md'))).toBe(true);
  });

  it('pins the same release again without a change', () => {
    const f = fixture();
    release(f, '0.3.0');
    addLine('v0.3.0', { root: f.work });
    const before = read(f, PINS_FILE);
    addLine('v0.3.0', { root: f.work });
    expect(read(f, PINS_FILE).equals(before)).toBe(true);
    expect(lines(f)).toEqual([]);
  });

  it('accepts a commit that is on the line branch and not on main', () => {
    const f = fixture();
    release(f, '0.3.0');
    git(f.work, 'checkout', '-b', '0.3.x');
    const sha = commit(f, '0.3.1');
    git(f.work, 'tag', '-a', 'v0.3.1', '-m', 'v0.3.1');
    git(f.work, 'push', 'origin', '0.3.x', 'v0.3.1');
    git(f.work, 'checkout', 'main');
    expect(addLine('v0.3.1', { root: f.work }).pin.commit).toBe(sha);
  });

  describe('refuses', () => {
    it('a lightweight tag', () => {
      const f = fixture();
      commit(f, '0.3.0');
      git(f.work, 'tag', 'v0.3.0');
      git(f.work, 'push', 'origin', 'main', 'v0.3.0');
      refuses(f, 'v0.3.0', /lightweight tag/);
    });

    it('a tag that does not exist', () => {
      const f = fixture();
      release(f, '0.3.0');
      refuses(f, 'v0.3.9', /git cat-file -t refs\/tags\/v0\.3\.9 failed/);
    });

    it('a pre-release and names that are no release tag', () => {
      const f = fixture();
      release(f, '0.3.0');
      git(f.work, 'tag', '-a', 'v1.0.0-rc.1', '-m', 'rc');
      for (const tag of ['v1.0.0-rc.1', '0.3.0', 'v0.3', 'v0.3.0 ', '--help', 'main', 'refs/tags/v0.3.0', 'v0.3.0^{}']) refuses(f, tag, /is not a release tag/);
    });

    it('a local tag that differs from the tag on origin', () => {
      const f = fixture();
      release(f, '0.3.0');
      commit(f, '0.3.0', { 'docs/mail.md': '# Mail, moved\n' });
      git(f.work, 'tag', '-f', '-a', 'v0.3.0', '-m', 'moved');
      refuses(f, 'v0.3.0', /one of them was moved/);
    });

    it('a tag that was moved on origin', () => {
      const f = fixture();
      release(f, '0.3.0');
      const other = commit(f, '0.3.0', { 'docs/mail.md': '# Mail, moved\n' });
      git(f.work, 'push', 'origin', 'main');
      git(f.remote, 'tag', '-f', '-a', 'v0.3.0', other, '-m', 'moved');
      refuses(f, 'v0.3.0', /one of them was moved/);
    });

    it('a nested tag on origin that only ends in the name of the tag', () => {
      const f = fixture();
      commit(f, '0.3.0');
      git(f.work, 'push', 'origin', 'main');
      git(f.work, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
      git(f.work, 'push', 'origin', 'refs/tags/v0.3.0:refs/tags/x/refs/tags/v0.3.0');
      refuses(f, 'v0.3.0', /origin has no annotated tag/);
    });

    it('a tag that origin does not have', () => {
      const f = fixture();
      commit(f, '0.3.0');
      git(f.work, 'push', 'origin', 'main');
      git(f.work, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
      refuses(f, 'v0.3.0', /origin has no annotated tag/);
    });

    it('a commit that is only on a feature branch', () => {
      const f = fixture();
      release(f, '0.3.0');
      git(f.work, 'checkout', '-b', 'feature');
      commit(f, '0.3.1', { 'docs/mail.md': '# Mail, from a branch\n' });
      git(f.work, 'tag', '-a', 'v0.3.1', '-m', 'v0.3.1');
      git(f.work, 'push', 'origin', 'feature', 'v0.3.1');
      git(f.work, 'checkout', 'main');
      refuses(f, 'v0.3.1', /on neither origin\/main nor origin\/0\.3\.x/);
    });

    it('a manifest of another version than the tag', () => {
      const f = fixture();
      commit(f, '0.3.0');
      git(f.work, 'push', 'origin', 'main');
      git(f.work, 'tag', '-a', 'v0.3.1', '-m', 'v0.3.1');
      git(f.work, 'push', 'origin', 'v0.3.1');
      refuses(f, 'v0.3.1', /packages\/core\/package\.json at [0-9a-f]{40} says version "0\.3\.0", expected 0\.3\.1/);
    });

    it('a package of the commit that is released at another version', () => {
      const f = fixture();
      release(f, '0.3.0', { 'packages/cli/package.json': `${JSON.stringify({ name: 'marmeon', version: '0.2.9' })}\n` });
      refuses(f, 'v0.3.0', /packages\/cli\/package\.json .* says version "0\.2\.9"/);
    });

    it('an older version than the pin of the line', () => {
      const f = fixture();
      release(f, '0.3.0');
      release(f, '0.3.1');
      addLine('v0.3.1', { root: f.work });
      const pins = read(f, PINS_FILE);
      expect(() => addLine('v0.3.0', { root: f.work })).toThrow(/pinned to 0\.3\.1, which is newer than 0\.3\.0/);
      expect(read(f, PINS_FILE).equals(pins)).toBe(true);
      expect(lines(f)).toEqual([]);
    });

    it('a version of the pin under another commit', () => {
      const f = fixture();
      release(f, '0.3.0');
      addLine('v0.3.0', { root: f.work });
      const other = commit(f, '0.3.0', { 'docs/mail.md': '# Mail, moved\n' });
      git(f.work, 'push', 'origin', 'main');
      git(f.work, 'tag', '-f', '-a', 'v0.3.0', other, '-m', 'moved');
      git(f.work, 'push', '--force', 'origin', 'v0.3.0');
      expect(() => addLine('v0.3.0', { root: f.work })).toThrow(/a pin changes with a new version only/);
    });

    it('a symlink among the pages', () => {
      const f = fixture();
      release(f, '0.3.0', { 'docs/evil.md': { link: '/etc/passwd' } });
      refuses(f, 'v0.3.0', /docs\/evil\.md is not a regular file \(mode 120000/);
    });

    it('a symlink for a policy', () => {
      const f = fixture();
      release(f, '0.3.0', { 'SECURITY.md': { link: '../outside' } });
      refuses(f, 'v0.3.0', /SECURITY\.md is not a regular file \(mode 120000/);
    });

    it('an executable page', () => {
      const f = fixture();
      release(f, '0.3.0', { 'docs/run.md': { text: '# Run\n', executable: true } });
      refuses(f, 'v0.3.0', /docs\/run\.md is not a regular file \(mode 100755/);
    });

    it('a file in docs/ that is no page', () => {
      const f = fixture();
      release(f, '0.3.0', { 'docs/x.sh': '#!/bin/sh\n' });
      refuses(f, 'v0.3.0', /docs\/x\.sh is in the commit, but docs\/ may hold regular/);
    });

    it.each(['docs/Evil.md', 'docs/sub/page.md', 'docs/under_score.md', 'docs/.hidden.md', 'docs/a b.md', 'docs/page.markdown', 'docs/index.json'])('the path %s', (path) => {
      const f = fixture();
      release(f, '0.3.0', { [path]: '# Page\n' });
      refuses(f, 'v0.3.0', /may hold regular \[a-z0-9-\]\+\.md pages only/);
    });

    it('a submodule in docs/', () => {
      const f = fixture();
      commit(f, '0.3.0');
      const sha = git(f.work, 'rev-parse', 'HEAD');
      git(f.work, 'update-index', '--add', '--cacheinfo', `160000,${sha},docs/module.md`);
      git(f.work, 'commit', '-m', 'A submodule');
      git(f.work, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
      git(f.work, 'push', 'origin', 'main', 'v0.3.0');
      refuses(f, 'v0.3.0', /docs\/module\.md is not a regular file \(mode 160000/);
    });

    it('a navigation that is not literal', () => {
      for (const [config, message] of [
        ['export default defineDocs({ ...base });\n', /SpreadElement/],
        ['export default defineDocs(sections());\n', /CallExpression/],
        ['const x = 1;\nexport default defineDocs({ sections: [{ title: `${x}`, pages: [] }] });\n', /TemplateLiteral has an expression/],
      ] as const) {
        const f = fixture();
        release(f, '0.3.0', { 'apps/website/docs.config.ts': config });
        refuses(f, 'v0.3.0', message);
      }
    });

    it('a navigation that lists a page the commit does not have', () => {
      const f = fixture();
      release(f, '0.3.0', { 'docs/mail.md': null });
      refuses(f, 'v0.3.0', /lists mail, but docs\/mail\.md does not exist/);
    });

    it('a missing policy', () => {
      const f = fixture();
      release(f, '0.3.0', { 'SECURITY.md': null });
      refuses(f, 'v0.3.0', /SECURITY\.md is missing/);
    });
  });

  describe('never runs what the tag holds', () => {
    const effect = (marker: string) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`;

    it('stops at a navigation that would write a file when imported, and writes none', () => {
      const f = fixture();
      const marker = join(tempDir('marmeon-website-lines-'), 'ran.txt');
      release(f, '0.3.0', { 'apps/website/docs.config.ts': `${effect(marker)}export default defineDocs(make());\n` });
      refuses(f, 'v0.3.0', /CallExpression/);
      expect(existsSync(marker)).toBe(false);
    });

    it('reads a literal navigation next to code that would write a file, and writes none', () => {
      const f = fixture();
      const marker = join(tempDir('marmeon-website-lines-'), 'ran.txt');
      release(f, '0.3.0', { 'apps/website/docs.config.ts': `${effect(marker)}${CONFIG}` });
      addLine('v0.3.0', { root: f.work });
      expect(existsSync(marker)).toBe(false);
      expect(lines(f)).toEqual([]);
    });

    it('reads Git objects only: no archive is unpacked', () => {
      const f = fixture();
      release(f, '0.3.0');
      const calls: string[] = [];
      const real = gitIn(f.work);
      const spy: Git = {
        capture: (args) => (calls.push(String(args[0])), real.capture(args)),
        bytes: (args) => (calls.push(String(args[0])), real.bytes(args)),
        succeeds: (args) => (calls.push(String(args[0])), real.succeeds(args)),
      };
      addLine('v0.3.0', { root: f.work, git: spy });
      expect(new Set(calls)).toEqual(new Set(['cat-file', 'rev-parse', 'ls-remote', 'fetch', 'merge-base', 'ls-tree']));
    });

    it('stops when Git fails', () => {
      const f = fixture();
      release(f, '0.3.0');
      const failing: Git = {
        capture: () => {
          throw new Error('git: no');
        },
        bytes: () => Buffer.alloc(0),
        succeeds: () => false,
      };
      expect(() => addLine('v0.3.0', { root: f.work, git: failing })).toThrow('git: no');
      expect(existsSync(join(f.work, PINS_FILE))).toBe(false);
    });
  });
});

describe('verifyLines', { timeout: 30_000 }, () => {
  /** A pinned 0.3.x. */
  function pinned(): Fixture & { dir: string; sha: string } {
    const f = fixture();
    const sha = release(f, '0.3.0');
    addLine('v0.3.0', { root: f.work });
    return { ...f, dir: join(f.work, LINES_DIR, '0.3.x'), sha };
  }
  const problems = (f: Fixture) => lines(f).join('\n');

  it('has nothing to say without lines', () => {
    expect(lines(fixture())).toEqual([]);
  });

  it('holds when snapshot and tag are as pinned', () => {
    const f = pinned();
    const logged: string[] = [];
    expect(verifyLines({ root: f.work, log: (line) => logged.push(line) })).toEqual([]);
    expect(logged).toEqual([`website-lines: 0.3.x (v0.3.0): 6 files equal the commit ${f.sha}`]);
  });

  /** Verifies `clone` (without the pinned commit) with the pins and the snapshot of `f`; returns the arguments of every fetch. */
  function verifyIn(f: ReturnType<typeof pinned>, clone: string): { problems: string[]; fetches: string[][] } {
    mkdirSync(join(clone, 'apps/website'), { recursive: true });
    writeFileSync(join(clone, PINS_FILE), readFileSync(join(f.work, PINS_FILE)));
    mkdirSync(join(clone, LINES_DIR), { recursive: true });
    rmSync(join(clone, LINES_DIR, '0.3.x'), { recursive: true, force: true });
    execFileSync('cp', ['-R', join(f.work, LINES_DIR, '0.3.x'), join(clone, LINES_DIR, '0.3.x')]);
    const fetches: string[][] = [];
    const real = gitIn(clone);
    const spy: Git = { ...real, capture: (args) => (args[0] === 'fetch' && fetches.push([...args]), real.capture(args)) };
    return { problems: verifyLines({ root: clone, git: spy }), fetches };
  }

  it('fetches the commit in full when the checkout is a full one, and keeps it full', () => {
    const f = pinned();
    const clone = join(tempDir('marmeon-website-lines-'), 'clone');
    git(dirname(clone), 'init', '-b', 'main', clone);
    git(clone, 'remote', 'add', 'origin', f.remote);
    const { problems: found, fetches } = verifyIn(f, clone);
    expect(found).toEqual([]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).not.toContain('--depth=1');
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('false');
  });

  it('fetches the commit at depth 1 when the checkout is shallow already', () => {
    const f = pinned();
    release(f, '0.3.1');
    const clone = join(tempDir('marmeon-website-lines-'), 'clone');
    git(dirname(clone), 'clone', '--depth=1', `file://${f.remote}`, clone);
    const { problems: found, fetches } = verifyIn(f, clone);
    expect(found).toEqual([]);
    expect(fetches[0]).toContain('--depth=1');
  });

  it('ignores the .DS_Store a Finder leaves in the snapshot', () => {
    const f = pinned();
    writeFileSync(join(f.dir, '.DS_Store'), 'x');
    writeFileSync(join(f.dir, 'docs/.DS_Store'), 'x');
    writeFileSync(join(f.work, LINES_DIR, '.DS_Store'), 'x');
    expect(lines(f)).toEqual([]);
  });

  it('is red for a nested tag that only ends in the pinned name', () => {
    const f = pinned();
    git(f.remote, 'tag', '-d', 'v0.3.0');
    git(f.work, 'push', 'origin', 'refs/tags/v0.3.0:refs/tags/x/refs/tags/v0.3.0');
    expect(problems(f)).toMatch(/origin has no annotated tag v0\.3\.0 any more/);
  });

  it('is red for a byte changed in a page', () => {
    const f = pinned();
    const file = join(f.dir, 'docs/mail.md');
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
    expect(problems(f)).toMatch(/docs\/mail\.md differs from the commit/);
  });

  it('is red for a byte changed in the index', () => {
    const f = pinned();
    const file = join(f.dir, 'docs/index.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Mail', 'Post'));
    expect(problems(f)).toMatch(/docs\/index\.json differs/);
  });

  it('is red for a file more', () => {
    const f = pinned();
    writeFileSync(join(f.dir, 'docs/extra.md'), '# Extra\n');
    expect(problems(f)).toMatch(/docs\/extra\.md is in the snapshot, but not in the commit/);
  });

  it('is red for a file in a directory more', () => {
    const f = pinned();
    mkdirSync(join(f.dir, 'docs/sub'));
    writeFileSync(join(f.dir, 'docs/sub/a.md'), '# A\n');
    expect(problems(f)).toMatch(/docs\/sub\/a\.md is in the snapshot/);
  });

  it('is red for a missing file', () => {
    const f = pinned();
    unlinkSync(join(f.dir, 'SECURITY.md'));
    expect(problems(f)).toMatch(/SECURITY\.md is missing in the snapshot/);
  });

  it('is red for a symlink in the snapshot', () => {
    const f = pinned();
    unlinkSync(join(f.dir, 'docs/mail.md'));
    symlinkSync(join(f.work, 'docs/mail.md'), join(f.dir, 'docs/mail.md'));
    expect(problems(f)).toMatch(/not a regular file/);
  });

  it('is red for a snapshot that is gone, and for one without a pin', () => {
    const f = pinned();
    rmSync(f.dir, { recursive: true });
    expect(problems(f)).toMatch(/0\.3\.x is pinned, but apps\/website\/content\/lines\/0\.3\.x\/ is missing/);
    mkdirSync(join(f.work, LINES_DIR, '0.9.x'));
    expect(problems(f)).toMatch(/lines\/0\.9\.x has no pin/);
  });

  it('is red for a snapshot without any pins file', () => {
    const f = pinned();
    rmSync(join(f.work, PINS_FILE));
    expect(problems(f)).toMatch(/lines\/0\.3\.x has no pin/);
  });

  it('is red for a tag moved on origin after the pin, and names the pinned commit', () => {
    const f = pinned();
    const other = commit(f, '0.3.0', { 'docs/mail.md': '# Mail, moved\n' });
    git(f.work, 'push', 'origin', 'main');
    git(f.remote, 'tag', '-f', '-a', 'v0.3.0', other, '-m', 'moved');
    const found = problems(f);
    expect(found).toContain(`the tag on origin is ${other}, the pin ${f.sha}`);
    expect(found).toContain('the site keeps showing the pinned commit');
  });

  it('is red for a tag deleted on origin', () => {
    const f = pinned();
    git(f.remote, 'tag', '-d', 'v0.3.0');
    expect(problems(f)).toMatch(/origin has no annotated tag v0\.3\.0 any more/);
  });

  it('is red for a tag turned lightweight on origin', () => {
    const f = pinned();
    git(f.remote, 'tag', '-d', 'v0.3.0');
    git(f.remote, 'tag', 'v0.3.0', f.sha);
    expect(problems(f)).toMatch(/origin has no annotated tag/);
  });

  it('is red for a pin whose tag is of another version', () => {
    const f = pinned();
    const pins = JSON.parse(readFileSync(join(f.work, PINS_FILE), 'utf8')) as { lines: Record<string, { tag: string }> };
    Object.assign(pins.lines['0.3.x'] ?? {}, { tag: 'v0.3.1' });
    writeFileSync(join(f.work, PINS_FILE), JSON.stringify(pins));
    expect(problems(f)).toMatch(/tag of 0\.3\.x is not v0\.3\.0/);
  });

  it('is red for a line key that is not a line', () => {
    const f = pinned();
    const pins = JSON.parse(readFileSync(join(f.work, PINS_FILE), 'utf8')) as { lines: Record<string, unknown> };
    writeFileSync(join(f.work, PINS_FILE), JSON.stringify({ format: 1, lines: { '0.3': pins.lines['0.3.x'] } }));
    expect(problems(f)).toMatch(/does not belong to the line 0\.3/);
  });

  it('is red for a format other than 1', () => {
    const f = pinned();
    const pins = JSON.parse(readFileSync(join(f.work, PINS_FILE), 'utf8')) as object;
    writeFileSync(join(f.work, PINS_FILE), JSON.stringify({ ...pins, format: 2 }));
    expect(problems(f)).toMatch(/format 2 is not 1/);
  });

  it('is red for a pin whose commit is not the one of the manifest version', () => {
    const f = pinned();
    const second = release(f, '0.3.1');
    const pins = JSON.parse(readFileSync(join(f.work, PINS_FILE), 'utf8')) as { lines: Record<string, { commit: string }> };
    Object.assign(pins.lines['0.3.x'] ?? {}, { commit: second });
    writeFileSync(join(f.work, PINS_FILE), JSON.stringify(pins));
    expect(problems(f)).toMatch(/the tag on origin is [0-9a-f]{40}, the pin|says version "0\.3\.1", expected 0\.3\.0/);
  });
});

describe('the frozen snapshots', { timeout: 30_000 }, () => {
  it('are left out of the files the repository checks read', () => {
    const dir = tempDir('marmeon-website-lines-');
    git(dir, 'init', '-b', 'main');
    for (const path of ['apps/website/content/lines/0.3.x/docs/a.md', 'apps/website/content/lines/0.3.x/UPGRADING.md', 'apps/website/content/legal/imprint.md', 'docs/b.md']) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), '# Page\n');
    }
    expect(repositoryFiles(dir).map((file) => file.path).sort()).toEqual(['apps/website/content/legal/imprint.md', 'docs/b.md']);
  });
});
