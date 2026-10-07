/**
 * The texts of the home page — the source language. Another language is a file next to this one (`lang/de.ts`, checked
 * against this one with `satisfies Messages<typeof en>`). Views read them with `useTranslation('home')`.
 */
const en = {
  title: 'Welcome',
  heading: 'Welcome to {app}',
  intro: 'A Marmeon app: this page is modules/home — change it, or start a module of your own with marmeon make:module.',
  guest: 'Sign in or create an account to get started.',
  sign_in: 'Sign in',
  register: 'Create an account',
  signed_in: 'Signed in as {name}.',
  dashboard: 'Go to your dashboard',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    home: typeof en;
  }
}
