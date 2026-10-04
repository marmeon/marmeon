# @bespokecore/mail

Mails as classes (E29) — data through the constructor, `envelope()` and `content()` as methods, like a controller —,
transports behind a neutral `MailMessage` (no transport library's types in the API), MJML or HTML content, and since
Wave 6 **queued mails** (E105), a **preview** in development (E106), `.ics` attachments and a fake that keeps sent and queued
mails apart.

```ts
// modules/auth/mail/VerifyEmailMail.ts
export class VerifyEmailMail implements Mailable {
  constructor(user: User, url: string, t: Translator) { … }               // the language comes in — the recipient's
  envelope() { return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.verify.subject') }; }
  content() { return mjml`<mjml><mj-body>… <mj-button href="${this.#url}">${this.#t.get('auth.mail.verify.button')}</mj-button> …</mj-body></mjml>`; }
  // attachments() { return [calendarEvent({ … }), await diskAttachment(disk, 'invoices/7.pdf')]; }
  static preview(context: MailPreviewContext) { … }                       // /_bespoke/mail/auth/VerifyEmailMail (development)
}

// constructor(mailer: Mailer, translators: Translators)
await this.#mailer.queue(new VerifyEmailMail(user, url, this.#translators.for(user.locale)), { queue: 'mail' }); // composed now, sent by a worker
await this.#mailer.send(new VerifyEmailMail(user, url, t));                                                       // composed and sent now
```

```sh
MAIL_MAILER=log               # log (default: written to the log, nothing sent) | array (kept in memory) | smtp (pnpm add nodemailer)
MAIL_FROM_ADDRESS=hello@example.com
MAIL_FROM_NAME=
MAIL_HOST=127.0.0.1  MAIL_PORT=587  MAIL_SECURE=false  MAIL_USERNAME=  MAIL_PASSWORD=   # smtp; MAIL_SECURE=true: TLS from the first byte (465)
```

## Queued mails (E105)

`mailer.queue(mail, { queue, delay, connection })` **composes the mail now** — in the language of the translator it was given,
with its links — and queues the finished `MailMessage` as the framework job `bespoke.mail`; a worker hands it to the transport.

- **The request never waits for SMTP**, and a mail server that is down never turns a registration into a 500: the job retries
  (5 tries, 10 s / 1 min / 5 min apart), then waits in the failed jobs for `bespoke queue:retry`.
- **Encrypted:** a queued mail carries what only its recipient may see — a reset link, a signed verification link. The payload
  is encrypted with `APP_KEY`; `jobs` and `failed_jobs` hold ciphertext only. Attachments travel inside it (base64).
- **At-least-once** (E85): a worker that dies after the transport took the mail and before the acknowledgement sends it again.
- **Inside a transaction** (E107) it is a dispatch like any other: on the database queue a row in the transaction, else held
  until the commit — a rolled-back registration sends nothing.
- Needs `@bespokecore/queue` (an optional peer: without it `queue()` says what to install). The transport is built on first use —
  a web process that only queues mails never opens an SMTP connection.
- Tokens that must stay the same over the mail's retries (a reset token) are made **before** the mail is queued — the web app
  queues a job that makes the token and queues the mail (two hops), so the request's answer time does not depend on the account.

**The recipient's language, without a request:** `Translators.for(locale)` (`@bespokecore/i18n`) gives a fixed translator for any
supported locale (else `APP_LOCALE`) — injectable everywhere: a job, a command, a scheduled task, a notification's `toMail`.

## Links are absolute

A mail client has no page to resolve `/users/me` against, and a mail composed in a worker has no request whose host could fill one
in (nor should a `Host` header ever decide where a link points). `compose()` refuses relative `href`/`src` values with a `MailError`
("… a link in a mail must be absolute. Build it from APP_URL …") — for `send()` and `queue()` alike. Build links from the app's URL
(`new URL(path, config.url).href`, signed URLs with `{ base: config.url }`).

## Attachments

`attachments()` returns `{ filename, content, contentType? }`:

- **`calendarEvent({ uid, summary, start, end, url, … })`** — an `.ics` (RFC 5545): CRLF line ends, UTC times, text escaped,
  long lines folded at 75 octets; a line break in a value that must be one line (a uid, an address, a link) is refused — no value
  adds properties to the calendar entry.
- **`diskAttachment(disk, key, { filename })`** (`@bespokecore/storage`) — a file from a disk.

## Previews (E106)

`GET /_bespoke/mail` lists every mail class with a `static preview(context)` (in `modules/*/mail/*.ts`); `/_bespoke/mail/<module>/<Class>`
shows one — subject, sender, recipients, attachments above the HTML in a sandboxed frame (no script of a template runs);
`?locale=de`, `?text`, `?raw` (the HTML alone, sandboxed by its CSP too: no script of it runs on the app's origin). Previews build
their mail from factory data (`make()`, never `create()`). The routes are **registered only with `NODE_ENV=development`** (E115,
the devtools' gate — `bespoke dev` sets it) and have no middleware group (no session, no cookies); the devtools
(`/_bespoke/devtools`, `@bespokecore/devtools`) link to them. A name finds a mail in the list made at startup — never a file path
from the URL. A test that wants them runs as development: `createTestApp(App, { env: { NODE_ENV: 'development' } })`.

> **Upgrading from before Wave 7:** the previews were registered for every `NODE_ENV` but `production` ("not production"); since
> W7 step 8 only with `NODE_ENV=development`. A staging server, a test or a server without `NODE_ENV` has no `/_bespoke/mail` any
> more. The escaping `html` template moved to `@bespokecore/core` (`import { html } from '@bespokecore/core'`); this package
> re-exports it unchanged.

## Testing

`createTestApp()` puts a **`MailFake`** in place of the `Mailer` (`mail: 'fake'`, the default). Every mail is still composed —
a broken template, a relative link or an invalid address fails the test.

```ts
app.mail.assertQueued(VerifyEmailMail, (mail, message, options) => message.to[0]!.address === 'ada@example.com' && options.queue === 'mail');
app.mail.assertSent(WelcomeMail).assertNotSent(ResetPasswordMail).assertNothingQueued();   // also assertQueuedCount, assertSentCount, …
```

Sent (`send`) and queued (`queue`) mails are kept apart — `assertSent` on a queued mail fails with "(… was queued, not sent now —
assertQueued)". The fake does not put queued mails on the queue; to test the `bespoke.mail` job itself use
`createTestApp(app, { mail: 'real' })` with `MAIL_MAILER=array` and `app.queue.work()`.
