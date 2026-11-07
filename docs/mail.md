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
| `MAIL_DRIVER` | `log` | `log` writes every mail to the log and sends nothing, `smtp` sends it, `array` keeps it in memory. A package can bring more (see [Mail transports](drivers.md#mail-transports)); a name nobody brought stops the start. |
| `MAIL_FROM_ADDRESS` | optional, falls back to `hello@example.com` | The sender of every mail that names none. Set it to an address of your domain; see [The sender address](#the-sender-address). |
| `MAIL_FROM_NAME` | empty | The sender's name. Empty, the address goes alone. |
| `MAIL_HOST` | `127.0.0.1` | The SMTP server. |
| `MAIL_PORT` | `587` | Its port. |
| `MAIL_SECURE` | `false` | A switch (`true`, `false`, `1` or `0`). `true` speaks TLS from the first byte, for port 465. |
| `MAIL_REQUIRE_TLS` | `true` | A switch like `MAIL_SECURE`. Without `MAIL_SECURE`, the connection must be upgraded with STARTTLS. |
| `MAIL_USERNAME`, `MAIL_PASSWORD` | empty | The SMTP credentials. |

`smtp` needs nothing more: the package brings its SMTP client. A new app's `.env.test` sets `MAIL_DRIVER=array`.

### The log mailer

`log` is the default in every environment. In development that is the point: the mail's text goes to the log, and you click its
links from there. Anywhere else it leaves your users without their mails, so outside development and tests the app warns at every
start while `MAIL_DRIVER` is `log`, and the log line holds only the recipients and the subject, with a note that the text is left
out (it can hold password reset and sign-in links, and whoever reads the log may not be allowed to use them). That goes for mails
sent in a queue worker too:

```text
MAIL_DRIVER=log outside development and tests: no mail is sent — only each mail's recipients and subject are written to the log, its text is left out. Set MAIL_DRIVER=smtp and MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD.
```

It is a warning and not an error. Set `MAIL_DRIVER=smtp` in production. A deployment that wants its mails in a log or a file
on purpose writes its own transport ([Mail transports](drivers.md#mail-transports)).

### The sender address

Without `MAIL_FROM_ADDRESS` mail goes out from `hello@example.com`, which receiving servers reject or file as spam. Outside
development and tests the app warns once at start when the variable is not set:

```text
MAIL_FROM_ADDRESS is not set: mail goes out from hello@example.com, which receiving servers reject or file as spam. Set it to an address of your domain.
```

With `MAIL_DRIVER=log` the line ends with "(MAIL_DRIVER=log: no mail is sent.)", and the warning appears all the same. It is a
warning and not an error: without SMTP the default does no harm. Development and tests stay quiet.

### SMTP and TLS

SMTP is encrypted or it fails. With `MAIL_SECURE=true` the connection speaks TLS from the start. Otherwise the transport upgrades
it with STARTTLS and requires the upgrade: a server that does not offer it, or someone on the way who strips the offer, gets no
credentials and no mail, and the send fails instead of going out in plain text. A queued mail then retries like any failed job.
`MAIL_REQUIRE_TLS=false` turns the requirement off, for a local server without TLS such as Mailpit, or a relay on the same
machine. With it, credentials and mails go in plain text whenever the server offers no STARTTLS, so never use it over a network you
do not control. Prefer port 465 with `MAIL_SECURE=true` where your provider offers it.

## Writing mails

`make:mail` writes a mail class with a preview, its view, and a frame for it when the module has none:

```sh
pnpm marmeon make:mail NoteShared --module=notes
```

In an app with `@marmeon/react` it creates `modules/notes/mail/NoteSharedMail.ts` (`Mail` is added to the name), the view
`NoteSharedView.tsx` and the frame `Layout.tsx`; without it, the mail and a template frame `layout.ts`. It never overwrites a file: the
mail and the view need `--force` (and are written together or not at all), and a frame that is there stays. The class has the
`envelope()`, a `content()` that renders the view and a `static preview()`; it takes the recipient and a translator for the
recipient's language. A mail is found by its folder, so the module's `index.ts` stays as it is. The command needs `@marmeon/mail` and
`@marmeon/i18n` in the app's dependencies, and, for a React view, `oxc-transform` as a development dependency (the command warns when it is
missing); `/_marmeon/mail/notes/NoteSharedMail` previews the result in development.

Three options choose the form:

| Option | Writes |
| --- | --- |
| none | A React view and `Layout.tsx` in an app that has `@marmeon/react`, the template form otherwise. |
| `--template` | The template form in any app: `` mjml`…` `` in the class and a template frame `mail/layout.ts`. |
| `--html` | A class whose `content()` is `` html`…` ``, with no frame. It cannot be combined with `--layout` or `--template`. |

When the module has a template `layout.ts` and no `Layout.tsx`, the view renders only the body and the class nests it,
`layout(t, { preview, body: toMjml(NoteSharedView, props) })`; the template frame stays the module's frame.

`envelope()` returns `to` and `subject`, and optionally `from`, `cc`, `bcc`, `replyTo` and `headers`. An address is a string,
`'ada@example.com'`, or `{ address, name }`, and `to`, `cc` and `bcc` also take a list. Without `from`, the mail comes from
`MAIL_FROM_ADDRESS`. A mail without a recipient, an invalid address, or a line break in the subject, a name or a header fails
when the mail is composed: a line break there could add recipients.

`content()` returns one of four things:

- **A React view**, `toMjml(OrderView, props)` from `@marmeon/react/mail` — the recommended way: a component renders the mail, and
  [Mail views in React](#mail-views-in-react) shows how. It becomes MJML like the next one, with the same checks.
- **`` mjml`…` ``**, compiled by [MJML](https://mjml.io) into HTML that mail clients render. Every value is escaped, and a nested
  `` mjml`…` `` or `` html`…` `` is kept, so a layout can be a function that takes the body. A mistyped tag is an `MjmlError`.
  The text version is made from the compiled HTML, or `fromMjml(body, { text })` gives your own. This is the way without React.
- **`` html`…` ``**, the escaping template of `@marmeon/core`, which the mail package exports too — the fallback for a mail that
  needs no table layout. `fromHtml(body, text?)` adds a text version of your own. A link keeps its URL in the derived text.
- **`{ html, text }`**, both as you made them.

`envelope()`, `content()` and `attachments()` may each be `async`.

Mails load no web font by themselves, even when a `font-family` names one such as Roboto: opening a mail would call the font's host. Add an `<mj-font name="…" href="…" />` to the `<mj-head>` to use one, with a source you may load; the starter kit's frame uses system fonts.

Some MJML components would load an image from a host of someone else when you give them none: `mj-social-element` without `src` (icons from Mailjet), `mj-accordion` without `icon-wrapped-url` and `icon-unwrapped-url`, and `mj-carousel` without `left-icon` and `right-icon` (Imgur). A mail that leaves one of these out fails with an `MjmlError` (Q7) naming the component and the attribute, instead of calling that host in every opened mail. Set the attribute on the tag, in `mj-attributes` (a tag, `mj-all` or an `mj-class`), to an image you serve. As a second check, the compiled HTML may load from the hosts your template itself loads from (an image `src`, a `background-url`, an `mj-font`; a link or text does not count) and no other; an image from any other host, whatever brings it, is refused with Q7 and the URL. Relative, `data:` and `cid:` URLs are fine.

MJML is a library of its own. A new app has it, and an app without it gets `pnpm add mjml@^5` in the error of its first MJML mail.

The starter kit's mails share a frame: a function that returns `` mjml`…` `` and takes the translator and the body. Each mail
nests its own body into it. Here is a shorter version of its `layout.ts`, without the styles and the footer:

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

### One frame for several modules

`make:mail` writes a frame into every module it makes a mail for, as long as that module has none: `mail/Layout.tsx` for a React
view, `mail/layout.ts` for a template. An app whose modules all send mail would have as many frames as modules, and a change of the
brand colour would be made in each. To share one, keep it in a module the others may import, such as `ui`, and export it through that
module's entry:

```ts title="modules/ui/index.ts"
export { Layout } from './mail/Layout.tsx';
```

`modules/ui/mail/Layout.tsx` is the component `marmeon make:mail <Name> --module=ui` writes: it takes `t`, a `preview` and the
`children` the view puts into it. Then name that module when you make the mails of the others:

```sh
pnpm marmeon make:mail NoteShared --module=notes --layout=ui
```

It writes only the mail and its view, and the view imports the frame from the other module; `notes` gets no frame of its own:

```tsx title="modules/notes/mail/NoteSharedView.tsx"
import { Layout } from '#modules/ui';
```

A template frame is shared the same way, with `export { layout } from './mail/layout.ts';` in the entry: the mail then imports
`layout` instead, and its view is the body (above). A module that has both is used through `Layout.tsx`.

`--layout` takes the name of a module that exists; naming the mail's own module is the same as leaving the option out. The command
does not search for "the" frame and remembers none: every mail names it. If `modules/ui/index.ts` does not export the frame, the mail is
written anyway and the command prints the line above for you to add; it never edits another module's entry. If `ui` has no
`mail/Layout.tsx` or `mail/layout.ts` either, nothing is written and the command says to make a mail in `ui` first. With `--template`
only a `layout.ts` counts as a frame.

A mail class is found by its folder, so `modules/ui/mail/` is scanned for previews like any other, and a file with a function only
adds none.

## Mail views in React

A mail can be a React component. The class stays a `.ts` file, the view is a `.tsx` file next to it, and `toMjml` renders the view to
the same MJML that a template would hold:

```tsx title="modules/notes/mail/NoteSharedView.tsx"
import type { Translator } from '@marmeon/i18n';
import { MjmlBody, MjmlButton, MjmlColumn, MjmlDocument, MjmlSection, MjmlText } from '@marmeon/react/mail';

export function NoteSharedView({ t, title, url }: { t: Translator; title: string; url: string }) {
  return (
    <MjmlDocument lang={t.locale}>
      <MjmlBody>
        <MjmlSection paddingTop={24}>
          <MjmlColumn>
            <MjmlText>{t.get('notes.mail.shared.intro', { title })}</MjmlText>
            <MjmlButton href={url}>{t.get('notes.mail.shared.button')}</MjmlButton>
          </MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}
```

```ts title="modules/notes/mail/NoteSharedMail.ts"
import type { Translator } from '@marmeon/i18n';
import type { Mailable } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { NoteSharedView } from './NoteSharedView.tsx';

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
    return toMjml(NoteSharedView, { t: this.#t, title: this.#title, url: this.#url });
  }
}
```

Pass the view and its props, `toMjml(View, props)`, not a call of it: the props are the signature of your view, and a view that
uses hooks in its own body runs inside React's renderer only that way. Inside a `.tsx`, `toMjml(<NoteSharedView … />)` takes the
element too. The result is a `Mjml`, so everything that follows from a template holds for a view: the mail compiles with strict
validation when it is sent, a component that would load an image from a host of someone else is refused with Q7, a relative link is
refused, and the text version is derived from the HTML. A view may be the body of a frame instead of a whole mail: it then renders the
tags inside `<mj-body>`, and the frame nests it, `layout(t, { preview, body: toMjml(NoteSharedView, props) })`.

Mail views live in `modules/<module>/mail/`. That is where the server compiles `.tsx` files, so a view is never client code, and
Vite refuses a page that imports `@marmeon/react/mail` or `@marmeon/mail` as a value ([Server code in the
browser](vite.md#server-code-in-the-browser)). A mail view is TSX that Node cannot read by itself: the server compiles it with
`oxc-transform`, which an app that has mail views installs as a development dependency (`pnpm add -D oxc-transform`), and
`marmeon build` compiles the views ahead of time, so a production start loads no transformer. The compiler reads the `jsx` setting
of your `tsconfig.json`: `react-jsx` and `react-jsxdev` both compile as `react-jsx`, since a mail needs no development helpers, and
any other `jsx` mode is refused.

### The components

The components are MJML's tags under the names of the tags (`mj-text` is `MjmlText`; the root `mjml` is `MjmlDocument`, because `Mjml` is the class of `@marmeon/mail`), and every one has the props of
its tag, written in camelCase (`paddingTop` is `padding-top`), with each `MjmlXProps` type exported next to it:

| Components | MJML tags |
| --- | --- |
| `MjmlDocument`, `MjmlHead`, `MjmlBody` | The root, `mj-head` and `mj-body` |
| `MjmlTitle`, `MjmlPreview`, `MjmlFont`, `MjmlBreakpoint`, `MjmlStyle` | What the head holds |
| `MjmlAttributes`, `MjmlAll`, `MjmlClass`, `MjmlHtmlAttributes`, `MjmlHtmlAttribute`, `MjmlSelector` | Defaults, classes and HTML attributes in the head |
| `MjmlWrapper`, `MjmlSection`, `MjmlGroup`, `MjmlColumn`, `MjmlHero` | Layout |
| `MjmlText`, `MjmlButton`, `MjmlImage`, `MjmlDivider`, `MjmlSpacer`, `MjmlTable`, `MjmlRaw` | Content |
| `MjmlSocial`, `MjmlSocialElement`, `MjmlNavbar`, `MjmlNavbarLink` | Social links and navigation |
| `MjmlAccordion`, `MjmlAccordionElement`, `MjmlAccordionTitle`, `MjmlAccordionText`, `MjmlCarousel`, `MjmlCarouselImage` | Accordion and carousel |

A number is `px` wherever a value has a unit, the props typed `string | number`: `paddingTop={8}` is `padding-top="8px"`. A number
for any other prop throws a `TypeError` (`fontWeight` takes `'700'`), and so does `lineHeight={1.5}`: it is a string (`'1.5'` or `'24px'`). `fullWidth` and `inline` write the attribute
when `true` and leave it out when `false`. The two ways to name a class are `cssClass` (`css-class`) and `mjmlClass` (`mj-class`);
`className` throws, so there is one way. `MjmlAll` and `MjmlClass` take any attribute. There is no component for `mj-include` (it
reads a file of the server), and none that writes a comment or an HTML tag of any name: markup of your own goes into `MjmlRaw`.

A few attributes of MJML have no prop yet: `gutter` on `mj-section` and `mj-wrapper`, `border` on `mj-social` and
`mj-social-element`, `dir` on `mjml`. An attribute a component does not know fails the strict validation when the mail is sent.

### What React escapes

React escapes every text and every attribute value: a name that holds `<img src="https://tracker.example/p.gif">` or a `"` arrives
as text, in a child and in an attribute alike. Only two places write what you give them as it is, which is `raw()` of the templates:
`MjmlRaw` with `dangerouslySetInnerHTML`, and the child of `MjmlStyle`, one string of CSS, which holds no `<` (CSS needs none, and `</mj-style>` would let the rest in as markup; a `<` throws a `TypeError`). Put into them only markup and CSS that
you wrote, never data. No other component takes `dangerouslySetInnerHTML`, also not through `{...data}`; it throws a `TypeError`, as
does anything but one string as the child of `MjmlStyle`.

React moves a JSX `<title>`, `<meta>` or `<link>` out of the tree, in front of the root, where MJML drops it without a word. It does so
also from inside `MjmlRaw`, and it adds a `<link>` to preload a JSX `<img>`. `toMjml` throws an `MjmlError` when the view's markup does
not start with `<mjml` or an `<mj-` tag, or when anything comes in front of `<MjmlDocument>`. Use `MjmlTitle` for the title, an
`MjmlRaw` with `dangerouslySetInnerHTML={{ __html: '<meta …>' }}` for a `<meta>` or `<link>`, and `MjmlImage` for an image.

### Hooks, context and Suspense

A view is rendered by React, so `useState`, `useContext` and a context provider around the view work. `Suspense` renders its
fallback and nothing else: the render does not wait, so load the data before `toMjml` and pass it in.

### The library under the components

The components stand on `@faire/mjml-react`, in a version Marmeon pins exactly. Your app never installs or imports it, and the API is
that of `@marmeon/react/mail`: the names, the prop types and the checks above are Marmeon's own, so replacing the library is no
change an app has to follow. [Releases](releases.md#libraries-the-framework-builds-on) lists what is promised.

## Sending mails

| Method | What it does |
| --- | --- |
| `mailer.queue(mail, { queue?, delay?, connection? })` | Composes the mail now and queues it. A worker sends it. `delay` is seconds, or a [`Duration`](time.md#spans-of-time). |
| `mailer.send(mail)` | Composes the mail and sends it now. Resolves with the message and the `messageId` the provider gave it. |

`messageId` is the id the transport got from the mail server, such as the `Message-ID` that `smtp` sends. It is `undefined` with `log`
and `array`, where no provider takes part, and with a provider that gives none. `mailer.queue()` has no id to return: the worker
sends the mail later.

```ts
const { messageId } = await this.#mailer.send(new ReceiptMail(order, t));
await this.#orders.update(order.id, { receiptMessageId: messageId });
```

Queue a mail whenever a request sends it:

- **The request never waits for the mail server**, and a server that is down never turns a registration into an error. The job
  tries five times, waiting 10 seconds, a minute, then five minutes before each further try, and then waits among the failed
  jobs for `queue:retry`. Each try may take 30 seconds at most.
- **The mail is composed when you queue it**, in the language of the translator you gave it and with its links. The worker only
  hands the finished message to the transport.
- **The job is encrypted** with `APP_KEY`, since a mail carries what only its recipient may see, such as a reset link. The jobs
  tables hold ciphertext only. Attachments travel inside it, so keep them small.
- **Inside a transaction**, a queued mail goes out only once the transaction commits. A registration that rolls back sends nothing.
- **A worker can send it twice**: one that dies after the mail server took the mail and before it marked the job done runs it
  again.

`queue()` needs `@marmeon/queue`, which every new app has, and a worker that takes the mail's queue. `queue:work` without
`--queue` takes every queue. The [queues](queues.md#running-workers) page covers workers.

`mailer.queue()` resolves with the composed message only: no job id, no `messageId`, and no word when the mail is sent or fails for good.
A mail whose outcome the app keeps, such as a delivery log, is sent by a job of its own that calls `mailer.send()`. Its payload is the id of a log row that is
written with the request's change, so a rollback takes the row with it. The job sets the row to `sent` with the `messageId`, and its
`failed()` tries to close the log (`failed`). A worker that dies first, or a `failed()` that throws or times out, leaves the row open,
so look for rows that stay unsent. A job runs at least once, so it skips the send when the row is already `sent`; a crash between the send and the update can still send twice, as [When a job fails for good](queues.md#when-a-job-fails-for-good) shows.

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
in. Composing a mail fails when the `href` or `src` of a link or an image has no scheme, such as `https:`, `mailto:`, `tel:` or
`cid:`. That covers `/notes/7`, `notes/7`, `?page=2` and `//app.test/notes/7` alike. Only a link to a place in the mail itself,
such as `#top`, needs none:

```text
NoteSharedMail links to "/notes/7" — a link in a mail must be absolute. Build it from APP_URL: new URL(path, config.url).href, or a signed URL with { base: config.url }.
```

Build every link from `APP_URL`, never from the request's `Host` header. With the injected `AppConfig` as `app`:
`new URL(router.url('notes.show', { note: 7 }), app.url).href`. A signed link takes `{ base: app.url }`, as the
[URL generation](urls.md#absolute-urls) page shows.

## Leaving a list with one click

A mail that a list sends carries two headers, so that the mail client can offer an "Unsubscribe" button that posts at once
(RFC 8058). Put the link into `envelope()` and, so the reader finds it too, into the text, where it opens a page with a button (the link in the text is a `GET`, the mail client's post is a `POST`):

```ts
envelope() {
  return {
    to: this.#to,
    subject: 'Your digest',
    headers: { 'List-Unsubscribe': `<${this.#unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
```

`#unsubscribe` is an absolute link from `foreverSignedRoute()`, and its route says
[`signed({ forever: true, withoutCsrf: true })`](csrf.md#a-link-in-a-mail-that-posts), because the mail client posts without a
token. Sign the mail with DKIM over both headers (`h=` names `list-unsubscribe` and `list-unsubscribe-post`): mailbox providers
show the button only for a mail whose sender they can tie to those headers. The `https` link is the one the client posts to.

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
  `await diskAttachment(this.#storage.disk('local'), 'agendas/7.pdf')`. The [file storage](storage.md#using-a-disk) page covers
  disks.

## Lists and stored templates

A list in `` html`…` `` or `` mjml`…` `` is joined without a separator, and each element is escaped on its own, so a loop over
`` html`…` `` or `` mjml`…` `` pieces gives one block per item:

```ts
mjml`<mj-text>
  ${paragraphs.map((text) => mjml`<p>${text}</p>`)}
</mj-text>`;
```

A plain string in the list is escaped like any other value, a nested `` html`…` `` or `` mjml`…` `` is kept, and `null`,
`undefined` and `false` leave nothing behind, so `${isNew && mjml`<p>Welcome</p>`}` works. A list of strings runs together
without a space or a line break: put the separator into the element.

To show a template an app stores, for example in a database table an editor writes to, compile it with `fromMjml()` on a page
of the app. `raw()` keeps the stored markup as it is, so it must come from people you trust, never from a guest:

```ts
import { fromMjml, html, mjml, raw } from '@marmeon/mail';

const { html: body } = await fromMjml(mjml`${raw(template.source)}`);
const frame = html`<iframe sandbox title="Preview" srcdoc="${body}"></iframe>`;
```

An `html` template escapes the mail's HTML for the `srcdoc` attribute, and `sandbox` without values keeps scripts, forms and
the page's origin away from it. A template with a mistake in it fails with an `MjmlError`. The preview under `/_marmeon/mail`
shows only mail classes with a `static preview()`, not a stored template.

The frame's document runs under the Content-Security-Policy of the page that holds it, because a `srcdoc` document inherits it, and
`sandbox` does not change that. A mail brings its styles inline. A page with `styleSrc: ["'self'"]` and no `'unsafe-inline'` therefore shows the
preview without them. Name none of `styleSrc`, `styleSrcElem`, `styleSrcAttr` and `defaultSrc` there, or allow `'unsafe-inline'` in a `styleSrc` without `NONCE` that no `styleSrcElem` or `styleSrcAttr` overrides; see [CSP](csp.md#frames-with-their-own-document).

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

`make()` of a factory returns the [attributes](seeding.md#using-factories) it would insert, not a row: no `id`, none of the columns
the database fills, a column with a default may be missing, and a related column may hold a pending factory. It does not satisfy `Row<'events'>`,
so a mail that takes a whole row has no sample to preview. Let a mail take the few fields it prints:

```ts title="modules/events/mail/EventReminderMail.ts"
import { Factories } from '@marmeon/database';
import { Translators, type Translator } from '@marmeon/i18n';
import { mjml, type Address, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { EventFactory } from '../factories/EventFactory.ts';
import { layout } from './layout.ts';

export class EventReminderMail implements Mailable {
  readonly #to: Address;
  readonly #event: { readonly name: string; readonly city: string };
  readonly #t: Translator;

  constructor(to: Address, event: { readonly name: string; readonly city: string }, t: Translator) {
    this.#to = to;
    this.#event = event;
    this.#t = t;
  }

  static preview({ make, locale }: MailPreviewContext): EventReminderMail {
    const event = make(Factories).for(EventFactory).make({ name: 'Summer party', city: 'Hamburg' });
    return new EventReminderMail({ address: 'ada@example.com', name: 'Ada Lovelace' }, { name: event.name, city: event.city }, make(Translators).for(locale));
  }

  envelope() {
    return { to: this.#to, subject: this.#event.name };
  }

  content() {
    return layout(this.#t, {
      preview: this.#event.name,
      body: mjml`<mj-text>${this.#event.name} takes place in ${this.#event.city}.</mj-text>`,
    });
  }
}
```

The same constructor serves the real mail, which passes `{ name: event.name, city: event.city }` from the row it has. Where the sample needs no factory,
write the values in the preview.

The previews exist only with `NODE_ENV=development`, the rule of every development tool. They answer only `localhost`,
`127.0.0.1`, `[::1]` and the host of `APP_URL`, so a page on another site cannot reach them through DNS rebinding. The mail's HTML
is shown in a sandboxed frame, and no script of a template runs. The [devtools](devtools.md) link to them.

## Observation

In development the [devtools](devtools.md) record every mail that is sent or queued, with its secrets redacted. The OpenTelemetry
package counts a mail's recipients, never their addresses, as the [observability](observability.md#what-it-records) page explains.

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
`assertNotSent` check the rest. The fake does not put queued mails on the queue. `app.mail.failNext()` makes the next `send()` fail, to test a provider that is
down; a queued mail that fails in its job is tested with a real queue and a transport of your own. The [fakes](fakes.md#mail) page covers every assertion and the message id.
