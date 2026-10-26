import { describe, expect, it } from 'vitest';
import { Html, html, raw } from './html.ts';

describe('html and raw()', () => {
  it('html escapes what it interpolates and makes an Html', () => {
    const made = html`<p>${'<script>'}</p>`;
    expect(made).toBeInstanceOf(Html);
    expect(String(made)).toBe('<p>&lt;script&gt;</p>');
  });

  it('raw() keeps the markup as given', () => {
    const made = raw('<b>x</b>');
    expect(made).toBeInstanceOf(Html);
    expect(String(made)).toBe('<b>x</b>');
  });

  it('refuses a construction without the key', () => {
    expect(() => Reflect.construct(Html, ['<b>x</b>'])).toThrow(TypeError);
    class Forged extends (Html as any) {
      constructor(markup: string) {
        super(markup);
      }
    }
    expect(() => new Forged('<b>')).toThrow(TypeError);
  });

  it('does not trust an object that only looks like an Html', () => {
    const forged = Object.assign(Object.create(Html.prototype), { toString: () => '<script>' });
    expect(() => html`<p>${forged}</p>`).toThrow(TypeError);
  });

  it('does not escape a nested Html again', () => {
    expect(String(html`<p>${raw('<b>x</b>')}${html`<i>${'&'}</i>`}</p>`)).toBe('<p><b>x</b><i>&amp;</i></p>');
  });
});
