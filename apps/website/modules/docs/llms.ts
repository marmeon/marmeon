import type { DocsRepository } from './DocsRepository.ts';

export const LLMS_TITLE = 'Marmeon';

// Keeps pace with the first paragraph of the root README.
export const LLMS_SUMMARY =
  'Marmeon is a full-stack framework for TypeScript on Node.js: an app is a set of modules whose routes, controllers and React pages are typed from end to end, and the server renders each page before the browser takes over.';

/** The head of `/llms.txt` and `/llms-full.txt`: the title, the summary and where to go. */
export function llmsHeader(input: { version: string; docsUrl: string; fullUrl: string }): string {
  return `# ${LLMS_TITLE}\n\n> ${LLMS_SUMMARY}\n\nThe documentation of Marmeon ${input.version}, each page as Markdown in the order of ${input.docsUrl}. Every page in one file: ${input.fullUrl}\n`;
}

const escapeTitle = (title: string): string => title.replace(/[[\]]/g, '\\$&');

/** `/llms.txt`: the header, then each non-empty section with a link to every page's Markdown. */
export function llmsIndex(header: string, sections: readonly { title: string; pages: readonly { title: string; url: string }[] }[]): string {
  const body = sections
    .filter((section) => section.pages.length > 0)
    .map((section) => `\n## ${section.title}\n\n${section.pages.map((page) => `- [${escapeTitle(page.title)}](${page.url})\n`).join('')}`)
    .join('');
  return header + body;
}

/** `/llms-full.txt`: the header, then every page's Markdown, each after a line naming where it is served. */
export function llmsFull(header: string, pages: readonly { url: string; markdown: string }[]): string {
  return header + pages.map((page) => `\n---\n\n<!-- Source: ${page.url} -->\n\n${page.markdown.trimEnd()}\n`).join('');
}

/** The sections of `/llms.txt`: every written page (no draft) with its title and the URL of its Markdown, `url` turning a path into an absolute URL. */
export function llmsSections(docs: Pick<DocsRepository, 'sections' | 'doc'>, url: (path: string) => string): { title: string; pages: { title: string; url: string }[] }[] {
  return docs.sections().map((section) => ({
    title: section.title,
    pages: section.pages.flatMap((entry) => {
      const page = docs.doc(entry.name);
      return page && !page.pending ? [{ title: page.title, url: url(`${page.path}.md`) }] : [];
    }),
  }));
}
