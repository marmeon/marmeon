# @marmeon/mail

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
  static preview(context: MailPreviewContext) { … }                       // /_marmeon/mail/auth/VerifyEmailMail (development)
}

// constructor(mailer: Mailer, translators: Translators)
await this.#mailer.queue(new VerifyEmailMail(user, url, this.#translators.for(user.locale)), { queue: 'mail' }); // composed now, sent by a worker
await this.#mailer.send(new VerifyEmailMail(user, url, t));                                                       // composed and sent now
```

`marmeon discover` registers its `MailServiceProvider` through the `"marmeon"` field of its package.json: the `Mailer` and the
`MailTransport` of `MAIL_MAILER` (built on first use — a web process that only queues mails never opens an SMTP connection;
SMTP connections are closed on shutdown), the framework job `marmeon.mail` when the app has `@marmeon/queue`, and — with
`NODE_ENV=development` only — the [previews](#previews-e106). Optional peers: `mjml` (for the `` mjml`…` `` template, `pnpm add mjml`),
`nodemailer` (for `smtp`), `@marmeon/queue` (for `mailer.queue()`), `@marmeon/router` (for the previews).

## Configuration

```sh
MAIL_MAILER=log               # log (default: written to the log, nothing sent) | array (kept in memory) | smtp (pnpm add nodemailer)
MAIL_FROM_ADDRESS=hello@example.com   # the default sender (default hello@example.com)
MAIL_FROM_NAME=               # its name (default: none — then the address alone)
MAIL_HOST=127.0.0.1  MAIL_PORT=587  MAIL_SECURE=false  MAIL_USERNAME=  MAIL_PASSWORD=   # smtp (these are the defaults)
MAIL_REQUIRE_TLS=true         # without MAIL_SECURE: STARTTLS or no mail (E192, default true)
```

`MAIL_SECURE=true` means TLS from the first byte (port 465). Otherwise the connection is upgraded with STARTTLS — and **required**
(E192): a server that does not offer it, or someone on the way who strips the offer, gets no credentials and no mail; the send fails
(the queued mail is retried like any failed job) instead of going out in plain text. `MAIL_REQUIRE_TLS=false` turns that off — only
for a local server without TLS (Mailpit on port 1025, a relay on the same machine); `SmtpTransport` takes `requireTls` the same way.
Use port 465 with `MAIL_SECURE=true` where the provider has it. `MailConfig`
(`config.mailer`, `config.from`, `config.smtp`, `config.previews`, `config.protected`) is the package's config class. The web
app's `.env.test` sets `MAIL_MAILER=array`.

> **`log` is the default in every environment — set `MAIL_MAILER` in production.** The log mailer sends nothing: it writes each
> mail's text to the log, its links and tokens (password reset, e-mail verification, signed URLs) in plain text — in development
> that is the point (the links are clicked from there), in production it puts working reset links into the log and leaves users
> without their mails. Where the app is protected (E139: `production`, `staging`, any `NODE_ENV` but `development` and `test`,
> and none) with `MAIL_MAILER=log` (or unset) the boot therefore warns once per process — `marmeon start --workers=N` once, in
> its primary — (`LOG_MAILER_WARNING`):
> `MAIL_MAILER=log outside development and tests: no mail is sent — every mail is written to the log instead, …`. It is a
> warning, not an error (like Laravel's `log` mailer, decided 04.10.): a deployment may route mails through the log on purpose.

## Mails

A `Mailable` has `envelope()` — `to`, `subject`, optionally `from` (else `MAIL_FROM_ADDRESS`), `cc`, `bcc`, `replyTo`,
`headers`; an address is `'ada@example.com'` or `{ address, name }` —, `content()` and optionally `attachments()`; each may be
async. `content()` returns:

- **`` mjml`…` ``** — every interpolated value escaped, nested `mjml`/`html` kept (a layout can be a function returning
  `mjml`); compiled by `mjml` with strict validation (a mistyped tag is a `MjmlError`), the text version derived from the
  compiled HTML — `fromMjml(body, { text })` gives one of your own.
- **`` html`…` ``** — the escaping template of `@marmeon/core` ([HTML](../core/README.md#html-the-escaping-html-template)),
  re-exported here; `fromHtml(body, text?)`, `textFromHtml(markup)` (links keep their URL in the text).
- **`{ html, text }`** — both as you made them.

`compose(mailable, from)` turns a mailable into the neutral `MailMessage` (`from`, `to`, `cc`, `bcc`, `replyTo`, `subject`,
`html`, `text`, `attachments`, `headers`) that transports send and the fake records.

## Queued mails (E105)

`mailer.queue(mail, { queue, delay, connection })` **composes the mail now** — in the language of the translator it was given,
with its links — and queues the finished `MailMessage` as the framework job `marmeon.mail`; a worker hands it to the transport.

- **The request never waits for SMTP**, and a mail server that is down never turns a registration into a 500: the job retries
  (5 tries, 10 s / 1 min / 5 min apart), then waits in the failed jobs for `marmeon queue:retry`.
- **Encrypted:** a queued mail carries what only its recipient may see — a reset link, a signed verification link. The payload
  is encrypted with `APP_KEY`; `jobs` and `failed_jobs` hold ciphertext only. Attachments travel inside it (base64). See
  [secrets in payloads](../queue/README.md#secrets-in-payloads-e105).
- **At-least-once** (E85): a worker that dies after the transport took the mail and before the acknowledgement sends it again.
- **Inside a transaction** (E107) it is a dispatch like any other: on the database queue a row in the transaction, else held
  until the commit — a rolled-back registration sends nothing ([what joins](../database/README.md#what-joins-what-does-not)).
- Needs `@marmeon/queue` (an optional peer: without it `queue()` says what to install). A worker must take the queue:
  `marmeon queue:work --queue=mail,default` (`make:docker`'s compose file and systemd unit do); a worker without it names the
  waiting `mail` queue in a warning ([which queues a worker takes](../queue/README.md#which-queues-a-worker-takes)).
- Tokens that must stay the same over the mail's retries (a reset token) are made **before** the mail is queued — the web app
  queues a job that makes the token and queues the mail (two hops), so the request's answer time does not depend on the account.

**The recipient's language, without a request:** `Translators.for(locale)` (`@marmeon/i18n`,
[`Translators`](../i18n/README.md#translators-any-locale-anywhere)) gives a fixed translator for any supported locale (else
`APP_LOCALE`) — injectable everywhere: a job, a command, a scheduled task, a notification's `toMail`.

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
- **`diskAttachment(disk, key, { filename })`** ([@marmeon/storage](../storage/README.md)) — a file from a disk.

## Previews (E106)

`GET /_marmeon/mail` lists every mail class with a `static preview(context)` (exported from `modules/<module>/mail/*.ts`);
`/_marmeon/mail/<module>/<Class>` shows one — subject, sender, recipients, attachments above the HTML in a sandboxed frame (no
script of a template runs); `?locale=de`, `?text`, `?raw` (the HTML alone, sandboxed by its CSP too: no script of it runs on the
app's origin). The pages bring their own Content-Security-Policy — no script at all, only their and the mail's inline styles,
framed only by the app's origin — which an app's [`contentSecurityPolicy()`](../http/README.md#content-security-policy-e147)
leaves alone (E147). Previews build their mail from factory data (`make()`, never `create()`):

```ts
static preview({ make, locale }: MailPreviewContext) {
  return new VerifyEmailMail(make(Factories).for(UserFactory).make(), 'https://app.test/email/verify/1/abc', make(Translators).for(locale));
}
```

The routes are **registered only with `NODE_ENV=development`** (E115, the devtools' gate — `marmeon dev` sets it,
[only in development](../devtools/README.md#only-in-development-e115-fail-closed)) and have no middleware group (no session, no
cookies); the devtools (`/_marmeon/devtools`) link to them. A name finds a mail in the list made at startup — never a file path
from the URL. A test that wants them runs as development: `createTestApp(App, { env: { NODE_ENV: 'development' } })`.

> **Upgrading from before Wave 7:** the previews were registered for every `NODE_ENV` but `production` ("not production"); since
> W7 step 8 only with `NODE_ENV=development`. A staging server, a test or a server without `NODE_ENV` has no `/_marmeon/mail` any
> more. The escaping `html` template moved to `@marmeon/core` (`import { html } from '@marmeon/core'`); this package
> re-exports it unchanged.

## Observation

Every mail goes through the `mail.send` channel of `@marmeon/core/diagnostics` while something listens
([the channels](../core/README.md#the-channels)) — `send`, `queue`, and the worker that sends a queued one: the devtools record it
(redacted, E125), OpenTelemetry counts recipients, never addresses.

## Testing

`createTestApp()` puts a **`MailFake`** in place of the `Mailer` (`mail: 'fake'`, the default). Every mail is still composed —
a broken template, a relative link or an invalid address fails the test.

```ts
app.mail.assertQueued(VerifyEmailMail, (mail, message, options) => message.to[0]!.address === 'ada@example.com' && options.queue === 'mail');
app.mail.assertSent(WelcomeMail).assertNotSent(ResetPasswordMail).assertNothingQueued();   // also assertQueuedCount, assertSentCount, …
```

Also `assertNotQueued`, `assertNothingSent`, and `sent(Class, filter?)` / `queued(Class, filter?)` for the entries themselves.
Sent (`send`) and queued (`queue`) mails are kept apart — `assertSent` on a queued mail fails with "(… was queued, not sent now —
assertQueued)". The fake does not put queued mails on the queue; to test the `marmeon.mail` job itself use
`createTestApp(app, { mail: 'real' })` with `MAIL_MAILER=array` and `app.queue.work()`. More in
[fakes](../testing/README.md#fakes).
