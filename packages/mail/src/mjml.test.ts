import { Html } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { fromMjml, Mjml, mjml } from './mjml.ts';

describe('mjml', () => {
  it('makes an Mjml that is an Html', () => {
    const made = mjml`<mjml></mjml>`;
    expect(made).toBeInstanceOf(Mjml);
    expect(made).toBeInstanceOf(Html);
  });

  it('refuses a construction without the template', () => {
    expect(() => Reflect.construct(Mjml, ['<x>'])).toThrow(TypeError);
    class Forged extends (Mjml as any) {
      constructor(markup: string) {
        super(markup);
      }
    }
    expect(() => new Forged('<x>')).toThrow(TypeError);
  });

  describe('web fonts', () => {
    it('imports no font for a family the template names', async () => {
      const { html } = await fromMjml(mjml`<mjml><mj-head><mj-attributes><mj-all font-family="Roboto, Open Sans, sans-serif" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`);
      expect(html).toContain('Roboto');
      expect(html).not.toContain('@import');
      expect(html).not.toContain('googleapis');
      expect(html).not.toContain('fonts.');
    });

    it('does not carry the font of one mail into the next', async () => {
      const first = await fromMjml(mjml`<mjml><mj-head><mj-font name="Brand" href="https://assets.example.test/brand.css" /><mj-attributes><mj-all font-family="Brand, sans-serif" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`);
      expect(first.html).toContain('assets.example.test');
      const second = await fromMjml(mjml`<mjml><mj-head><mj-attributes><mj-all font-family="Brand, sans-serif" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`);
      expect(second.html).not.toContain('assets.example.test');
    });

    it('keeps an mj-font the app writes', async () => {
      const { html } = await fromMjml(mjml`<mjml><mj-head><mj-font name="Brand" href="https://assets.example.test/brand.css" /><mj-attributes><mj-all font-family="Brand, sans-serif" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`);
      expect(html).toContain('https://assets.example.test/brand.css');
    });
  });
});
