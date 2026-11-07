import { describe, expect, it } from 'vitest';
import { rendersMail } from './content.ts';
import { compose } from './mailer.ts';
import { html } from './html.ts';
import { MailError, type Mailable, type MailContent } from './index.ts';
import { MjmlError, mjml } from './mjml.ts';

const RENDER = Symbol.for('marmeon.mail.render');

function mail(content: () => unknown): Mailable {
  return { envelope: () => ({ to: 'ada@example.com', subject: 'Hi' }), content: content as () => MailContent };
}

const send = (content: () => unknown) => compose(mail(content), 'hello@app.test');

describe('the render contract', () => {
  it('compiles an Mjml with the checks of its engine, not as plain HTML', async () => {
    const body = mjml`<mjml><mj-body><mj-section><mj-column><mj-social><mj-social-element name="facebook">Share</mj-social-element></mj-social></mj-column></mj-section></mj-body></mjml>`;
    await expect(send(() => body)).rejects.toThrow(MjmlError);
    await expect(send(() => body)).rejects.toThrow('Q7');
  });

  it('compiles an Mjml to table layout', async () => {
    const message = await send(() => mjml`<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>`);
    expect(message.html).toContain('<table');
    expect(message.html).not.toContain('<mj-');
  });

  it('renders a value that carries the contract through its method', async () => {
    const engine = { [RENDER]: async () => ({ html: '<p>from the engine</p>', text: 'from the engine' }) };
    const message = await send(() => engine);
    expect(message.html).toBe('<p>from the engine</p>');
    expect(message.text).toBe('from the engine');
  });

  it('still checks the links of what an engine returns', async () => {
    const engine = { [RENDER]: async () => ({ html: '<a href="/reset">Reset</a>', text: 'Reset' }) };
    await expect(send(() => engine)).rejects.toThrow(MailError);
  });

  it('refuses an engine that returns no strings', async () => {
    const engine = { [RENDER]: async () => ({ html: 1, text: 'x' }) };
    await expect(send(() => engine)).rejects.toThrow("template rendered no { html, text } strings");
  });

  it('derives the text of html``, keeps { html, text } and refuses null', async () => {
    expect((await send(() => html`<p>One</p>`)).text).toBe('One');
    const given = await send(() => ({ html: '<p>A</p>', text: 'B' }));
    expect(given.text).toBe('B');
    await expect(send(() => null)).rejects.toThrow(MailError);
  });
});

describe('Mjml', () => {
  it('carries the contract', () => {
    expect(rendersMail(mjml`<mjml></mjml>`)).toBe(true);
    expect(rendersMail(html`<p>x</p>`)).toBe(false);
  });
});
