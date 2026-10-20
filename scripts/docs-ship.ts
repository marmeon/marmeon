/**
 * `node scripts/docs-ship.ts` — the documentation of this version for the `marmeon` package: `docs/*.md` and the three policies
 * (`UPGRADING.md`, `SECURITY.md`, `CONTRIBUTING.md`) are copied byte for byte into `packages/cli/`, so every app finds them under
 * `node_modules/marmeon/docs/`. The copies are made by `pnpm build`, never checked in (`pnpm pack:check` holds the tarball to them).
 *
 * Next to the pages it writes `docs/index.json` (format 1) and `docs/llms.txt`; both are deterministic — sorted, `\n`, no time.
 *
 *   { "format": 1, "version", "sections": [{ "title", "pages": [{ "slug", "label", "title", "file" }] }] }
 *
 * `file` is relative to the package (`docs/routing.md`, `UPGRADING.md`), `title` is the page's `#` heading.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DocsDefinition } from '../apps/website/docs.config.ts';

/** The policies the docs show as pages; they sit at the package's root so `../UPGRADING.md` in a page stays valid. */
export const ROOT_FILES = ['UPGRADING.md', 'SECURITY.md', 'CONTRIBUTING.md'] as const;
/** What a copy replaces: the directory and the three files, relative to the package. */
export const SHIPPED = ['docs', ...ROOT_FILES] as const;

const repository = fileURLToPath(new URL('..', import.meta.url));

/** Every file of the documentation as the package carries it — path relative to the package → bytes. */
export async function expectedDocs(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  // Only regular .md files: a symlink would carry the bytes of a file outside the repository into the tarball.
  const entries = readdirSync(join(root, 'docs'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    if (!entry.isFile() || !entry.name.endsWith('.md')) throw new Error(`docs/${entry.name} is not a regular .md file — docs/ holds pages only`);
    files.set(`docs/${entry.name}`, readFileSync(join(root, 'docs', entry.name)));
  }
  for (const name of ROOT_FILES) {
    if (!lstatSync(join(root, name)).isFile()) throw new Error(`${name} is not a regular file`);
    files.set(name, readFileSync(join(root, name)));
  }

  const docs = ((await import(pathToFileURL(join(root, 'apps/website/docs.config.ts')).href)) as { default: DocsDefinition }).default;
  const version = (JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;
  const sections = docs.sections.map((section) => ({
    title: section.title,
    pages: section.pages.map((entry) => {
      const file = entry.file ?? `docs/${entry.slug}.md`;
      const bytes = files.get(file);
      if (bytes === undefined) throw new Error(`docs.config.ts lists ${entry.slug}, but ${file} does not exist`);
      return { slug: entry.slug, label: entry.label, title: titleOf(bytes.toString('utf8'), entry.label), file };
    }),
  }));
  files.set('docs/index.json', Buffer.from(`${JSON.stringify({ format: 1, version, sections }, null, 2)}\n`));
  files.set('docs/llms.txt', Buffer.from(llmsText(sections)));
  return files;
}

/** Replaces the copies in `target` (the `marmeon` package) with the documentation of `root`. */
export async function shipDocs(root: string, target: string): Promise<string[]> {
  const files = await expectedDocs(root);
  for (const name of SHIPPED) rmSync(join(target, name), { recursive: true, force: true });
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  return [...files.keys()];
}

/** The first `#` heading outside a code fence. */
function titleOf(text: string, fallback: string): string {
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith('# ')) return line.slice(2).trim();
  }
  return fallback;
}

type Sections = { title: string; pages: { slug: string; label: string; title: string; file: string }[] }[];

/** The pages as a list for a reader without the index: links relative to `docs/`. */
function llmsText(sections: Sections): string {
  const lines = ['# Marmeon', '', '> The documentation of the installed version. Links are relative to this file.'];
  for (const section of sections) {
    lines.push('', `## ${section.title}`, '');
    for (const page of section.pages) lines.push(`- [${page.title}](${page.file.startsWith('docs/') ? page.file.slice('docs/'.length) : `../${page.file}`})`);
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const written = await shipDocs(repository, join(repository, 'packages/cli'));
  console.log(`docs-ship: ${written.length} files into packages/cli`);
}
