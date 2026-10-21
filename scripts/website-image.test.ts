import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import docsConfig from '../apps/website/docs.config.ts';
import { tempDir } from './test/temp-dir.js';
import { inspectionProblems } from './website-image.ts';
import { LINES_DIR, PINS_FILE } from './website-lines.ts';

const TOP = ['.marmeon', 'README.md', 'bootstrap', 'config', 'content', 'dist', 'docs.config.ts', 'index.html', 'layouts', 'modules', 'node_modules', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'storage', 'styles'];
const SNAPSHOT = ['docs/index.json', 'docs/routing.md', 'UPGRADING.md'];

/** A repository with the docs of the website's configuration and, per line, a snapshot of `SNAPSHOT`; the image listing that matches it. */
function repository(lines: string[]) {
  const root = tempDir('marmeon-website-image-');
  const write = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'x');
  };
  const entries = docsConfig.sections.flatMap((section) => section.pages);
  for (const entry of entries) write(entry.file ?? `docs/${entry.slug}.md`);
  const version = (line: string) => `${line.replace('.x', '')}.0.0`;
  const pins = Object.fromEntries(lines.map((line) => [line, { version: version(line), tag: `v${version(line)}`, commit: '0123456789abcdef0123456789abcdef01234567' }]));
  if (lines.length > 0) {
    write(PINS_FILE);
    writeFileSync(join(root, PINS_FILE), JSON.stringify({ format: 1, lines: pins }));
    for (const line of lines) for (const file of SNAPSHOT) write(`${LINES_DIR}/${line}/${file}`);
  }
  const content = [...entries.map((entry) => `content/${entry.file ?? `docs/${entry.slug}.md`}`), 'content/legal/imprint.md', 'content/legal/privacy.md'];
  const found = {
    top: lines.length > 0 ? [...TOP, 'docs-lines.json'] : TOP,
    env: [],
    tests: [],
    store: [],
    content: [...content, ...lines.flatMap((line) => SNAPSHOT.map((file) => `content/lines/${line}/${file}`))],
  };
  return { root, found };
}

describe('what the docs image has to hold', () => {
  it('needs no line while nothing is pinned', () => {
    const { root, found } = repository([]);
    expect(inspectionProblems(found, root)).toEqual([]);
  });

  it('holds the pins and every file of each snapshot', () => {
    const { root, found } = repository(['1.x', '2.x']);
    expect(inspectionProblems(found, root)).toEqual([]);
  });

  it('flags a pin file that did not reach the image', () => {
    const { root, found } = repository(['1.x']);
    found.top = TOP;
    expect(inspectionProblems(found, root)).toEqual([expect.stringContaining('/app lacks docs-lines.json')]);
  });

  it('flags a snapshot that did not reach the image', () => {
    const { root, found } = repository(['1.x']);
    found.content = found.content.filter((file) => file !== 'content/lines/1.x/docs/index.json');
    expect(inspectionProblems(found, root)).toEqual([expect.stringContaining('content/lines/1.x/docs/index.json')]);
  });

  it('flags a line in the image that no pin names', () => {
    const { root, found } = repository(['1.x']);
    found.content.push('content/lines/0.9.x/docs/routing.md');
    expect(inspectionProblems(found, root)).toEqual([expect.stringContaining('content/lines/0.9.x/docs/routing.md')]);
  });
});
