# @marmeon/i18n

Translations for Marmeon apps (E38): typed messages per module in plain TypeScript files, an ICU subset for placeholders,
plurals and selects, a `Translator` per request and the `SetLocale` middleware that picks the request's language. Keys and
placeholders are checked by the compiler against the English source files — no code generation. It is UI-agnostic:
`@marmeon/i18n/messages` is the browser-safe core the UI adapters build on (`useTranslation` in
[@marmeon/react](../react/README.md)).

```ts
// modules/dashboard/lang/en.ts — the source language
const en = {
  title: 'Dashboard',
  members: { text: '{members, plural, one {# member} other {# members}}, {verified} with a confirmed address' },
} as const;
export default en;
declare module '@marmeon/i18n/messages' {
  interface Translations { dashboard: typeof en }
}
```

```ts
// on the server — constructor(translator: Translator), the request's language
this.#translator.get('dashboard.members.text', { members: 12, verified: 9 });   // "12 members, 9 with a confirmed address"
```

```tsx
// in a view
const t = useTranslation('dashboard');
<p>{t('members.text', { members: stats.members, verified: stats.verified })}</p>
```

`marmeon discover` registers its `I18nServiceProvider` through the `"marmeon"` field of its package.json; the field's `browser`
list marks the browser-side sources (`catalog`, `format`, `locale`, `loader`, `messages`), which the injection transform leaves
alone (E76). It depends on `@marmeon/core`, [@marmeon/router](../router/README.md) (the `web` group, validation messages) and
**`@marmeon/session`**: the locale a visitor chose with a language switcher lives in the session (`session.put('locale', …)`
— the package adds `locale` to `SessionData`), and `SetLocale` reads it first.

## Language files

- **Where:** `modules/<module>/lang/<locale>.ts` — the namespace is the module's name — and `lang/<locale>.ts` for app-wide texts
  (namespace `app`). Keys are `<namespace>.<path>`: `auth.login.title`, `app.sign_out`. The namespace `marmeon` belongs to the
  framework (a module of that name fails the start).
- **What:** a default export of strings, nested in objects. A key may not contain a dot. Every file is parsed at the start; a
  malformed message fails it with its key and file, a namespace defined twice in one locale too:
  `Message auth.login.throttled in … is malformed: Unclosed placeholder {seconds at position …`.
- **Types:** the English file is the source. Declare it in `Translations` (declaration merging on `@marmeon/i18n/messages`)
  and keep `as const` — the texts as types are what types the placeholders (`{count, plural, …}` → `count: number`). A
  translation is checked against it:

  ```ts
  // modules/dashboard/lang/de.ts
  import type { Messages } from '@marmeon/i18n/messages';
  import type en from './en.ts';

  export default {
    title: 'Übersicht',
    members: { text: '{members, plural, one {# Mitglied} other {# Mitglieder}}, {verified} mit bestätigter Adresse' },
  } satisfies Messages<typeof en>;   // every key of en.ts, nothing more, each text keeping the source's placeholders
  ```

- **Which are loaded:** every locale of `APP_LOCALES` — without it, every locale the app has files for. Files of other locales
  are skipped (a debug log line names them). Paths come from the app's folders, never from a request.
