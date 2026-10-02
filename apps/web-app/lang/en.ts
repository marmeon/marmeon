/** App-wide texts (namespace `app`): the layout around every page and the language switcher. */
const en = {
  name: 'BespokeCore',
  main: 'Main',
  people: 'People',
  notifications: 'Notifications',
  dashboard: 'Dashboard',
  account: 'Account',
  profile: 'Your profile',
  settings: 'Settings',
  sign_out: 'Sign out',
  sign_in: 'Sign in',
  register: 'Create an account',
  close: 'Close',
  language: 'Language',
  // An action that failed (E59): shown where it was started — never retried by itself.
  action_failed:
    '{reason, select, signed_out {You are signed out — reload the page to sign in again.} expired {Your session has expired — reload the page.} offline {The server could not be reached — please try again.} forbidden {You may not do that.} other {That did not work — please try again.}}',
  unsaved: 'You have unsaved changes. Leave this page anyway?',
  confirm: {
    ok: 'OK',
    cancel: 'Cancel',
    leave: 'Leave',
    stay: 'Stay',
    prompt: 'Type “{text}” to confirm',
  },
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
