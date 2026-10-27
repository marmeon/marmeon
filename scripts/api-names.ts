/**
 * The exceptions to "one exported name, one declaration" that `pnpm api:check` enforces (`scripts/api.ts`; the rule:
 * CONTRIBUTING.md, "The API snapshot").
 */

/**
 * Names that two entry points export as different declarations on purpose, because both are a view of the same value. Each entry
 * says why; nothing else belongs here.
 */
export const SAME_VALUE: Readonly<Record<string, string>> = {
  RevalidateOnBack: 'the typed form of the same option in react',
  Translator: 'the same token; i18n extends the contract of core',
};
