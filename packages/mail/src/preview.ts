import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Container, Key } from '@bespokecore/core';
import { escapeHtml } from './html.ts';
import { compose } from './mailer.ts';
import type { Address, Mailable, MailMessage } from './message.ts';

/** What a mail's `static preview()` gets: the container (a fresh scope) and the locale asked for (`?locale=de`). */
export interface MailPreviewContext {
  make<T>(key: Key<T>): T;
  /** The `locale` of the preview's URL — pass it to `Translators.for()`; undefined: the app's default. */
  readonly locale: string | undefined;
}

/**
 * A mail class with sample data — `static preview()` builds an instance (factory data, never real records: `make()`, not
 * `create()`), shown under `/_bespoke/mail/<module>/<Class>` in development (E106):
 *
 * ```ts
 * static preview({ make, locale }: MailPreviewContext) {
 *   return new VerifyEmailMail(make(Factories).for(UserFactory).make(), 'https://app.test/email/verify/1/abc', make(Translators).for(locale));
 * }
 * ```
 */
export interface PreviewableMail {
  readonly name: string;
  preview(context: MailPreviewContext): Mailable | Promise<Mailable>;
}

/** The previewable mails of an app: `modules/<module>/mail/*.ts`, every exported class with `static preview()` — by `<module>/<Class>`. */
export async function findMailPreviews(root: string): Promise<Map<string, PreviewableMail>> {
  const found = new Map<string, PreviewableMail>();
  const modules = await readdir(join(root, 'modules'), { withFileTypes: true }).catch(() => []);
  for (const module of modules.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(root, 'modules', module.name, 'mail');
    const files = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !/\.(test|type-test|d)\.ts$/.test(entry.name),
    );
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const exports = (await import(pathToFileURL(join(dir, file.name)).href)) as Record<string, unknown>;
      for (const value of Object.values(exports)) {
        if (typeof value !== 'function') continue;
        const mail = value as unknown as PreviewableMail;
        if (typeof mail.preview === 'function') found.set(`${module.name}/${mail.name}`, mail);
      }
    }
  }
  return found;
}

const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/**
 * The preview pages (E106) — only ever registered with `NODE_ENV=development` (E115). `GET /_bespoke/mail` lists the previewable mails,
 * `GET /_bespoke/mail/<module>/<Class>` shows one: subject, sender, recipients and attachments above the HTML (in a
 * sandboxed frame — no script of a template runs), `?text` the text version, `?raw` the HTML alone, `?locale=de` another
 * language. A name finds a mail in the list found at startup — never a file path from the URL.
 */
export class MailPreviews {
  readonly #root: string;
  readonly #container: Container;
  readonly #from: Address;
  #found: Promise<Map<string, PreviewableMail>> | undefined;

  constructor(root: string, container: Container, from: Address) {
    this.#root = root;
    this.#container = container;
    this.#from = from;
  }

  /** Found on first use (`bespoke dev` restarts on a change). */
  all(): Promise<Map<string, PreviewableMail>> {
    this.#found ??= findMailPreviews(this.#root);
    return this.#found;
  }

  async index(): Promise<Response> {
    const items = [...(await this.all()).keys()].map((name) => `<li><a href="/_bespoke/mail/${escapeHtml(name)}">${escapeHtml(name)}</a></li>`);
    const body = items.length > 0 ? `<ul>${items.join('')}</ul>` : '<p>No mail has a <code>static preview()</code> yet (<code>modules/&lt;module&gt;/mail/*.ts</code>).</p>';
    return page('Mail previews', `<h1>Mail previews</h1>${body}`);
  }

  async show(name: string, url: URL): Promise<Response> {
    const Mail = (await this.all()).get(name);
    if (!Mail) return new Response('No such mail preview.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    const wanted = url.searchParams.get('locale');
    const locale = wanted !== null && LOCALE.test(wanted) ? wanted : undefined;
    const scope = this.#container.createScope();
    const message = await compose(await Mail.preview({ make: (key) => scope.make(key), locale }), this.#from);
    // The HTML alone, in a tab of its own: sandboxed by its CSP like the frame — no script of the template runs on this origin.
    if (url.searchParams.has('raw')) return new Response(message.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox' } });
    if (url.searchParams.has('text')) return new Response(message.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    return page(`${name} — mail preview`, header(name, message, locale) + `<iframe sandbox title="${escapeHtml(message.subject)}" srcdoc="${escapeHtml(message.html)}"></iframe>`);
  }
}

function header(name: string, message: MailMessage, locale: string | undefined): string {
  const list = (addresses: MailMessage['to']) => addresses.map((to) => escapeHtml(to.name ? `${to.name} <${to.address}>` : to.address)).join(', ');
  const query = locale ? `&locale=${encodeURIComponent(locale)}` : '';
  const rows = [
    ['Subject', escapeHtml(message.subject)],
    ['From', list([message.from])],
    ['To', list(message.to)],
    ...(message.cc.length > 0 ? [['Cc', list(message.cc)]] : []),
    ...(message.attachments.length > 0 ? [['Attachments', message.attachments.map((attachment) => escapeHtml(attachment.filename)).join(', ')]] : []),
  ];
  return (
    `<p><a href="/_bespoke/mail">All previews</a> · <a href="?text${query}">Text</a> · <a href="?raw${query}">HTML only</a></p>` +
    `<h1>${escapeHtml(name)}</h1><table>${rows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}</table>`
  );
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light}body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;background:#fff;color:#111}a{color:#1d4ed8}th{text-align:left;padding-right:12px;color:#555}iframe{width:100%;height:75vh;border:1px solid #ccc;border-radius:6px;margin-top:12px;background:#fff}</style>
</head><body>${body}</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PREVIEW_CSP } });
}

/**
 * The preview page's own policy — an app's `contentSecurityPolicy()` leaves it alone (E147): no script at all, its inline style
 * and the mail's (the `srcdoc` frame inherits this policy), images and fonts as a mail client loads them, framed only here.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: http: https:',
  'font-src data: http: https:',
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');
