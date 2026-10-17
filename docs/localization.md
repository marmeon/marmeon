# Localization

## Introduction

`@marmeon/i18n` translates your app. Each module keeps its texts in one TypeScript file per language, and the English file is
the source: the compiler checks every key and every placeholder against it, without generated code. A request speaks the
language of its visitor, and a page renders from the same files on the server and in the browser.

```ts title="modules/notes/lang/en.ts"
const en = {
  title: 'Notes',
  count: '{count, plural, =0 {No notes yet} one {# note} other {# notes}}',
  saved: 'Saved {title}.',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    notes: typeof en;
  }
}
```

On the server, the injected `Translator` speaks the request's language. In a view, `useTranslation()` of `@marmeon/react` does:

```ts
this.#translator.get('notes.count', { count: 3 }); // "3 notes"
```

```tsx
const t = useTranslation('notes');
return <h1>{t('count', { count: notes.length })}</h1>;
```

Every new app has the package, with English and German texts for the framework's own messages.

## Language files

A module's texts live in `modules/<module>/lang/<locale>.ts`, and their namespace is the module's name. App-wide texts live in
`lang/<locale>.ts`, under the namespace `app`. A key is the namespace and the path: `notes.count`, `app.sign_out`. The namespace
`marmeon` belongs to the framework, and a module of that name fails the start.

A file default-exports strings, nested in objects as deep as you like. A key may not contain a dot. Every file is parsed when the
app starts, and a message that is malformed fails the start with its key and file:

```text
[marmeon:S5] Message notes.saved in /srv/app/modules/notes/lang/en.ts is malformed: Unclosed placeholder {title at position 12 of "Saved {title"
```

The English file is the source of the types. Declare it in `Translations` and keep `as const`: the texts as types are what
give the placeholders their types, so `{count, plural, …}` takes a number. Another language is checked against it:

```ts title="modules/notes/lang/de.ts"
import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Notizen',
  count: '{count, plural, =0 {Noch keine Notizen} one {# Notiz} other {# Notizen}}',
  saved: '{title} gespeichert.',
} satisfies Messages<typeof en>;
```

`satisfies Messages<typeof en>` asks for every key of the English file and nothing more, and each text must keep the source's
placeholders. The app loads the files of every locale in `APP_LOCALES`, or of every locale it has files for when the variable is
not set. Files of other locales are skipped.

The framework's texts, under the namespace `marmeon`, come in English and German: the status pages, the CSRF and rate-limit
errors, and the message of every validation rule. Each package also keeps its English text in its code, for apps without this
package.

## Messages

A message is text with placeholders, in a subset of ICU's message format. It is parsed once and formatted with `Intl`:

| Syntax | Takes |
| --- | --- |
| `{name}` | A value. Numbers and dates are formatted for the locale. |
| `{n, number}`, `{n, number, integer}`, `{n, number, percent}` | A number. |
| `{d, date}`, `{d, date, short}`, … `medium`, `long`, `full`; `{t, time, …}` | A `Date`, a timestamp or an ISO string. |
| `{count, plural, =0 {none} one {# item} other {# items}}` | A number. `#` is the number. |
| `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}` | A number. |
| `{kind, select, link {…} other {…}}` | A string. |

Branches nest, and a `select` inside a `plural` keeps `#`. `plural`, `selectordinal` and `select` need an `other` branch. A
literal brace is `'{'` and an apostrophe `''`, while a lone apostrophe, as in "it's", is just itself. `offset:`, number
skeletons and placeholder types other than those in the table are not supported. A value that is missing at runtime leaves its
placeholder visible, `{name}`, instead of failing.

> [!WARNING]
> A formatted message is plain text. Render it as text, never as HTML: markup in a message or in a value stays as written, and
> React escapes it. Never put a translated text through `dangerouslySetInnerHTML`.

## On the server

The `Translator` is scoped to the request: two requests never share one, and each speaks its own visitor's language. Inject it
like any service:

```ts title="modules/notes/controllers/StoreNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const StoreNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(200) }),
});

export class StoreNoteController extends Controller {
  static request = StoreNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof StoreNoteRequest> & Authenticated) {
    await this.#notes.insert({ user_id: ctx.user.id, title: ctx.body.title, body: '' });
    return this.back().flash('toast', { kind: 'success', message: this.#translator.get('notes.saved', { title: ctx.body.title }) });
  }
}
```