- **The framework's texts** (namespace `marmeon`, English and German): status pages (`marmeon.status.404`), framework errors
  (CSRF — `marmeon.errors.csrf` for the 419, `marmeon.errors.cross_site` for the 403 of a cross-site request, E143 —, throttling,
  signatures), the password and upload rules of [@marmeon/auth](../auth/README.md) and
  [@marmeon/storage](../storage/README.md#uploads), and `marmeon.validation.more` ("(and 2 more errors)"). Each package
  keeps its English text inline as well, for apps without i18n.

## Messages: the ICU subset

Parsed once (`parseMessage`), formatted through `Intl` (`formatParts`, or `formatMessage(message, params, locale)` for a message
used once):

| Syntax | Takes |
|---|---|
| `{name}` | a value — numbers and dates are formatted for the locale |
| `{n, number}`, `{n, number, integer}`, `{n, number, percent}` | a number |
| `{d, date}`, `{d, date, short\|medium\|long\|full}`, `{t, time, …}` | a `Date`, a timestamp or an ISO string |
| `{count, plural, =0 {none} one {# item} other {# items}}` | a number — `Intl.PluralRules`, `#` is the number |
| `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}` | a number |
| `{kind, select, link {…} other {…}}` | a string |

Branches nest (a `select` inside a `plural` keeps `#`); `plural`, `selectordinal` and `select` need an `other` branch. Quoting as
in ICU: `'{'` is a literal brace, `''` an apostrophe — a lone apostrophe elsewhere is just one ("it's"). Not supported: `offset:`,
number skeletons (`::`). A missing value leaves its placeholder visible (`{name}`), never a crash. **The result is plain text**:
render it as text, never as HTML — markup in a message or a value stays as written and the document escapes it.

## On the server: `Translator`

The request's translator — **scoped**: two requests never share one, each speaks its own locale. Inject it like anything else:

```ts
constructor(translator: Translator) { … }

this.#translator.get('auth.login.failed');
this.#translator.get('auth.login.throttled', { seconds: 30 });   // the value is required: the text has a placeholder
this.#translator.forLocale(user.locale).get('auth.mail.reset.subject');   // for someone else: the recipient's language
```

- **`get(key, params)`** — the message in the translator's locale, else its language (`de-AT` → `de`), else
  `APP_FALLBACK_LOCALE`, formatted for the locale it was found in (an English fallback gets English plurals); the key itself
  when no locale has it. `has(key)`, `text(key, params, fallback)` (the core's `Translator` contract — the same token, which
  framework packages use), `locale`, `fallbackLocale`, `locales` (the supported ones, the default first) and `format`
  ([Formatting](#formatting)).
- **Checked keys:** `get('auth.login.titel')` is a compile error that names the namespace and suggests keys nearby; an unknown
  namespace says namespaces are module names and `app`; a missing, misspelt or mistyped placeholder value is an error too.
- **`forLocale(locale)`** — a translator fixed to a supported locale; anything else (or nothing) keeps this one's.
- **Outside a request** — in a job or a command (each runs in a scope of its own) — the `Translator` speaks `APP_LOCALE`.
  Resolving it from the root container throws (it is scoped); use [`Translators`](#translators-any-locale-anywhere) there.

**Validation messages** are translated in the request's language when validation fails (the exception handler calls
`ValidationError.translate`): `trans(key, params)` leaves a checked key on the issue, with what the rule required as
`{requirement}`; a message that is a key itself works too.

```ts
schema: v.object({
  name: v.pipe(v.string(), v.minLength(2, trans('auth.validation.name_min'))),   // "The name needs at least {requirement} characters."
  locale: v.pipe(v.string(trans('app.locale.unsupported')), v.maxLength(35)),
}),
```

## `Translators`: any locale, anywhere

A root service — a job, a command, a scheduled task, a queued listener or a notification injects it — that hands out translators
fixed to a locale (no global state):

```ts
// constructor(…, translators: Translators) — SendPasswordResetLinkJob of the web app
const t = this.#translators.for(reset.user.locale ?? payload.locale);   // the account's language, else the one it was asked in
await this.#mailer.queue(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire, t), { queue: 'mail' });
```

`for(locale)` takes the supported locale `locale` names, in the app's spelling (`DE` → `de`), else `APP_LOCALE` — never a locale
the app does not have; translators are cached per locale. `default` is `APP_LOCALE`'s, `locales` the supported ones. Inside a
request `Translator` is the visitor's language; whoever a text is for — a mail, a notification — ask `Translators`. Queued mails
are composed in the translator they are given ([queued mails](../mail/README.md#queued-mails-e105)); notifications compose each
recipient's mail through `Translators.for` with the `locale()` of their recipient resolver
([sending](../notifications/README.md#sending)).

## The request's locale: `SetLocale`

The middleware runs in the `web` group, after the session and before CSRF verification (its 403 and 419 answers are translated
too). The
request's locale is the first supported one of:

1. the **session's** `locale` — a language switcher's choice;
2. the signed-in **user's** — `LocalePreference`, bound per request; the default knows none;
3. the **browser's** — `Accept-Language`, by quality, then order: `de-AT` falls back to `de`, `de` matches the first supported
   `de-*` (`negotiateLocale`);
4. `APP_LOCALE`.

```ts
// modules/auth/AuthServiceProvider.ts — the account's stored language
container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
```

- **Only supported locales, in their spelling:** no value from a session, header or form becomes a locale unless `Locales` finds
  it (`locales.find(value)`). What reaches `<html lang>`, the page's `locale` and the browser's language files is always one of
  the app's own — never a path or markup.
- **Responses** carry `Content-Language`. With several supported locales they also carry `Vary: accept-language`; with one,
  nothing is negotiated and no `Vary` is sent.
- **The page** carries `locale` and `fallbackLocale` (`APP_FALLBACK_LOCALE`) — never the messages; the browser loads them. The
  document gets `<html lang>`.
- **`Locales`** (a root service): `default`, `fallback`, `supported` (the default first), `explicit` (whether `APP_LOCALES` names
  them), `find(value)`.

A language switcher — the web app's `POST /locale` — checks the value against `Locales` and writes the session:

```ts
const locale = this.#locales.find(ctx.body.locale);
if (!locale) throw new ValidationError({ locale: ['app.locale.unsupported'] }, { locale: ctx.body.locale });
this.#session.put('locale', locale);
const user = await this.#auth.user();
if (user) await this.#users.updateLocale(user.id, locale);   // mails reach the user in it; other devices start in it
this.#history.clear({ siteData: ['cache'] });                 // ClientHistory: a full load, the HTTP cache of old-language pages gone
```

The locale is part of the session's epoch: a switch makes the browser's other tabs load again in the new language
([tab sync](../http/README.md#tab-sync-w8-step-8)); flash messages and other session writes do not.

## In the browser

Pages render from the same language files in the browser and in the SSR entry, loaded by locale on demand:

```ts
// bootstrap/i18n.ts
import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang';

export const messages = createMessageLoader(lang);
// bootstrap/client.tsx: createMarmeonApp({ …, messages }); bootstrap/ssr.tsx: createSsrRenderer(resolvePage, { …, messages })
```

- **`virtual:marmeon/lang`** (the `marmeon()` Vite plugin of [@marmeon/vite](../vite/README.md), option `lang`) is every
  language file as a lazy import — one chunk per file. Default: `modules/*/lang/*.ts` and `lang/*.ts`.
- **Only the app's namespaces:** the browser's catalog holds the modules' namespaces and `app` — never the framework's `marmeon`
  namespace, which stays on the server (status pages, server errors, validation messages arrive translated). Framework UI in the
  browser takes its words from the app: the kit's dialog from `lang/<locale>.ts`, `<Pagination labels>` and the like as props.
- **`load(locale, { fallback })`** loads, for every namespace, its file in the page's locale, else in the locale's language, else
  in the fallback locale the page names (or its language) — nothing else. Once per locale; a failed load (a lost chunk) may be
  tried again.
- **A locale is only ever a key** into the files, checked to be a language tag first: a page's `locale` cannot load anything
  but the app's own files.
- **`Translate`** — what `useTranslation(namespace)` returns: `t(key, params)` with keys of that namespace, typed like the
  server's, plus `t.locale`, `t.namespace`, `t.format` and `t.has(key)`. The hooks (`useTranslation`, `useLocale`) are part of
  [@marmeon/react](../react/README.md); a Vue adapter would build on the same `Catalog.translate(locale, namespace)`.

## Formatting

`translator.format`, `t.format` and `useLocale().format` are a `Formatter` for the locale — `Intl`, with its formatters reused:

```ts
format.number(1234.5);                                  // "1,234.5" — "1.234,5" in de
format.date(user.createdAt, { dateStyle: 'long' });     // a Date, a timestamp or an ISO string (a Date prop in the browser); default medium
format.relativeTime(-3, 'day');                         // "3 days ago"
format.relative(entry.at, now);                         // "3 minutes ago", "yesterday", "in 2 days" — the largest fitting unit
```

Pass the server's `now` to `relative` (a prop), not the browser's clock: server and browser then render the same text.

## Configuration

```sh
APP_LOCALE=en            # the default — for visitors whose session, account and browser name none of the supported ones
APP_FALLBACK_LOCALE=en   # where a message missing in a locale comes from (the language of the source files)
APP_LOCALES=en,de        # optional: the supported locales — default: every locale with language files, plus the two above
```

`I18nConfig` checks them at the start: each must be a language tag (`en`, `de-AT`), and with `APP_LOCALES` set, `APP_LOCALE` and
`APP_FALLBACK_LOCALE` must be among them (`APP_LOCALE must be one of APP_LOCALES`). The fallback locale is configured once, on the
server: it travels with every page.

## Testing

No helpers of its own — a test speaks to the app like a browser. With [@marmeon/testing](../testing/README.md):

```ts
const login = await app.withHeaders({ 'accept-language': 'de-DE,de;q=0.9' }).navigating().get('/login');
expect(login.page()).toMatchObject({ locale: 'de' });
await app.withSession({ locale: 'de' }).get('/');                              // a switcher's choice
app.container.make(Translators).for('de').get('auth.mail.reset.subject');      // what a mail will say
```

The type guarantees (a missing key in a translation, a placeholder dropped, an unknown key or namespace in `t()`) are best kept
in a `*.type-test.ts(x)` file with `@ts-expect-error` — compiled by `pnpm typecheck`, never run.
