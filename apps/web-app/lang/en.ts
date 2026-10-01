/** App-wide texts (namespace `app`): the layout around every page and the language switcher. */
const en = {
  name: 'BespokeCore',
  account: 'Account',
  profile: 'Your profile',
  settings: 'Settings',
  sign_out: 'Sign out',
  sign_in: 'Sign in',
  register: 'Create an account',
  language: 'Language',
  locale: {
    changed: 'Language changed.',
    unsupported: 'This language is not available.',
  },
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    app: typeof en;
  }
}
