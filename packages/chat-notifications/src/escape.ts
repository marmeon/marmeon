import { clean } from './message.ts';

/**
 * Escapes `text` for Slack's `mrkdwn`: `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`, so `<!channel>`, `<@U123>` and
 * `<url|label>` stay text. Use it for data inside the `text` of a block or an `mrkdwn` object of `raw.slack`. Bidirectional and
 * control characters (newline and tab stay) are removed first, lone surrogates replaced and line breaks turned into `\n`, like in
 * every neutral text. Escaping twice escapes twice.
 */
export function escapeSlackText(text: string): string {
  return clean(text).replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

/**
 * Escapes `text` for Discord's Markdown, so mentions, links, emphasis, spoilers, code, headings, lists and quotes stay text:
 * - a backslash before each of `\`, `*`, `_`, `~`, `|`, `<`, `[`, `]`, `(`, `)` and the backtick, anywhere;
 * - a backslash before the `:` of every `://`: an address in the text is shown as text, not a link (a link is a `links` entry);
 * - a zero width space after the `@` of `@everyone` and `@here`;
 * - a backslash before `#`, `-`, `>`, `+` and the dot of `1.` at the start of a line.
 *
 * Use it for data inside `raw.discord`. Bidirectional and control characters (newline and tab stay) are removed first, lone
 * surrogates replaced and line breaks turned into `\n`, like in every neutral text. Escaping twice escapes twice.
 */
export function escapeDiscordMarkdown(text: string): string {
  return (
    clean(text)
      // emphasis, strike, spoiler, code, mentions and masked links
      .replace(/[\\*_~`|<[\]()]/g, '\\$&')
      // a scheme separator: an address that touches a `<` must not swallow the escape and leave a live mention behind it
      .replaceAll('://', '\\://')
      // a group mention: it stays text even where a message allows mentions
      .replace(/@(?=everyone|here)/gi, '@\u200B')
      // block syntax at a line start: headings and subtext, lists, quotes
      .replace(/(^|\n)([ \t]*)(#|-|>|\+)/g, '$1$2\\$3')
      // an ordered list: the dot after the number
      .replace(/(^|\n)([ \t]*\d+)\./g, '$1$2\\.')
  );
}

/** A zero width space between `]` and `(` keeps `[label](https://…)` from becoming a masked link where Markdown is processed. @internal */
export function breakMaskedLinks(text: string): string {
  return text.replaceAll('](', ']\u200B(');
}
