# Mail

## Introduction

A mail is a class, like a controller: its data comes through the constructor, and `envelope()` and `content()` say who gets it
and what it says. `@marmeon/mail`, which every new app has, sends it over SMTP or writes it to the log in development:

```ts title="modules/notes/mail/NoteSharedMail.ts"
import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable } from '@marmeon/mail';

export class NoteSharedMail implements Mailable {
  readonly #recipient: { readonly email: string; readonly name: string };
  readonly #title: string;
  readonly #url: string;
  readonly #t: Translator;

  constructor(recipient: { readonly email: string; readonly name: string }, title: string, url: string, t: Translator) {
    this.#recipient = recipient;
    this.#title = title;
    this.#url = url;
    this.#t = t;
  }

  envelope() {
    return { to: { address: this.#recipient.email, name: this.#recipient.name }, subject: this.#t.get('notes.mail.shared.subject') };
  }

  content() {
    return mjml`<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>${this.#t.get('notes.mail.shared.intro', { title: this.#title })}</mj-text>
        <mj-button href="${this.#url}">${this.#t.get('notes.mail.shared.button')}</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  }
}
```

Inject the `Mailer` and queue the mail. The request goes on at once, and a worker sends it:

```ts
await this.#mailer.queue(new NoteSharedMail(recipient, note.title, url, this.#translators.for(recipient.locale)), { queue: 'mail' });
```

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `MAIL_MAILER` | `log` | `log` writes every mail to the log and sends nothing, `smtp` sends it, `array` keeps it in memory. |
| `MAIL_FROM_ADDRESS` | `hello@example.com` | The sender of every mail that names none. |
| `MAIL_FROM_NAME` | empty | The sender's name. Empty, the address goes alone. |
| `MAIL_HOST` | `127.0.0.1` | The SMTP server. |
| `MAIL_PORT` | `587` | Its port. |
| `MAIL_SECURE` | `false` | `true` speaks TLS from the first byte, for port 465. |
| `MAIL_REQUIRE_TLS` | `true` | Without `MAIL_SECURE`, the connection must be upgraded with STARTTLS. |
| `MAIL_USERNAME`, `MAIL_PASSWORD` | empty | The SMTP credentials. |

`smtp` needs nothing more: the package brings its SMTP client. A new app's `.env.test` sets `MAIL_MAILER=array`.

### The log mailer

`log` is the default in every environment. In development that is the point: the mail's text goes to the log, and you click its
links from there. Anywhere else it puts working password reset links into the log and leaves your users without their mails. So
outside development and tests the app warns at every start while `MAIL_MAILER` is `log`:

```text
MAIL_MAILER=log outside development and tests: no mail is sent — every mail is written to the log instead, its links and tokens (password reset, e-mail verification, signed URLs) in plain text. Set MAIL_MAILER=smtp and MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD.
```

It is a warning and not an error, since a deployment may route mails through its log on purpose. Set `MAIL_MAILER=smtp` in
production.

### SMTP and TLS

SMTP is encrypted or it fails. With `MAIL_SECURE=true` the connection speaks TLS from the start. Otherwise the transport upgrades
it with STARTTLS and requires the upgrade: a server that does not offer it, or someone on the way who strips the offer, gets no
credentials and no mail, and the send fails instead of going out in plain text. A queued mail then retries like any failed job.
`MAIL_REQUIRE_TLS=false` turns the requirement off, for a local server without TLS such as Mailpit, or a relay on the same
machine. Prefer port 465 with `MAIL_SECURE=true` where your provider offers it.

## Writing mails

`envelope()` returns `to` and `subject`, and optionally `from`, `cc`, `bcc`, `replyTo` and `headers`. An address is a string,
`'ada@example.com'`, or `{ address, name }`, and `to`, `cc` and `bcc` also take a list. Without `from`, the mail comes from
`MAIL_FROM_ADDRESS`. A mail without a recipient, an invalid address, or a line break in the subject, a name or a header fails
when the mail is composed: a line break there could add recipients.

`content()` returns one of three things:

- **`` mjml`…` ``**, compiled by [MJML](https://mjml.io) into HTML that mail clients render. Every value is escaped, and a nested
  `` mjml`…` `` or `` html`…` `` is kept, so a layout can be a function that takes the body. A mistyped tag is an `MjmlError`.
  The text version is made from the compiled HTML, or `fromMjml(body, { text })` gives your own.
- **`` html`…` ``**, the escaping template of `@marmeon/core`, which the mail package exports too. `fromHtml(body, text?)` adds a
  text version of your own. A link keeps its URL in the derived text.
- **`{ html, text }`**, both as you made them.

`envelope()`, `content()` and `attachments()` may each be `async`.

MJML is a library of its own. A new app has it, and an app without it gets `pnpm add mjml@^5` in the error of its first MJML mail.

The starter kit's mails share a frame: a function that returns `` mjml`…` `` and takes the translator and the body. Each mail
nests its own body into it:

```ts title="modules/auth/mail/layout.ts"
import type { Translator } from '@marmeon/i18n';
import { mjml, type Html } from '@marmeon/mail';

export function layout(t: Translator, { preview, body }: { preview: string; body: Html }) {
  return mjml`<mjml lang="${t.locale}">
  <mj-head>
    <mj-preview>${preview}</mj-preview>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>${body}</mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}
```

## Sending mails

| Method | What it does |
| --- | --- |
| `mailer.queue(mail, { queue?, delay?, connection? })` | Composes the mail now and queues it. A worker sends it. |
| `mailer.send(mail)` | Composes the mail and sends it now. |

Queue a mail whenever a request sends it:

- **The request never waits for the mail server**, and a server that is down never turns a registration into an error. The job
  tries five times, 10 seconds, a minute and five minutes apart, and then waits among the failed jobs for `queue:retry`.
- **The mail is composed when you queue it**, in the language of the translator you gave it and with its links. The worker only
  hands the finished message to the transport.
- **The job is encrypted** with `APP_KEY`, since a mail carries what only its recipient may see, such as a reset link. The jobs
  tables hold ciphertext only. Attachments travel inside it, so keep them small.
- **Inside a transaction**, a queued mail goes out only once the transaction commits. A registration that rolls back sends nothing.
- **A worker can send it twice**: one that dies after the mail server took the mail and before it marked the job done runs it
  again.

`queue()` needs `@marmeon/queue`, which every new app has, and a worker that takes the mail's queue. `queue:work` without
`--queue` takes every queue. The [queues](queues.md) page covers workers.

A token that must stay the same over the mail's retries, such as a password reset token, is made before the mail is queued. The
starter kit queues a job that makes the token and then queues the mail, so the request's answer takes the same time whether the
account exists or not.

### The recipient's language

A mail speaks its recipient's language, not the language of the request that caused it. Inside a request, the injected
`Translator` is the visitor's, and in a job there is no visitor at all. So pass the mail a translator from `Translators.for()`
with the recipient's stored locale, which falls back to `APP_LOCALE`. The
[localization](localization.md#translators-any-language-anywhere) page shows it.

## Links are absolute

A mail client has no page to resolve `/notes/7` against, and a mail composed in a worker has no request whose host could fill one
in. Composing a mail fails when a link or an image starts with `/`, `./`, `../` or `?`:

```text
NoteSharedMail links to "/notes/7" — a link in a mail must be absolute. Build it from APP_URL: new URL(path, config.url).href, or a signed URL with { base: config.url }.
```

Build every link from `APP_URL`, never from the request's `Host` header: `new URL(router.url('notes.show', { note: 7 }),
config.url).href`. A signed link takes `{ base: config.url }`, as the [URL generation](urls.md#absolute-urls) page shows.

## Attachments

`attachments()` returns a list of `{ filename, content, contentType? }`. `calendarEvent()` makes an `.ics` file that calendars
import:

```ts title="modules/notes/mail/NoteReminderMail.ts"
import { calendarEvent, html, type Mailable } from '@marmeon/mail';

export class NoteReminderMail implements Mailable {
  readonly #to: string;
  readonly #note: { readonly id: number; readonly title: string };
  readonly #at: Date;
  readonly #url: string;

  constructor(to: string, note: { readonly id: number; readonly title: string }, at: Date, url: string) {
    this.#to = to;
    this.#note = note;
    this.#at = at;
    this.#url = url;
  }

  envelope() {
    return { to: this.#to, subject: `Reminder: ${this.#note.title}` };
  }

  content() {
    return html`<p>A reminder for <a href="${this.#url}">${this.#note.title}</a>.</p>`;
  }

  attachments() {
    const end = new Date(this.#at.getTime() + 15 * 60_000);
    return [calendarEvent({ uid: `note-${this.#note.id}@notes.example`, summary: this.#note.title, start: this.#at, end, url: this.#url })];
  }
}
```

- **`calendarEvent(event)`** takes `uid`, `summary` and `start`, and `end`, `allDay`, `description`, `location`, `url`,
  `organizer`, `method`, `sequence` and `filename` as needed. The `uid` stays the same for every update of one event. A line
  break in a value that must be one line, such as the uid, an address or a link, is refused, so no value adds a property to the
  calendar entry.
- **`diskAttachment(disk, key, { filename }?)`** of `@marmeon/storage` reads a file of a disk as an attachment:
  `await diskAttachment(this.#storage.disk('local'), 'agendas/7.pdf')`. The [file storage](storage.md) page covers disks.

## Previews

In development, `/_marmeon/mail` lists every mail that has a `static preview()`, and `/_marmeon/mail/<module>/<Class>` shows one:
its subject, sender, recipients and attachments above the HTML. `?locale=de` shows it in another language, `?text` the text
version and `?raw` the HTML alone. A mail class takes part with a `static preview()`:

```ts
import { Factories } from '@marmeon/database';
import { Translators } from '@marmeon/i18n';
import type { MailPreviewContext } from '@marmeon/mail';
import { UserFactory } from '#modules/auth';

export class NoteSharedMail implements Mailable {
  // …

  static preview({ make, locale }: MailPreviewContext): NoteSharedMail {
    const { name, email } = make(Factories).for(UserFactory).make({ name: 'Ada Lovelace', email: 'ada@example.com' });
    return new NoteSharedMail({ name, email }, 'Groceries', 'https://notes.example/notes/1', make(Translators).for(locale));
  }
}
```

A preview builds its mail from sample data: `make()` of a factory, never `create()`, so nothing is written. The previews find
exported classes in `modules/<module>/mail/*.ts`.

The previews exist only with `NODE_ENV=development`, the rule of every development tool. They answer only `localhost`,
`127.0.0.1`, `[::1]` and the host of `APP_URL`, so a page on another site cannot reach them through DNS rebinding. The mail's HTML
is shown in a sandboxed frame, and no script of a template runs. The [devtools](devtools.md) link to them.

## Observation

In development the [devtools](devtools.md) record every mail that is sent or queued, with its secrets redacted. The
OpenTelemetry package counts a mail's recipients, never their addresses, as the [observability](observability.md) page explains.

## Testing

A test app replaces the `Mailer` with a fake. It still composes every mail, so a broken template, a relative link or an invalid
address fails the test, and it keeps sent and queued mails apart:

```ts title="modules/notes/share.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteSharedMail } from './mail/NoteSharedMail.ts';
import { NoteRepository } from './NoteRepository.ts';

it('mails the person a note is shared with', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.factory(UserFactory).create({ email: 'bob@example.com' });
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Groceries', body: '' });
  await app.actingAs(ada).post(`/notes/${note.id}/share`, { form: { email: 'bob@example.com' } }).assertRedirect();
  app.mail.assertQueued(NoteSharedMail, (mail, message, options) => message.to[0]!.address === 'bob@example.com' && options.queue === 'mail');
  app.mail.assertNothingSent();
});
```

`assertSent` on a queued mail fails and says the mail was queued. `assertQueuedCount`, `assertNotQueued`, `assertSentCount` and
`assertNotSent` check the rest. The fake does not put queued mails on the queue. The [fakes](fakes.md) page covers every
assertion.
