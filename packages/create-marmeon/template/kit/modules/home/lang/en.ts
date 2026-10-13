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
  next_steps: 'Next steps',
  edit_title: 'Change this page',
  edit_text: 'It lives in modules/home/views/Home.tsx. The look lives in styles/app.css.',
  docs_title: 'Read the docs',
  docs_text: 'How an app is laid out, and how to build on it.',
  docs_installation: 'Installation',
  docs_structure: 'Structure',
  kit_title: 'About the starter kit',
  kit_text: 'What sign-in, registration and the settings pages include, and how to change them.',
  kit_link: 'The starter kit',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    home: typeof en;
  }
}
