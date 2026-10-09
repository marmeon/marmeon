# @marmeon/mail

Mails as classes for Marmeon apps: an envelope and content in MJML or HTML, sending now or through the queue, attachments, and
previews in development.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

SMTP needs nothing more: `nodemailer` is a dependency of this package. MJML templates need `mjml`, an optional peer a new app has;
another app installs it with `pnpm add mjml@^5`. Without it, the first MJML mail names that command.

## A first mail

```ts title="modules/notes/mail/NoteReminderMail.ts"
import { html, type Mailable } from '@marmeon/mail';

export class NoteReminderMail implements Mailable {
  readonly #to: string;
  readonly #title: string;
  readonly #url: string;

  constructor(to: string, title: string, url: string) {
    this.#to = to;
    this.#title = title;
    this.#url = url;
  }

  envelope() {
    return { to: this.#to, subject: `Reminder: ${this.#title}` };
  }

  content() {
    return html`<p>A reminder for <a href="${this.#url}">${this.#title}</a>.</p>`;
  }
}
```

```ts
await this.#mailer.queue(new NoteReminderMail(user.email, note.title, url));
```

`MAIL_MAILER=log`, the default, writes every mail into the log; production sends with `smtp`.

## Documentation

- [Mail](https://github.com/marmeon/marmeon/blob/main/docs/mail.md)
- [Mail: sending mails](https://github.com/marmeon/marmeon/blob/main/docs/mail.md#sending-mails)
- [Mail: SMTP and TLS](https://github.com/marmeon/marmeon/blob/main/docs/mail.md#smtp-and-tls)
- [Mail: previews](https://github.com/marmeon/marmeon/blob/main/docs/mail.md#previews)
- [Fakes: mail](https://github.com/marmeon/marmeon/blob/main/docs/fakes.md#mail)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
