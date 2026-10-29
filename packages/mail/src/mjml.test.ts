import { Html } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { raw } from './html.ts';
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
  describe('images of a third party', () => {
    const doc = (head: string, body: string) => mjml`<mjml>${raw(head)}<mj-body><mj-section><mj-column>${raw(body)}</mj-column></mj-section></mj-body></mjml>`;
    const social = (attrs: string) => `<mj-social><mj-social-element name="facebook" href="https://example.test/p" ${attrs}>Share</mj-social-element></mj-social>`;
    const accordion = (attrs: string, elementAttrs = '') => `<mj-accordion ${attrs}><mj-accordion-element ${elementAttrs}><mj-accordion-title>T</mj-accordion-title><mj-accordion-text>X</mj-accordion-text></mj-accordion-element></mj-accordion>`;
    const carousel = (attrs: string) => `<mj-carousel ${attrs}><mj-carousel-image src="https://assets.example.test/a.png" /></mj-carousel>`;
    const own = 'https://assets.example.test/icon.png';

    it('refuses an mj-social-element without src', async () => {
      await expect(fromMjml(doc('', social('')))).rejects.toThrow(/Q7.*mj-social-element.*"facebook".*src/s);
    });

    it('refuses an mj-accordion without its icon urls', async () => {
      await expect(fromMjml(doc('', accordion('')))).rejects.toThrow(/Q7.*mj-accordion.*icon-wrapped-url/s);
      await expect(fromMjml(doc('', accordion(`icon-wrapped-url="${own}"`)))).rejects.toThrow(/mj-accordion.*icon-unwrapped-url/s);
    });

    it('refuses an mj-carousel without its icons', async () => {
      await expect(fromMjml(doc('', carousel('')))).rejects.toThrow(/Q7.*mj-carousel.*left-icon/s);
      await expect(fromMjml(doc('', carousel(`left-icon="${own}"`)))).rejects.toThrow(/mj-carousel.*right-icon/s);
    });

    it('treats an empty value as none', async () => {
      await expect(fromMjml(doc('', social('src=""')))).rejects.toThrow(/mj-social-element/);
      await expect(fromMjml(doc('', social('src="  "')))).rejects.toThrow(/mj-social-element/);
    });

    it('is not fooled by upper case', async () => {
      await expect(fromMjml(doc('', social('').replaceAll('mj-social-element', 'MJ-Social-Element')))).rejects.toThrow(/mj-social-element/);
    });

    it('renders with a source of its own', async () => {
      const { html } = await fromMjml(doc('', social(`src="${own}"`) + accordion(`icon-wrapped-url="${own}" icon-unwrapped-url="${own}"`) + carousel(`left-icon="${own}" right-icon="${own}"`)));
      expect(html).toContain(own);
      expect(html).not.toMatch(/mailjet|imgur/);
    });

    it('takes a source from mj-attributes, mj-all or an mj-class', async () => {
      const byTag = `<mj-head><mj-attributes><mj-social-element src="${own}" /><mj-accordion icon-wrapped-url="${own}" icon-unwrapped-url="${own}" /><mj-carousel left-icon="${own}" right-icon="${own}" /></mj-attributes></mj-head>`;
      const body = social('') + accordion('') + carousel('');
      expect((await fromMjml(doc(byTag, body))).html).not.toMatch(/mailjet|imgur/);

      const all = `<mj-head><mj-attributes><mj-all src="${own}" icon-wrapped-url="${own}" icon-unwrapped-url="${own}" left-icon="${own}" right-icon="${own}" /></mj-attributes></mj-head>`;
      expect((await fromMjml(doc(all, body))).html).not.toMatch(/mailjet|imgur/);

      const byClass = `<mj-head><mj-attributes><mj-class name="icon" src="${own}" /></mj-attributes></mj-head>`;
      expect((await fromMjml(doc(byClass, social('mj-class="icon"')))).html).not.toMatch(/mailjet|imgur/);

      const nested = `<mj-head><mj-attributes><mj-class name="icons"><mj-social-element src="${own}" /></mj-class></mj-attributes></mj-head>`;
      expect((await fromMjml(mjml`<mjml>${raw(nested)}<mj-body><mj-section><mj-column mj-class="icons">${raw(social(''))}</mj-column></mj-section></mj-body></mjml>`)).html).not.toMatch(/mailjet|imgur/);
    });

    it('takes the icons of an accordion from its elements', async () => {
      const { html } = await fromMjml(doc('', accordion('', `icon-wrapped-url="${own}" icon-unwrapped-url="${own}"`)));
      expect(html).not.toMatch(/imgur/);
      await expect(fromMjml(doc('', accordion(`icon-wrapped-url="${own}"`, `icon-unwrapped-url="${own}"`) + accordion('', `icon-wrapped-url="${own}"`)))).rejects.toThrow(/icon-unwrapped-url/);
    });

    it('still refuses when mj-attributes names another tag', async () => {
      await expect(fromMjml(doc(`<mj-head><mj-attributes><mj-image src="${own}" /></mj-attributes></mj-head>`, social('')))).rejects.toThrow(/mj-social-element/);
    });

    // A component of a later mjml that loads an image of its own would show here: nothing a bare document renders may name a host.
    it('renders every built-in component, bare, without a host of someone else', async () => {
      await fromMjml(doc('', '<mj-text>x</mj-text>')); // loads mjml, which fills the registry read below
      const core = createRequire(createRequire(import.meta.url).resolve('mjml'));
      const { components } = createRequire(core.resolve('mjml-core'))(core.resolve('mjml-core')) as { components: Record<string, { endingTag?: boolean }> };
      const rendered = new Set(['mj-body', 'mj-head', 'mj-attributes', 'mj-breakpoint', 'mj-html-attributes', 'mj-font', 'mj-preview', 'mj-style', 'mj-title', 'mj-hero', 'mj-button', 'mj-column', 'mj-divider', 'mj-group', 'mj-image', 'mj-raw', 'mj-section', 'mj-spacer', 'mj-text', 'mj-table', 'mj-wrapper', 'mj-social', 'mj-social-element', 'mj-navbar', 'mj-navbar-link', 'mj-accordion', 'mj-accordion-element', 'mj-accordion-text', 'mj-accordion-title', 'mj-carousel', 'mj-carousel-image']);
      const missing = Object.keys(components).filter((name) => !rendered.has(name));
      expect(Object.keys(components).length).toBeGreaterThan(20);
      expect(missing, 'a component this test does not know: render it bare and list it').toEqual([]);

      const withSources = doc('', social(`src="${own}"`) + accordion(`icon-wrapped-url="${own}" icon-unwrapped-url="${own}"`) + carousel(`left-icon="${own}" right-icon="${own}"`) + '<mj-image src="https://assets.example.test/i.png" />');
      const bare = mjml`<mjml><mj-head><mj-title>T</mj-title><mj-preview>P</mj-preview><mj-breakpoint width="320px" /><mj-style>.a{color:red}</mj-style></mj-head><mj-body><mj-wrapper><mj-section><mj-group><mj-column><mj-text>T</mj-text><mj-button href="https://example.test">B</mj-button><mj-divider /><mj-spacer /><mj-table><tr><td>c</td></tr></mj-table><mj-navbar><mj-navbar-link href="https://example.test">L</mj-navbar-link></mj-navbar><mj-raw><p>r</p></mj-raw></mj-column></mj-group></mj-section></mj-wrapper><mj-hero><mj-text>H</mj-text></mj-hero></mj-body></mjml>`;
      for (const { html } of [await fromMjml(bare), await fromMjml(withSources)]) {
        const hosts = [...html.matchAll(/(?:src=|srcset=|background=|url\()\\?["']?(https?:)?\/\/([^/"')\s]+)/g)].map((m) => m[2]).filter((host) => host !== 'assets.example.test');
        expect(hosts).toEqual([]);
      }
    });

    describe('hosts in the compiled HTML', () => {
      const withTestComponent = async (src: string, run: () => Promise<void>) => {
        await fromMjml(doc('', '<mj-text>x</mj-text>'));
        const core = createRequire(createRequire(import.meta.url).resolve('mjml'));
        const corePath = core.resolve('mjml-core');
        const { BodyComponent, registerComponent, components } = createRequire(corePath)(corePath);
        class TestImage extends BodyComponent {
          static componentName = 'mj-test-image';
          static dependencies = { 'mj-column': ['mj-test-image'], 'mj-test-image': [] };
          render() {
            return `<img src="${src}" alt="" />`;
          }
        }
        registerComponent(TestImage, { registerDependencies: true });
        try {
          await run();
        } finally {
          delete components['mj-test-image'];
          const validator = core.resolve('mjml-validator');
          const { dependencies } = createRequire(validator)(validator) as { dependencies: Record<string, string[]> };
          delete dependencies['mj-test-image'];
          dependencies['mj-column'] = (dependencies['mj-column'] ?? []).filter((name) => name !== 'mj-test-image');
        }
      };
      const page = (extra = '') => doc('', `<mj-test-image />${extra}`);

      it('refuses an image of a host the template does not name', async () => {
        await withTestComponent('https://tracker.example.test/pixel.png', async () => {
          await expect(fromMjml(page())).rejects.toThrow(/Q7.*https:\/\/tracker\.example\.test\/pixel\.png/s);
        });
      });

      it('compares the host exactly', async () => {
        await withTestComponent('https://a.co/pixel.png', async () => {
          await expect(fromMjml(page('<mj-image src="https://a.com/a.png" />'))).rejects.toThrow(/a\.co\/pixel/);
        });
      });

      it('does not count a host the template only writes or links to', async () => {
        await withTestComponent('https://cdn.example.test/pixel.png', async () => {
          await expect(fromMjml(page('<mj-text>see //cdn.example.test/x</mj-text>'))).rejects.toThrow(/cdn\.example\.test\/pixel/);
          await expect(fromMjml(page('<mj-button href="https://cdn.example.test/x">Go</mj-button>'))).rejects.toThrow(/cdn\.example\.test\/pixel/);
        });
      });

      it('does not count the base-url of an mj-navbar', async () => {
        await withTestComponent('https://cdn.example.test/pixel.png', async () => {
          await expect(fromMjml(page('<mj-navbar base-url="https://cdn.example.test"><mj-navbar-link href="/x">L</mj-navbar-link></mj-navbar>'))).rejects.toThrow(/cdn\.example\.test\/pixel/);
        });
      });

      it('reads a URL the way a browser does', async () => {
        for (const src of ['https://assets.example.test@evil.test/p.png', 'https:\\\\evil.test/p.png', 'HTTPS://EVIL.TEST/p.png', 'https:&#47;&#47;evil.test/p.png']) {
          await withTestComponent(src, async () => {
            await expect(fromMjml(page('<mj-image src="https://assets.example.test/a.png" />'))).rejects.toThrow(/evil\.test/i);
          });
        }
      });

      it('lets through a host the template names', async () => {
        await withTestComponent('https://assets.example.test/pixel.png', async () => {
          const { html } = await fromMjml(page('<mj-image src="https://assets.example.test/a.png" />'));
          expect(html).toContain('assets.example.test/pixel.png');
        });
      });

      it('lets through relative, data and cid URLs', async () => {
        for (const src of ['/pixel.png', 'img/pixel.png', 'data:image/png;base64,AAAA', 'cid:logo']) {
          await withTestComponent(src, async () => {
            expect((await fromMjml(page())).html).toContain(src);
          });
        }
      });
    });
  });
});
