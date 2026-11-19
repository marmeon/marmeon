import type { RouteName } from '@marmeon/router';

/**
 * Where this module sends people. They are your app's route names: change them if yours differ — each is checked against the routes
 * of the app (`marmeon route:types`), so a name that does not exist is a type error here.
 */
export const TARGETS = {
  /** Where a person lands after signing in. A route without path parameters. */
  home: 'dashboard',
  /** The sign-in page, where a refused or failed sign-in returns with its message. */
  login: 'auth.login',
  /** The page that asks for the second factor of an account that has one. */
  twoFactorChallenge: 'auth.two-factor.challenge',
  /** The page that asks for the password again, where an account with a password confirms. A route without path parameters. */
  confirm: 'auth.password.confirm',
} as const satisfies Record<string, RouteName>;
