import { describe, expect, it } from 'vitest';
import { textFromHtml, withoutTags } from './html.ts';
import { fromMjml, mjml } from './mjml.ts';

// The regexes below are the reference: `textFromHtml`'s scans must give the same text on any input. The regexes themselves are
// quadratic or worse on long runs of tag starts (mail.timing.test.ts), which is why the code scans.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`', nbsp: ' ' };

function referenceTextFromHtml(markup: string): string {
  const marked = markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(div|span)\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const text = withoutTags(label).trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|section|header|footer)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ');
  const text = withoutTags(marked).replace(/&(#\d+|\w+);/g, (match, entity: string) => ENTITIES[entity] ?? (entity.startsWith('#') ? (Number(entity.slice(1)) <= 0x10ffff ? String.fromCodePoint(Number(entity.slice(1))) : match) : match));
  return text
    .split('\n')
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A small seeded generator keeps a failure reproducible.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  '<!--', '-->', '<!-->', '<a href="', '<A HREF="', '<a ', '<a>', '<abbr>', '<a\nhref="x"', 'href="', 'href=\'', '"', '>', '<', '</a>', '</A>', '</a >',
  '<style>', '<STYLE media="x">', '</style>', '</STYLE>', '<script>', '</script>', '<head>', '<header>', '</head>', '<title>', '</title>',
  '<div style="display:none">', '<DIV style="DISPLAY: none">', '<span style="display:\n none;">', '<span class="display:none"', '<div>', '</div>', '</span>',
  '<divider display:none>', '<li>', '<LI class="x">', '<li', '<link>', '</li>', '<ul>', '</ul>', '<p>', '</p>', '<br>', '<br />', 'display:none', 'display:', 'none',
  'https://example.test/x?a=1&amp;b=2', 'text', ' ', '\n', '\t', '&amp;', '&#65;', '&#99999999;', 'İ', 'ſ', 'K', ' ', ' ',
];

describe('textFromHtml', () => {
  it('equals the regex version on generated markup', () => {
    const next = random(20240607);
    for (let n = 0; n < 40_000; n++) {
      let markup = '';
      for (let length = 1 + Math.floor(next() * 14); length > 0; length--) markup += TOKENS[Math.floor(next() * TOKENS.length)]!;
      expect(textFromHtml(markup), JSON.stringify(markup)).toBe(referenceTextFromHtml(markup));
    }
  });

  it('equals the regex version on longer generated markup', () => {
    const next = random(7);
    for (let n = 0; n < 2_000; n++) {
      let markup = '';
      for (let length = 20 + Math.floor(next() * 80); length > 0; length--) markup += TOKENS[Math.floor(next() * TOKENS.length)]!;
      expect(textFromHtml(markup), JSON.stringify(markup)).toBe(referenceTextFromHtml(markup));
    }
  });

  it('equals the regex version on a rendered mjml mail and on every prefix and suffix of it', async () => {
    const { html } = await fromMjml(mjml`<mjml lang="en">
      <mj-head>
        <mj-preview>A link to choose a new password</mj-preview>
        <mj-attributes><mj-all font-family="Arial" /><mj-text font-size="15px" /></mj-attributes>
      </mj-head>
      <mj-body>
        <mj-section><mj-column>
          <mj-text>Hello Ada, <b>welcome</b> &amp; <i>thanks</i></mj-text>
          <mj-button href="https://app.test/reset-password?token=abc&email=ada%40example.com">Choose a new password</mj-button>
          <mj-text><ul><li>one</li><li class="x">two <a href="https://app.test/two">Two</a></li></ul></mj-text>
        </mj-column></mj-section>
        <mj-section><mj-column><mj-text align="center"><a href="https://app.test">https://app.test</a></mj-text></mj-column></mj-section>
      </mj-body>
    </mjml>`);
    expect(html).toContain('<!--[if mso');
    expect(textFromHtml(html)).toBe(referenceTextFromHtml(html));
    expect(textFromHtml(html)).toContain('Choose a new password (https://app.test/reset-password');
    // A mail cut anywhere is a mail with unclosed tags, comments and blocks.
    for (let cut = 0; cut < html.length; cut += 7) {
      expect(textFromHtml(html.slice(0, cut)), `prefix ${cut}`).toBe(referenceTextFromHtml(html.slice(0, cut)));
      expect(textFromHtml(html.slice(cut)), `suffix ${cut}`).toBe(referenceTextFromHtml(html.slice(cut)));
    }
  });
});
