import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNotes, prepare, sectionBody } from './release-prepare.ts';
import type { Runner } from './release-rules.ts';
import { tempDir } from './test/temp-dir.js';

const PR = 'https://github.com/marmeon/marmeon/pull';

/** What GitHub returns for the categories of `.github/release.yml`. */
function notes(options: { breaking?: string[]; feature?: string[]; fix?: string[]; docs?: string[]; unlabelled?: string[]; contributors?: string[]; to?: string } = {}) {
  const block = (title: string, lines: string[] | undefined) => (lines && lines.length > 0 ? `### ${title}\n${lines.map((line) => `* ${line}`).join('\n')}\n` : '');
  return [
    '<!-- Release notes generated using configuration in .github/release.yml at main -->',
    '',
    "## What's Changed",
    block('Breaking changes', options.breaking) +
      block('Features', options.feature) +
      block('Fixes', options.fix) +
      block('Documentation', options.docs) +
      block('Without a release label', options.unlabelled),
    options.contributors ? `## New Contributors\n${options.contributors.map((line) => `* ${line}`).join('\n')}\n` : '',
    `**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.2...v${options.to ?? '0.1.3'}`,
    '',
  ].join('\n');
}

const fixes = [`Escape the cookie name by @max in ${PR}/12`, `Close the socket on abort by @max in ${PR}/13`];

interface World {
  branch?: string;
  dirty?: boolean;
  head?: string;
  origin?: string;
  previous?: string;
  /** Tags origin knows (`ls-remote`). */
  remoteTags?: string[];
  /** Tags in the local clone (after the fetch). */
  localTags?: string[];
  /** Tags not reachable from HEAD, each with the CHANGELOG of the `core` package at that tag. */
  unreachable?: Record<string, string>;
  /** The notes `gh` returns, by the `tag_name` it is asked for; the default entry answers every other tag. */
  generate: Record<string, string>;
  /** Answers the n-th (0-based) generate call instead of `generate`. */
  sequence?: string[];
  /** A merged release commit: what `git log` finds and its first parent. */
  releaseCommit?: { commit: string; parent: string };
}

const HEAD = 'a'.repeat(40);

function fake(world: World) {
  const calls: string[][] = [];
  const run: Runner = (command, args) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const joined = args.join(' ');
    if (command === 'gh') {
      const tag = args.find((arg) => arg.startsWith('tag_name='))!.slice('tag_name='.length);
      const nth = calls.filter((call) => call[0] === 'gh').length - 1;
      return ok(world.sequence?.[nth] ?? world.generate[tag] ?? world.generate.default);
    }
    if (joined === 'status --porcelain') return ok(world.dirty ? ' M file\n' : '');
    if (joined === 'branch --show-current') return ok(`${world.branch ?? 'main'}\n`);
    if (joined === 'fetch origin --tags') return ok();
    if (joined === 'rev-parse HEAD') return ok(`${world.head ?? HEAD}\n`);
    if (args[0] === 'log') return world.releaseCommit ? ok(`${world.releaseCommit.commit}\n`) : { status: 0, stdout: '', stderr: '' };
    if (world.releaseCommit && joined === `rev-parse ${world.releaseCommit.commit}^1`) return ok(`${world.releaseCommit.parent}\n`);
    if (args[0] === 'rev-parse') return ok(`${world.origin ?? world.head ?? HEAD}\n`);
    if (args[0] === 'describe') return ok(`${world.previous ?? 'v0.1.2'}\n`);
    if (args[0] === 'ls-remote') return ok((world.remoteTags ?? []).includes(args[3]!.replace('refs/tags/', '')) ? `abc\t${args[3]}\n` : '');
    if (args[0] === 'tag' && args.includes('--no-merged')) return ok(Object.keys(world.unreachable ?? {}).join('\n'));
    if (args[0] === 'tag') return ok((world.localTags ?? []).filter((tag) => tag === args[2]).join('\n'));
    if (args[0] === 'show') {
      const text = world.unreachable?.[args[1]!.split(':')[0]!];
      return text === undefined || !args[1]!.includes('/core/') ? { status: 128, stdout: '', stderr: 'missing' } : ok(text);
    }
    throw new Error(`unexpected call: ${command} ${joined}`);
  };
  return { run, calls, generated: () => calls.filter((call) => call[0] === 'gh').map((call) => call.find((arg) => arg.startsWith('tag_name='))!) };
}

