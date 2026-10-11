import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../docs/markdown.ts';
import type { DocNode } from '../docs/types.ts';

/** The legal pages, by the name of their file in `content/legal/`. */
export const LEGAL_PAGES = ['imprint', 'privacy'] as const;
export type LegalPageName = (typeof LEGAL_PAGES)[number];

/** A legal page as the view shows it: the text of its `#` heading and the rest as nodes. */
export interface LegalPage {
  readonly title: string;
  readonly body: readonly DocNode[];
}

/**
 * The imprint and the privacy policy — `content/legal/*.md`, read and rendered once when the app boots with the docs' Markdown
 * renderer (raw HTML stays text), so a missing file stops the start. An app singleton without request data. They are no pages of
 * the docs: not in its navigation, not in its search.
 */
export class LegalPages {
  readonly #directory: string;
  #pages: ReadonlyMap<LegalPageName, LegalPage> | undefined;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /** Reads and renders every page; throws when a file is missing or has no `#` heading. */
  load(): void {
    const pages = new Map<LegalPageName, LegalPage>();
    for (const name of LEGAL_PAGES) {
      const file = join(this.#directory, `${name}.md`);
      const { title, body } = renderMarkdown(readFileSync(file, 'utf8'), {
        file: `${name}.md`,
        pageOf: () => undefined,
        highlight: () => {
          throw new Error(`${file} holds a code block — the legal pages have none.`);
        },
      });
      if (!title) throw new Error(`${file} has no "# " heading for its title.`);
      pages.set(name, { title, body });
    }
    this.#pages = pages;
  }

  /** A page; throws before `load()`. */
  page(name: LegalPageName): LegalPage {
    const page = this.#pages?.get(name);
    if (!page) throw new Error('The legal pages are not loaded yet.');
    return page;
  }
}
