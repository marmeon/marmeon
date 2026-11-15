/** The texts of the back office — the source language. */
const en = {
  login: {
    title: 'Back office sign-in',
    heading: 'Back office',
    intro: 'For editors only. Customers sign in to the app.',
    email: 'Email',
    password: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    failed: 'These credentials do not match our records.',
    throttled: 'Too many sign-in attempts. Try again in {seconds, plural, one {# second} other {# seconds}}.',
    locked: 'Too many failed sign-ins for this account. Try again later.',
  },
  overview: {
    title: 'Back office',
    greeting: 'Welcome, {name}.',
    own: 'You are signed in with your account of the back office.',
    app: 'You are signed in with your account of the app.',
    publish: 'Publish',
    readOnly: 'You can look, not publish.',
    sessions: 'Your sign-ins',
    secure: 'Sensitive page',
    logout: 'Sign out',
  },
  sessions: {
    title: 'Your sign-ins',
    current: 'this browser',
    unknown: 'Unknown browser',
    end: 'Sign out',
    back: 'Back to the back office',
  },
  confirm: {
    title: 'Confirm your password',
    intro: 'This page asks for your back office password again.',
    password: 'Password',
    submit: 'Confirm',
    incorrect: 'The password is not correct.',
    throttled: 'Too many attempts. Try again in {seconds, plural, one {# second} other {# seconds}}.',
  },
  secure: {
    title: 'Sensitive page',
    intro: 'Only editors who confirmed their password a moment ago see this.',
    back: 'Back to the back office',
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    office: typeof en;
  }
}
