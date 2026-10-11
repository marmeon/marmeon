import { createCodeHighlighter } from '../docs/highlight.ts';
import { SNIPPETS, type Snippet, type SnippetName } from './snippets.ts';

/** A snippet as the landing shows it: its file name (if it has one) and the markup Shiki made. */
export interface HighlightedSnippet {
  readonly file?: string;
  readonly html: string;
}

/**
 * The landing's code, highlighted once at boot with the docs' Shiki and theme, so both look alike and the browser needs no
 * highlighter. An app singleton without request data.
 */
export class SiteSnippets {
  #snippets: Record<SnippetName, HighlightedSnippet> | undefined;

  async load(): Promise<void> {
    const { highlight } = await createCodeHighlighter();
    const entries = (Object.keys(SNIPPETS) as SnippetName[]).map((name) => {
      const { file, lang, code }: Snippet = SNIPPETS[name];
      return [name, file === undefined ? { html: highlight(code, lang) } : { file, html: highlight(code, lang) }] as const;
    });
    this.#snippets = Object.fromEntries(entries) as Record<SnippetName, HighlightedSnippet>;
  }

  /** The highlighted snippets; throws before `load()`. */
  all(): Record<SnippetName, HighlightedSnippet> {
    if (!this.#snippets) throw new Error('The landing snippets are not loaded yet.');
    return this.#snippets;
  }
}