const SHORTS = ['core', 'http'];

/** A repository with two packages at `version`, each with a CHANGELOG that has the old releases. */
function repository(version = '0.1.2', extra: { changelog?: (short: string) => string; upgrading?: string } = {}) {
  const dir = tempDir('marmeon-release-prepare-');
  for (const short of SHORTS) {
    mkdirSync(join(dir, 'packages', short), { recursive: true });
    writeFileSync(join(dir, 'packages', short, 'package.json'), `{\n  "name": "@marmeon/${short}",\n  "version": "${version}",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n`);
    writeFileSync(
      join(dir, 'packages', short, 'CHANGELOG.md'),
      extra.changelog?.(short) ?? `# @marmeon/${short}\n\n## 0.1.2\n\nNo changes in this release.\n\n## 0.1.1\n\n- f56608b: Publish through the workflow.\n`,
    );
  }
  writeFileSync(join(dir, 'UPGRADING.md'), extra.upgrading ?? '# Upgrading\n\nIntro.\n');
  const read = (path: string) => readFileSync(join(dir, path), 'utf8');
  return { dir, read };
}

function go(repo: { dir: string }, world: World, dryRun = false) {
  const runner = fake(world);
  const log: string[] = [];
  const result = prepare({ root: repo.dir, run: runner.run, dryRun, log: (line) => log.push(line) });
  return { ...runner, result, log };
}

describe('parseNotes and sectionBody', () => {
  it('reads a categorised response and writes the section text', () => {
    const body = notes({
      breaking: [`Drop the legacy cookie option by @max in ${PR}/20`],
      fix: fixes,
      contributors: [`@newbie made their first contribution in ${PR}/13`],
      to: '0.2.0',
    });
    const parsed = parseNotes(body);
    expect(parsed.entries.get('breaking')).toEqual([`Drop the legacy cookie option by @max in ${PR}/20`]);
    expect(parsed.entries.get('fix')).toEqual(fixes);
    expect(parsed.unlabelled).toEqual([]);
    expect(parsed.contributors).toEqual([`@newbie made their first contribution in ${PR}/13`]);
    expect(sectionBody(parsed)).toBe(
      [
        '### Breaking changes',
        '',
        `- Drop the legacy cookie option by @max in ${PR}/20`,
        '',
        '### Fixes',
        '',
        `- Escape the cookie name by @max in ${PR}/12`,
        `- Close the socket on abort by @max in ${PR}/13`,
        '',
        '### New contributors',
        '',
        `- @newbie made their first contribution in ${PR}/13`,
        '',
        '**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.2...v0.2.0',
      ].join('\n'),
    );
  });

  it('puts the categories in their fixed order whatever the response order', () => {
    const parsed = parseNotes("## What's Changed\n### Documentation\n* Doc by @a in https://x/pull/1\n### Features\n* Feat by @a in https://x/pull/2\n");
    expect(sectionBody(parsed)).toBe('### Features\n\n- Feat by @a in https://x/pull/2\n\n### Documentation\n\n- Doc by @a in https://x/pull/1');
  });

  it('collects the unlabelled pull requests apart', () => {
    expect(parseNotes(notes({ unlabelled: [`Mystery by @max in ${PR}/9`] })).unlabelled).toEqual([`Mystery by @max in ${PR}/9`]);
  });

  it('refuses an unknown category and a flat list', () => {
    expect(() => parseNotes("## What's Changed\n### Chores\n* a\n")).toThrow(/Unknown category/);
    expect(() => parseNotes("## What's Changed\n* A flat list by @a in https://x/pull/1\n")).toThrow(/outside any category/);
  });
});

