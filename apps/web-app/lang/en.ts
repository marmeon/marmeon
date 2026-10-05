/** App-wide texts (namespace `app`): the layout around every page and the language switcher. */
const en = {
  name: 'BespokeCore',
  main: 'Main',
  people: 'People',
  notifications: 'Notifications',
  // The bell in the header: its label for screen readers.
  bell: '{count, plural, =0 {Notifications} one {Notifications, # unread} other {Notifications, # unread}}',
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
  // A new build is out (E64) — shown instead of reloading while you have unsaved changes.
  new_version: 'A new version of this app is available.',
  new_version_reload: 'Reload now',
  confirm: {
    ok: 'OK',
    cancel: 'Cancel',
    leave: 'Leave',
    stay: 'Stay',
    prompt: 'Type “{text}” to confirm',
    // Another tab signed in or out, or switched the language (tab sync), while this one has unsaved changes.
    session: 'You signed in or out, or changed the language, in another tab. Load this page again? Your unsaved changes will be lost.',
    reload: 'Load again',
  },
  // The page links of a list (<Pagination>, layouts/Pagination.tsx).
  pagination: {
    navigation: 'Pagination',
    previous: '‹ Previous',
    next: 'Next ›',
    page: 'Page {page}',
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
