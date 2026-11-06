import { createCodeHighlighter } from '../docs/highlight.ts';
import { CHAIN, mistakeLine, type ChainStepSpec } from './chain.ts';
import { SNIPPETS, type Snippet, type SnippetName } from './snippets.ts';

/** A snippet as the landing shows it: its file name (if it has one) and the markup Shiki made. */
export interface HighlightedSnippet {
  readonly file?: string;
  readonly html: string;
}

/** One step of the typo chain as the page shows it: the snippet, the misspelt line, and the compiler's answer from `chain.ts`. */
export interface HighlightedChainStep {
  readonly id: ChainStepSpec['id'];
  readonly title: string;
  readonly snippet: HighlightedSnippet;
  /** The misspelt line, highlighted in the snippet's language. */
  readonly mistake: string;
  readonly error: ChainStepSpec['error'];
}

/**
 * The landing's code, highlighted once at boot with the docs' Shiki and theme, so both look alike and the browser needs no
 * highlighter. An app singleton without request data.
 */
export class SiteSnippets {
  #snippets: Record<SnippetName, HighlightedSnippet> | undefined;
  #chain: readonly HighlightedChainStep[] | undefined;

  async load(): Promise<void> {
    const { highlight } = await createCodeHighlighter();
    const entries = (Object.keys(SNIPPETS) as SnippetName[]).map((name) => {
      const { file, lang, code }: Snippet = SNIPPETS[name];
      return [name, file === undefined ? { html: highlight(code, lang) } : { file, html: highlight(code, lang) }] as const;
    });
    const snippets = Object.fromEntries(entries) as Record<SnippetName, HighlightedSnippet>;
    this.#snippets = snippets;
    this.#chain = CHAIN.map((step) => ({
      id: step.id,
      title: step.title,
      snippet: snippets[step.snippet],
      mistake: highlight(mistakeLine(step), SNIPPETS[step.snippet].lang),
      error: step.error,
    }));
  }

  /** The highlighted snippets; throws before `load()`. */
  all(): Record<SnippetName, HighlightedSnippet> {
    if (!this.#snippets) throw new Error('The landing snippets are not loaded yet.');
    return this.#snippets;
  }

  /** The steps of the typo chain, in the order of `CHAIN`; throws before `load()`. */
  chain(): readonly HighlightedChainStep[] {
    if (!this.#chain) throw new Error('The landing snippets are not loaded yet.');
    return this.#chain;
  }
}