- **`get(key, params)`** returns the message in the translator's locale, else in its language (`de-AT` falls back to `de`), else
  in `APP_FALLBACK_LOCALE`, formatted for the locale it was found in. When no locale has the key, it returns the key.
- **Keys are checked.** `get('notes.titel')` is a compile error that names the namespace and suggests keys nearby. A value for a
  placeholder that is missing, misspelt or of the wrong type is a compile error too.
- **`forLocale(locale)`** gives a translator fixed to another supported locale, for a text meant for someone else. An unknown
  locale keeps this translator's.
- **`has(key)`** says whether a key exists, `locale` is the translator's locale, `locales` the supported ones with the default
  first, and `format` formats numbers and dates, as [formatting](#formatting) shows.

Outside a request, in a job or a command, each of which has a scope of its own, the `Translator` speaks `APP_LOCALE`. It cannot be
resolved from the root container, since it is scoped. Use `Translators` there.

Validation messages are translated into the request's language as well. A request's `messages` and `attributes` name your own
keys, and `trans(key, params)` gives a rule a checked key of its own. The [validation](validation.md#messages) page explains them.

## `Translators`: any language, anywhere

`Translators` is a service of the whole app that hands out a translator for any locale. A job, a command, a scheduled task, a
queued listener or a notification injects it. Whoever a text is for, a mail or a notification, decides its language, never the
request that caused it:

```ts title="modules/auth/verification.ts"
import { EmailVerification } from '@marmeon/auth';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { AppConfig } from '../../config/app.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';

export class VerificationMailer {
  readonly #verification: EmailVerification;
  readonly #mailer: Mailer;
  readonly #app: AppConfig;
  readonly #translators: Translators;

  constructor(verification: EmailVerification, mailer: Mailer, app: AppConfig, translators: Translators) {
    this.#verification = verification;
    this.#mailer = mailer;
    this.#app = app;
    this.#translators = translators;
  }

  async send(user: User): Promise<void> {
    const mail = new VerifyEmailMail(user, this.#verification.link(user, { base: this.#app.url }), this.#translators.for(user.locale));
    await this.#mailer.queue(mail, { queue: 'mail' });
  }
}
```

`for(locale)` takes the supported locale the value names, in the app's spelling, so `DE` is `de`. Anything else, `null`
included, gets `APP_LOCALE`: never a locale the app does not have. `default` is the translator of `APP_LOCALE`, and `locales`
the supported locales. The [mail](mail.md#the-recipients-language) and [notifications](notifications.md#recipients) pages use it.

## The request's locale

The `SetLocale` middleware of the `web` group picks the request's locale, after the session starts and before the CSRF check, so
its errors are translated too. With only one supported locale there is nothing to choose, and every request speaks it. With more,
it takes the first supported locale of:

1. the session's `locale`, a language switcher's choice;
2. the signed-in user's, through `LocalePreference`;
3. the browser's `Accept-Language`, by quality, then by order. `de-AT` falls back to `de`, and `de` matches the first supported
   `de-…`;
4. `APP_LOCALE`.

The default `LocalePreference` knows no user. The starter kit binds one in its provider that reads the account's stored language:

```ts
container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
```

A value from a session, a header or a form becomes a locale only when it names a supported one, and then in the app's spelling.
So what reaches `<html lang>`, the page and the browser's language files is always one of your locales, never a path or markup.
Every response of the `web` group carries `Content-Language`. With more than one supported locale it also carries
`Vary: accept-language`, so a cache keeps the languages apart — but the chosen locale lives in the session (a guest's is gone when the browser closes), so a shared cache
must not store pages per URL (or the locale belongs in the URL). Routes of the `api` group pass no `SetLocale`: their `Translator`
speaks `APP_LOCALE`. The page carries its `locale` and the fallback locale, never the messages: the browser loads
those itself.

`Locales` is a service of the whole app: `default`, `fallback`, `supported` with the default first, `explicit` for whether
`APP_LOCALES` names them, and `find(value)`, which returns the supported locale a value names, or `undefined`.

### A language switcher

A switcher posts the chosen locale, checks it with `Locales` and writes it into the session:

```ts title="modules/locale/controllers/UpdateLocaleController.ts"
import { ClientHistory, Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Locales } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';

export const UpdateLocaleRequest = defineRequest({
  schema: r.object({ locale: r.string().max(35) }),
});

export class UpdateLocaleController extends Controller {
  static request = UpdateLocaleRequest;

  readonly #locales: Locales;
  readonly #session: Session;
  readonly #history: ClientHistory;

  constructor(locales: Locales, session: Session, history: ClientHistory) {
    super();
    this.#locales = locales;
    this.#session = session;
    this.#history = history;
  }

  handle(ctx: ContextOf<typeof UpdateLocaleRequest>) {
    const locale = this.#locales.find(ctx.body.locale);
    if (!locale) throw new ValidationError({ locale: ['Choose one of the offered languages.'] }, { locale: ctx.body.locale });
    this.#session.put('locale', locale);
    this.#history.clear({ siteData: false });
    return this.back('/');
  }
}
```

A message that is no translation key, like this one, stays as written. A key of your `lang/` files is translated instead. The
session holds the choice for this browser. To make it the account's too, so that mails come in it and other devices start in
it, also write it into the `locale` column of the signed-in user's row, which the starter kit's `users` table has: a small method
of your `UserRepository` that updates the column, called when `Auth` has a user. The starter kit's `LocalePreference` then reads
it on every device.

`this.#history.clear({ siteData: false })` makes the browser load the next page in full and drops the pages the client keeps in
memory in the old language. It does not clear the browser's HTTP cache: pages without a `Cache-Control` that grants freshness are
asked for again on a normal visit (Back and Forward may still show a page in the old language until the next visit), and clearing it is slow in Chrome ([the cost](client-features.md#the-browsers-storage-on-sign-out)).
The locale is part of what the browser's other tabs watch, so they load again in the new language, as
[tab sync](client-features.md#tab-sync) explains.

## In the browser

Pages render from the same language files in the browser and on the server. A new app loads them in `bootstrap/i18n.ts` and
hands them to its client and server entries:

```ts title="bootstrap/i18n.ts"
import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang';

export const messages = createMessageLoader(lang);
```

`virtual:marmeon/lang` comes from the `marmeon()` Vite plugin: every language file as a chunk of its own, loaded when a page
needs its locale. A page loads, for each namespace, its file in the page's locale, else in that locale's language, else in the
fallback locale. A locale is only ever a key into these files, checked to be a language tag first.

The browser gets the app's namespaces only, never the framework's `marmeon` texts: status pages, server errors and validation
messages arrive translated. `useTranslation(namespace)` returns `t(key, params)`, typed like the server's, with `t.locale`,
`t.format` and `t.has(key)`. The [pages](pages.md#translations) page shows the hooks in views.

## Formatting

`translator.format`, `t.format` in a view and `useLocale().format` format numbers and dates for their locale:

```ts
format.number(1234.5);                              // "1,234.5", and "1.234,5" in German
format.date(note.created_at, { dateStyle: 'long' }); // a Date, a timestamp or an ISO string; medium by default
format.relativeTime(-3, 'day');                     // "3 days ago"
format.relative(note.updated_at, now);              // "3 minutes ago", "yesterday", "in 2 days"
```

`relative()` picks the largest unit that fits. Pass it the server's `now` as a prop rather than the browser's clock, so the server
and the browser render the same text.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_LOCALE` | `en` | The default locale, for visitors whose session, account and browser name none of the supported ones. |
| `APP_FALLBACK_LOCALE` | `en` | Where a message missing in a locale comes from: the language of the source files. |
| `APP_LOCALES` | every locale with language files | The supported locales, comma-separated: `en,de`. |

Each value must be a language tag, such as `en` or `de-AT`. With `APP_LOCALES` set, `APP_LOCALE` and `APP_FALLBACK_LOCALE` must be
among them, or the app does not start. Without it, the supported locales are those the app has files for, plus the two others.

## Testing

A test speaks to the app like a browser, with its languages or a session:

```ts title="modules/notes/locale.test.ts"
import { Translators } from '@marmeon/i18n';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('answers in the browser’s language', async () => {
  const app = await createTestApp(application);
  const login = await app.withHeaders({ 'accept-language': 'de-DE,de;q=0.9' }).navigating().get('/login');
  expect(login.page()).toMatchObject({ locale: 'de' });
  await app.withSession({ locale: 'de' }).get('/').assertOk();
  expect(app.make(Translators).for('de').get('notes.title')).toBe('Notizen');
});
```

The type checks, a key missing in a translation or a placeholder dropped, are best kept in a `*.type-test.ts` file with
`@ts-expect-error`: the type check compiles it, and nothing runs it.
