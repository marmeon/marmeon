import { createHighlighter, type BundledLanguage } from 'shiki';
import { MARMEON_THEME, ROLE_COLOURS } from './shiki-theme.ts';

/** `code` in `lang` as a `<pre>` with highlighted, escaped markup — on the server only: the browser gets no highlighter. */
export type Highlighter = (code: string, lang: string) => string;

const LANGS = ['ts', 'tsx', 'js', 'json', 'sh', 'yaml', 'sql', 'diff', 'html', 'css'] as const satisfies readonly BundledLanguage[];
const ALIASES: Record<string, string> = { typescript: 'ts', javascript: 'js', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', yml: 'yaml' };

/**
 * The theme's placeholder colour of each role → a class; `styles/code.css` gives each class its light and its dark colour. The
 * plain text colour needs no span at all. A colour missing here keeps its inline style (`unknownColours` lists them — a test
 * keeps the list empty).
 */
export const TOKEN_CLASSES: Readonly<Record<string, string>> = {
  [ROLE_COLOURS.keyword]: 'tk',
  [ROLE_COLOURS.type]: 'ty',
  [ROLE_COLOURS.string]: 'ts',
  [ROLE_COLOURS.function]: 'tf',
  [ROLE_COLOURS.comment]: 'tc',
  [ROLE_COLOURS.tag]: 'tg',
  [ROLE_COLOURS.punctuation]: 'tp',
};
const PLAIN = ROLE_COLOURS.text;

export interface CodeHighlighter {
  readonly highlight: Highlighter;
  /** Inline styles that no class covered (empty with the themes as they are). */
  readonly unknownColours: () => string[];
}

/**
 * One Shiki per process: it holds only the grammars and themes, nothing of a request — and every instance keeps its compiled
 * grammars in the WebAssembly memory of the regex engine, which all instances share and nothing frees: a Shiki per boot (a test
 * run boots the app dozens of times) runs the engine out of memory.
 */
let shared: ReturnType<typeof createHighlighter> | undefined;

/** Shiki with the Marmeon theme; tokens as short classes instead of two inline colours each. */
export async function createCodeHighlighter(): Promise<CodeHighlighter> {
  shared ??= createHighlighter({ themes: [MARMEON_THEME], langs: [...LANGS] }).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  const shiki = await shared;
  const unknown = new Set<string>();

  const highlight: Highlighter = (code, lang) => {
    const requested = ALIASES[lang] ?? lang;
    const language = (LANGS as readonly string[]).includes(requested) ? requested : 'text';
    const html = shiki.codeToHtml(code.replace(/\n$/, ''), {
      lang: language,
      theme: 'marmeon',
    });
    return html
      .replace(/^<pre class="[^"]*" style="[^"]*" tabindex="0">/, `<pre class="code" tabindex="0" data-lang="${language}">`)
      .replace(/<span style="([^"]+)">([^<]*)<\/span>/g, (span, style: string, text: string) => {
        const colour = /^color:(#[0-9A-Fa-f]{6})$/.exec(style)?.[1];
        if (colour === PLAIN) return text;
        const name = colour && TOKEN_CLASSES[colour];
        if (name) return `<span class="${name}">${text}</span>`;
        unknown.add(style);
        return span;
      });
  };
  return { highlight, unknownColours: () => [...unknown] };
}
