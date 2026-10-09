# @marmeon/i18n

Translations for Marmeon apps: typed language files per module, an ICU subset, the request's language, and formatting — on the
server and in the browser.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

## A language file

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

```ts
this.#translator.get('notes.count', { count: 3 }); // "3 notes"
```

The English file is the source: the compiler checks every key and every placeholder against it. On the server the injected
`Translator` speaks the request's language; in a view, `useTranslation()` of `@marmeon/react` does.

## Documentation

- [Localization](https://github.com/marmeon/marmeon/blob/main/docs/localization.md)
- [Localization: the request's locale](https://github.com/marmeon/marmeon/blob/main/docs/localization.md#the-requests-locale)
- [Validation: messages](https://github.com/marmeon/marmeon/blob/main/docs/validation.md#messages)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
