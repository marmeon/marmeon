/**
 * The texts of the home page — the source language. Another language is a file next to this one (`lang/de.ts`, checked
 * against this one with `satisfies Messages<typeof en>`). Views read them with `useTranslation('home')`.
 */
const en = {
  title: 'Welcome',
  heading: 'Welcome to {app}',
  intro: 'A Marmeon app, ready to build on. Sign-in, registration and settings are already in place.',
  guest: 'Sign in or create an account to get started.',
  sign_in: 'Sign in',
  register: 'Create an account',
  signed_in: 'Signed in as {name}.',
  dashboard: 'Go to your dashboard',
  next_steps: 'Next steps',
  edit_title: 'Change this page',
  edit_page: 'The page:',
  edit_look: 'The look:',
  edit_module: 'A feature of your own:',
  docs_title: 'Read the docs',
  docs_text: 'How an app is laid out, and how to build on it.',
  docs_installation: 'Installation',
  docs_structure: 'Structure',
  kit_title: 'About the starter kit',
  kit_text: 'What sign-in, registration and the settings pages include, and how to change them.',
  kit_link: 'The starter kit',
  guide_title: 'Build a first feature',
  guide_text: 'A notes app on the starter kit, step by step: a module, a table, pages and tests.',
  guide_link: 'Your first app',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    home: typeof en;
  }
}
