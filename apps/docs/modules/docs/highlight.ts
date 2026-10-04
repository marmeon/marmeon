import { createHighlighter, type BundledLanguage } from 'shiki';

/** `code` in `lang` as a `<pre>` with highlighted, escaped markup — on the server only: the browser gets no highlighter. */
export type Highlighter = (code: string, lang: string) => string;

const LANGS = ['ts', 'tsx', 'js', 'json', 'sh', 'yaml', 'sql', 'diff', 'html', 'css'] as const satisfies readonly BundledLanguage[];
const ALIASES: Record<string, string> = { typescript: 'ts', javascript: 'js', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', yml: 'yaml' };

/**
 * The colours of GitHub's light theme → a class each; `styles/docs.css` gives each class its light and its dark colour
 * (github-dark). The plain text colour needs no span at all. A colour missing here keeps its inline style (`unknownColours`
 * lists them — a test keeps the list empty).
 */
export const TOKEN_CLASSES: Readonly<Record<string, string>> = {
  '#D73A49': 'tk', // keywords, operators
  '#6F42C1': 'tf', // functions, types
  '#032F62': 'ts', // strings
  '#6A737D': 'tc', // comments
  '#005CC5': 'tn', // constants, numbers, properties
  '#E36209': 'tv', // parameters
  '#22863A': 'tt', // JSX tags
};
const PLAIN = '#24292E';

export interface CodeHighlighter {
  readonly highlight: Highlighter;
  /** Inline styles that no class covered (empty with the themes as they are). */
  readonly unknownColours: () => string[];
}

/** Shiki with GitHub's light and dark themes; tokens as short classes instead of two inline colours each. */
export async function createCodeHighlighter(): Promise<CodeHighlighter> {
  const shiki = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: [...LANGS] });
  const unknown = new Set<string>();

  const highlight: Highlighter = (code, lang) => {
    const language = ALIASES[lang] ?? lang;
    const html = shiki.codeToHtml(code.replace(/\n$/, ''), {
      lang: (LANGS as readonly string[]).includes(language) ? language : 'text',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    });
    return html
      .replace(/^<pre class="[^"]*" style="[^"]*" tabindex="0">/, `<pre class="code" tabindex="0" data-lang="${language.replace(/[^\w-]/g, '')}">`)
      .replace(/<span style="([^"]+)">([^<]*)<\/span>/g, (span, style: string, text: string) => {
        const light = /--shiki-light:(#[0-9A-Fa-f]{6})/.exec(style)?.[1]?.toUpperCase();
        if (light === PLAIN) return text;
        const name = light && TOKEN_CLASSES[light];
        if (name) return `<span class="${name}">${text}</span>`;
        unknown.add(style);
        return span;
      });
  };
  return { highlight, unknownColours: () => [...unknown] };
}