describe('prepare', () => {
  it('makes 0.1.3 from fixes: versions, identical sections, nothing else touched', () => {
    const repo = repository();
    const { generated, result } = go(repo, { generate: { default: notes({ fix: fixes }) } });
    expect(result).toMatchObject({ version: '0.1.3', bump: 'patch', previous: '0.1.2' });
    expect(generated()).toEqual(['tag_name=v0.1.3']);
    for (const short of SHORTS) {
      expect(repo.read(`packages/${short}/package.json`)).toBe(`{\n  "name": "@marmeon/${short}",\n  "version": "0.1.3",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n`);
      const changelog = repo.read(`packages/${short}/CHANGELOG.md`);
      expect(changelog.startsWith(`# @marmeon/${short}\n\n## 0.1.3\n\n### Fixes\n\n- Escape the cookie name`)).toBe(true);
      expect(changelog).toContain('\n\n## 0.1.2\n\nNo changes in this release.\n\n## 0.1.1\n');
    }
    expect(repo.read('packages/core/CHANGELOG.md').split('## 0.1.3')[1]!.split('## 0.1.2')[0]).toBe(repo.read('packages/http/CHANGELOG.md').split('## 0.1.3')[1]!.split('## 0.1.2')[0]);
    expect(repo.read('UPGRADING.md')).toBe('# Upgrading\n\nIntro.\n');
    expect(repo.read('.github/release-base')).toBe(`0.1.3 ${'a'.repeat(40)}\n`);
  });

  it('makes 0.2.0 from a breaking pull request, asks for the notes again and writes the UPGRADING heading', () => {
    const repo = repository();
    const breaking = [`Drop the legacy cookie option by @max in ${PR}/20`];
    const { generated, result } = go(repo, {
      generate: { default: notes({ breaking, fix: fixes }), 'v0.2.0': notes({ breaking, fix: fixes, to: '0.2.0' }) },
    });
    expect(result).toMatchObject({ version: '0.2.0', bump: 'minor' });
    expect(generated()).toEqual(['tag_name=v0.1.3', 'tag_name=v0.2.0']);
    expect(repo.read('packages/core/package.json')).toContain('"version": "0.2.0"');
    expect(repo.read('packages/core/CHANGELOG.md')).toContain('compare/v0.1.2...v0.2.0');
    const upgrading = repo.read('UPGRADING.md');
    expect(upgrading).toContain('## Upgrading to 0.2.0 from 0.1.2\n\n<!-- One entry per breaking pull request: #20 Drop the legacy cookie option — then list');
    expect(upgrading.startsWith('# Upgrading\n\nIntro.\n\n## Upgrading to 0.2.0')).toBe(true);
  });

  it('puts the new UPGRADING section above the older ones and leaves an existing section of the version alone', () => {
    const older = '# Upgrading\n\n## Upgrading to 0.2.0 from 0.1.2\n\nOlder text.\n';
    const repo = repository('0.2.0', { upgrading: older, changelog: (short) => `# @marmeon/${short}\n\n## 0.2.0\n\nold\n\n## 0.1.2\n\nx\n` });
    go(repo, { previous: 'v0.1.2', generate: { default: notes({ breaking: [`Break by @a in ${PR}/1`], fix: fixes, to: '0.2.0' }) } });
    expect(repo.read('UPGRADING.md')).toBe(older);
    expect(repo.read('packages/core/CHANGELOG.md')).not.toContain('old');

    const stacked = repository('0.2.0', { upgrading: '# Upgrading\n\n## Upgrading to 0.2.0 from 0.1.2\n\nText.\n' });
    go(stacked, { previous: 'v0.2.0', generate: { default: notes({ breaking: [`Break by @a in ${PR}/1`], to: '0.3.0' }) } });
    expect(stacked.read('UPGRADING.md')).toMatch(/^# Upgrading\n\n## Upgrading to 0\.3\.0 from 0\.2\.0\n\n<!-- .* -->\n\n## Upgrading to 0\.2\.0 from 0\.1\.2\n\nText\.\n$/s);
  });

  it('prepares the same version again: previous tag to HEAD, versions untouched, section replaced', () => {
    const repo = repository('0.1.3', {
      changelog: (short) => `# @marmeon/${short}\n\n## 0.1.3\n\n### Fixes\n\n- Escape the cookie name by @max in ${PR}/12\n\n**Full Changelog**: x\n\n## 0.1.2\n\nNo changes in this release.\n`,
    });
    const before = repo.read('packages/core/package.json');
    const late = [...fixes, `Fix the late bug by @max in ${PR}/15`];
    const { generated, result, calls } = go(repo, { generate: { default: notes({ fix: late }) } });
    expect(result.version).toBe('0.1.3');
    expect(generated()).toEqual(['tag_name=v0.1.3']);
    expect(calls.find((call) => call[0] === 'gh')).toContain('previous_tag_name=v0.1.2');
    expect(calls.some((call) => call[1] === 'ls-remote')).toBe(true);
    expect(repo.read('packages/core/package.json')).toBe(before);
    const changelog = repo.read('packages/core/CHANGELOG.md');
    expect(changelog.match(/## 0\.1\.3/g)).toHaveLength(1);
    expect(changelog).toContain('Fix the late bug');
    expect(changelog).toContain('\n\n## 0.1.2\n\nNo changes');
  });

  it('refuses a second preparation that changes nothing once its release commit is merged, and allows it before', () => {
    const repo = repository();
    const world = { generate: { default: notes({ fix: fixes }) } };
    go(repo, world);
    const first = repo.read('packages/core/CHANGELOG.md');
    const merged = { commit: 'd'.repeat(40), parent: HEAD };
    expect(() => go(repo, { ...world, releaseCommit: merged })).toThrow(/Nothing new since the last preparation of 0\.1\.3 — the release commit on main is ready: start the Release workflow/);
    expect(repo.read('packages/core/CHANGELOG.md')).toBe(first);
    // main moved before the release was merged: the release commit's parent is not the recorded base, so a new base is worth a pull request
    go(repo, { ...world, head: 'e'.repeat(40), releaseCommit: { ...merged, parent: 'f'.repeat(40) } });
    expect(repo.read('.github/release-base')).toBe(`0.1.3 ${'e'.repeat(40)}\n`);
  });

  it('prepares again when only the commit changed: the base moves, the CHANGELOGs stay', () => {
    const repo = repository();
    const world = { generate: { default: notes({ fix: fixes }) } };
    go(repo, world);
    const changelog = repo.read('packages/core/CHANGELOG.md');
    const moved = 'c'.repeat(40);
    go(repo, { ...world, head: moved });
    expect(repo.read('.github/release-base')).toBe(`0.1.3 ${moved}\n`);
    expect(repo.read('packages/core/CHANGELOG.md')).toBe(changelog);
  });

  it('refuses a version that is already tagged locally', () => {
    expect(() => go(repository(), { localTags: ['v0.1.3'], generate: { default: notes({ fix: fixes }) } })).toThrow(/v0\.1\.3 is already tagged/);
  });

  it('judges the notes it writes: a pull request unlabelled or made breaking between the two calls is caught', () => {
    const breaking = [`Break by @a in ${PR}/1`];
    expect(() =>
      go(repository(), { generate: {}, sequence: [notes({ breaking, fix: fixes }), notes({ breaking, fix: fixes, unlabelled: [`Late by @a in ${PR}/2`], to: '0.2.0' })] }),
    ).toThrow(/Label these pull requests[\s\S]*Late/);
    expect(() => go(repository(), { generate: {}, sequence: [notes({ fix: fixes }), notes({ fix: fixes })] })).not.toThrow();
    expect(() => go(repository('0.1.2'), { branch: '0.1.x', generate: {}, sequence: [notes({ fix: fixes })] })).not.toThrow();
  });

  it('turns an untagged 0.1.3 into 0.2.0 when a breaking pull request came in, dropping the 0.1.3 section', () => {
    const repo = repository();
    go(repo, { generate: { default: notes({ fix: fixes }) } });
    const breaking = [`Drop it by @max in ${PR}/30`];
    go(repo, { generate: { default: notes({ breaking, fix: fixes }), 'v0.2.0': notes({ breaking, fix: fixes, to: '0.2.0' }) } });
    const changelog = repo.read('packages/core/CHANGELOG.md');
    expect(changelog).not.toContain('## 0.1.3');
    expect(changelog).toContain('## 0.2.0');
    expect(repo.read('packages/http/package.json')).toContain('"version": "0.2.0"');
  });

  it('refuses when an UPGRADING section of an untagged version is left behind', () => {
    const repo = repository('0.2.0', {
      upgrading: '# Upgrading\n\n## Upgrading to 0.2.0 from 0.1.2\n\nText.\n',
      changelog: (short) => `# @marmeon/${short}\n\n## 0.2.0\n\nold\n\n## 0.1.2\n\nx\n`,
    });
    expect(() => go(repo, { generate: { default: notes({ fix: fixes }) } })).toThrow(/Upgrading to 0\.2\.0 from 0\.1\.2.*makes 0\.1\.3/s);
  });

  it('refuses when the packages are at a version that is already tagged on origin', () => {
    const repo = repository('0.1.3');
    expect(() => go(repo, { remoteTags: ['v0.1.3'], generate: { default: notes({ fix: fixes }) } })).toThrow(/v0\.1\.3 is tagged on origin/);
  });

  it('refuses packages below the last tag and packages that disagree', () => {
    expect(() => go(repository('0.1.1'), { generate: { default: notes({ fix: fixes }) } })).toThrow(/below the last tag/);
    const repo = repository();
    writeFileSync(join(repo.dir, 'packages/http/package.json'), '{\n  "name": "@marmeon/http",\n  "version": "0.1.0"\n}\n');
    expect(() => go(repo, { generate: { default: notes({ fix: fixes }) } })).toThrow(/do not share one version/);
  });

  it('refuses unlabelled pull requests naming them, and a release with nothing to ship', () => {
    const mystery = `Mystery by @max in ${PR}/9`;
    expect(() => go(repository(), { generate: { default: notes({ fix: fixes, unlabelled: [mystery] }) } })).toThrow(new RegExp(`Label these pull requests[\\s\\S]*${mystery}`));
    expect(() => go(repository(), { generate: { default: notes() } })).toThrow(/Nothing to release since v0\.1\.2/);
  });

  it('does not let a title delete lines or hide the rest of the section', () => {
    const body = notes({ fix: [`Render <!-- in docs by @a in ${PR}/5`, `Close --> handling by @a in ${PR}/6`], unlabelled: [`Mystery by @max in ${PR}/9`] });
    expect(parseNotes(body).unlabelled).toEqual([`Mystery by @max in ${PR}/9`]);
    expect(parseNotes(body).entries.get('fix')).toHaveLength(2);
    const text = sectionBody(parseNotes(notes({ fix: [`Render <!-- in docs by @a in ${PR}/5`] })));
    expect(text).not.toContain('<!--');
    expect(text).toContain('Render &lt;!-- in docs');
    const code = sectionBody(parseNotes(notes({ fix: ['Fix `<Form>` and <b> by @a in x', 'Fix `a <!-- b` by @a in y'] })));
    expect(code).toContain('- Fix `<Form>` and &lt;b> by @a in x');
    expect(code).toContain('- Fix `a &lt;!-- b` by @a in y');
    expect(() => go(repository(), { generate: { default: body } })).toThrow(/Label these pull requests[\s\S]*Mystery/);
  });

  it('keeps the UPGRADING placeholder one comment whatever a title holds', () => {
    const repo = repository();
    const breaking = [`Drop --> the <!-- option by @max in ${PR}/20`];
    go(repo, { generate: { default: notes({ breaking }), 'v0.2.0': notes({ breaking, to: '0.2.0' }) } });
    const comment = repo.read('UPGRADING.md').split('## Upgrading to 0.2.0 from 0.1.2')[1]!;
    expect(comment.match(/-->/g)).toHaveLength(1);
    expect(comment.match(/<!--/g)).toHaveLength(1);
    expect(comment).toContain('#20 Drop - the &lt;!- option');
  });

  it('refuses a breaking pull request on a maintenance branch', () => {
    const repo = repository();
    expect(() => go(repo, { branch: '0.1.x', generate: { default: notes({ breaking: [`Break by @a in ${PR}/1`] }) } })).toThrow(/0\.1\.x releases 0\.1 fixes only/);
    expect(go(repository(), { branch: '0.1.x', generate: { default: notes({ fix: fixes }) } }).result.version).toBe('0.1.3');
  });

  it('adds the sections of tags HEAD does not reach on main, in version order', () => {
    const repo = repository('0.1.3', {
      changelog: (short) => `# @marmeon/${short}\n\n## 0.1.3\n\nold\n\n## 0.1.2\n\nNo changes.\n`,
    });
    const breaking = [`Break by @a in ${PR}/1`];
    go(repo, {
      unreachable: { 'v0.1.4': '# @marmeon/core\n\n## 0.1.4\n\nBackported fix.\n\n## 0.1.3\n\nold\n' },
      generate: { default: notes({ breaking }), 'v0.2.0': notes({ breaking, to: '0.2.0' }) },
    });
    const versions = [...repo.read('packages/core/CHANGELOG.md').matchAll(/^## (\S+)$/gm)].map((match) => match[1]);
    expect(versions).toEqual(['0.2.0', '0.1.4', '0.1.2']);
    expect(repo.read('packages/core/CHANGELOG.md')).toContain('Backported fix.');
    // http has no such section at the tag (the fake shows only core's file): nothing added there
    expect([...repo.read('packages/http/CHANGELOG.md').matchAll(/^## (\S+)$/gm)].map((match) => match[1])).toEqual(['0.2.0', '0.1.2']);
  });

  it('starts a CHANGELOG for a package without one', () => {
    const repo = repository();
    rmSync(join(repo.dir, 'packages/http/CHANGELOG.md'));
    go(repo, { generate: { default: notes({ fix: fixes }) } });
    expect(repo.read('packages/http/CHANGELOG.md').startsWith('# @marmeon/http\n\n## 0.1.3\n\n### Fixes')).toBe(true);
  });

  it('refuses a dirty tree, a HEAD that is not origin and any other branch', () => {
    const world = { generate: { default: notes({ fix: fixes }) } };
    expect(() => go(repository(), { ...world, dirty: true })).toThrow(/not clean/);
    expect(() => go(repository(), { ...world, head: 'aaa', origin: 'bbb' })).toThrow(/HEAD is not origin\/main/);
    expect(() => go(repository(), { ...world, branch: 'feature/x' })).toThrow(/not on "feature\/x"/);
  });

  it('writes nothing on a dry run', () => {
    const repo = repository();
    const { result, log } = go(repo, { generate: { default: notes({ fix: fixes }) } }, true);
    expect(result.version).toBe('0.1.3');
    expect(log.join('\n')).toContain('Dry run');
    expect(repo.read('packages/core/package.json')).toContain('"version": "0.1.2"');
    expect(repo.read('packages/core/CHANGELOG.md')).not.toContain('0.1.3');
  });
});
