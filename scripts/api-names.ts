/**
 * The exceptions to "one exported name, one declaration" that `pnpm api:check` enforces (`scripts/api.ts`; the rule:
 * CONTRIBUTING.md, "The API snapshot").
 */

/**
 * Names that two entry points export as different declarations on purpose, because both are a view of the same value. Each entry
 * says why; nothing else belongs here.
 */
export const SAME_VALUE: Readonly<Record<string, string>> = {
  CookieDefaults: 'the type of the router option and its token, which http aliases',
  RevalidateOnBack: 'the typed form of the same option in react',
  Translator: 'the same token; i18n extends the contract of core',
};

/**
 * The collisions that exist and wait for their rename, alphabetically. A name that no longer collides must be deleted from here:
 * `pnpm api:check` fails on it, so the list only shrinks.
 */
export const KNOWN: readonly string[] = [
  'Action',
  'CheckKey',
  'Column',
  'ColumnOf',
  'DispatchOptions',
  'Entry',
  'Invokable',
  'MailContent',
  'pageQuery',
  'ParamsOf',
  'RequestInfo',
  'Router',
  'RowOf',
  'ServeOptions',
  'Table',
  'Tables',
  'Visibility',
];
