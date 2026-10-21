import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import application from '../../bootstrap/app.ts';
import { DocsLines } from './DocsLines.ts';
import { DocsError } from './DocsRepository.ts';

const fixture = join(import.meta.dirname, '__fixtures__/lines');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** A copy of the fixture: `dir` holds the snapshots, `pins` is the pin file — the real fixture is never touched. */
function copy(): { dir: string; pins: string; snapshot: string } {
  const root = tempDir('marmeon-website-lines-boot-');
  cpSync(fixture, root, { recursive: true });
  return { dir: join(root, 'snapshots'), pins: join(root, 'docs-lines.json'), snapshot: join(root, 'snapshots/0.9.x') };
}

const pin = (version: string, extra: Record<string, unknown> = {}) => ({ version, tag: `v${version}`, commit: COMMIT, ...extra });
const writePins = (file: string, lines: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ format: 1, lines }));
const problemsOf = async (options: { dir: string; pins: string }): Promise<readonly string[]> => {
  const error = await new DocsLines(options).load().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(DocsError);
  return (error as DocsError).problems;
};
const editIndex = (snapshot: string, change: (index: Record<string, any>) => void) => {
  const file = join(snapshot, 'docs/index.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  change(index);
  writeFileSync(file, JSON.stringify(index));
};

describe('DocsLines', { timeout: 30_000 }, () => {
  it('reads the fixture line', async () => {
    const { dir, pins } = copy();
    const lines = await new DocsLines({ dir, pins }).load();
    expect(lines.all().map((line) => [line.name, line.version, line.commit])).toEqual([['0.9.x', '0.9.0', COMMIT]]);
    expect(lines.line('0.9.x')?.repository.pages().map((page) => page.path)).toEqual([
      '/docs/0.9.x/routing',
      '/docs/0.9.x/middleware',
      '/docs/0.9.x/retired-feature',
      '/docs/0.9.x/upgrade',
    ]);
    expect(lines.line('0.9.y')).toBeUndefined();
    expect(lines.line('../0.9.x')).toBeUndefined();
    expect(lines.line('__proto__')).toBeUndefined();
    lines.close();
  });

  it('has no lines without the pin file and the directory — and none for a pin file without lines', async () => {
    const root = tempDir('marmeon-website-lines-boot-');
    expect((await new DocsLines({ dir: join(root, 'lines'), pins: join(root, 'docs-lines.json') }).load()).all()).toEqual([]);
    writePins(join(root, 'docs-lines.json'), {});
    expect((await new DocsLines({ dir: join(root, 'lines'), pins: join(root, 'docs-lines.json') }).load()).all()).toEqual([]);
  });

  it('stops the start for a folder without a pin, a pin without a folder and a file among the folders', async () => {
    const { dir, pins, snapshot } = copy();
    cpSync(snapshot, join(dir, 'latest'), { recursive: true });
    writeFileSync(join(dir, 'stray.txt'), 'x');
    writePins(pins, { '0.9.x': pin('0.9.0'), '0.8.x': pin('0.8.0') });
    expect(await problemsOf({ dir, pins })).toEqual([
      expect.stringContaining('content/lines/latest has no pin'),
      expect.stringContaining('content/lines/stray.txt has no pin'),
      'docs-lines.json pins 0.8.x, but content/lines/0.8.x does not exist.',
    ]);
  });

  it('stops the start for an index that is not format 1, or of another version than the pin', async () => {
    const wrongFormat = copy();
    editIndex(wrongFormat.snapshot, (index) => (index.format = 2));
    expect(await problemsOf(wrongFormat)).toEqual(['content/lines/0.9.x/docs/index.json is not format 1.']);

    const wrongVersion = copy();
    editIndex(wrongVersion.snapshot, (index) => (index.version = '0.9.1'));
    expect(await problemsOf(wrongVersion)).toEqual(['content/lines/0.9.x/docs/index.json is the version "0.9.1", but 0.9.x is pinned at 0.9.0.']);

    const missing = copy();
    rmSync(join(missing.snapshot, 'docs/index.json'));
    expect(await problemsOf(missing)).toEqual(['content/lines/0.9.x/docs/index.json is missing or not JSON.']);
  });

  it('stops the start for a pin the format does not allow', async () => {
    const wrong = copy();
    writePins(wrong.pins, { '0.9.x': pin('0.9.0', { tag: 'v0.9.1' }) });
    expect(await problemsOf(wrong)).toContain('docs-lines.json: the tag of 0.9.x is not v0.9.0.');
    writePins(wrong.pins, { '0.9': pin('0.9.0') });
    expect(await problemsOf(wrong)).toContainEqual(expect.stringContaining('"0.9" is no release line'));
    writePins(wrong.pins, { '0.9.x': pin('0.9.0', { commit: 'main' }) });
    expect(await problemsOf(wrong)).toContain('docs-lines.json: the commit of 0.9.x is not 40 hexadecimal digits.');
    writePins(wrong.pins, { '0.9.x': pin('0.9.0', { branch: 'main' }) });
    expect(await problemsOf(wrong)).toContain('docs-lines.json: the pin of 0.9.x has to hold version, tag and commit and nothing else.');
    writePins(wrong.pins, { '0.8.x': pin('0.9.0') });
    expect(await problemsOf(wrong)).toContain('docs-lines.json: the version of 0.8.x is not one of that line.');
    writeFileSync(wrong.pins, '{ "format": 2, "lines": {} }');
    expect(await problemsOf(wrong)).toContainEqual(expect.stringContaining('has to be { "format": 1'));
    writeFileSync(wrong.pins, 'not json');
    expect(await problemsOf(wrong)).toContainEqual(expect.stringContaining('docs-lines.json is not JSON'));
  });

  it('stops the start for an index that names a file outside docs/<slug>.md and the root policies, or a file that is a link', async () => {
    const outside = copy();
    editIndex(outside.snapshot, (index) => (index.sections[0].pages[0].file = '../package.json'));
    expect(await problemsOf(outside)).toEqual(['content/lines/0.9.x/docs/index.json: ../package.json is no file of a line.']);

    const other = copy();
    editIndex(other.snapshot, (index) => (index.sections[0].pages[0].file = 'docs/middleware.md'));
    expect(await problemsOf(other)).toEqual([expect.stringContaining('is no file of a line')]);

    const linked = copy();
    rmSync(join(linked.snapshot, 'docs/routing.md'));
    writeFileSync(join(linked.dir, '..', 'outside.md'), '# Not part of the line\n');
    symlinkSync(join(linked.dir, '..', 'outside.md'), join(linked.snapshot, 'docs/routing.md'));
    expect(await problemsOf(linked)).toEqual(['content/lines/0.9.x/docs/routing.md is not a regular file.']);
  });

  it('stops the start when a folder is a link, or the docs folder of a line', async () => {
    const folder = copy();
    const target = join(folder.dir, '..', 'elsewhere');
    cpSync(folder.snapshot, target, { recursive: true });
    rmSync(folder.snapshot, { recursive: true });
    symlinkSync(target, folder.snapshot);
    expect(await problemsOf(folder)).toEqual(['content/lines/0.9.x is not a directory.', 'docs-lines.json pins 0.9.x, but content/lines/0.9.x does not exist.']);

    const docs = copy();
    const moved = join(docs.dir, '..', 'moved-docs');
    cpSync(join(docs.snapshot, 'docs'), moved, { recursive: true });
    rmSync(join(docs.snapshot, 'docs'), { recursive: true });
    symlinkSync(moved, join(docs.snapshot, 'docs'));
    expect(await problemsOf(docs)).toEqual(['content/lines/0.9.x/docs/index.json is missing or not JSON.']);
  });

  it('stops the start when the pages and the index of a line disagree, and names the line', async () => {
    const { dir, pins, snapshot } = copy();
    writeFileSync(join(snapshot, 'docs/unlisted.md'), '# Unlisted\n');
    rmSync(join(snapshot, 'docs/middleware.md'));
    expect(await problemsOf({ dir, pins })).toEqual([
      expect.stringMatching(/^0\.9\.x: docs\/middleware\.md is listed? |^0\.9\.x: docs.config.ts lists docs\/middleware\.md/),
      '0.9.x: docs/unlisted.md has no entry in docs.config.ts — add it to a section.',
    ]);
  });

  it('stops the app: the website does not start with pins and snapshots that do not fit', async () => {
    const { dir, pins, snapshot } = copy();
    mkdirSync(join(snapshot, '..', 'latest'));
    const error = await createTestApp(application, { env: { DOCS_LINES: dir, DOCS_LINE_PINS: pins } }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems).toEqual([expect.stringContaining('content/lines/latest has no pin')]);
  });
});
