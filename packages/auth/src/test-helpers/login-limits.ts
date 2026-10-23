import type { SignInThrottle } from '../sign-in-throttle.ts';

/** A `SignInThrottle` that never holds anything up — for tests that build `Auth` or `PasswordBroker` by hand and test something else. */
export const NO_LOGIN_LIMITS = {
  takeClient: async () => undefined,
  takeAccount: async () => undefined,
  clearClient: async () => {},
  clearAccount: async () => {},
  takeDevice: async () => false,
  deviceNonce: () => undefined,
  deviceCookieName: 'marmeon_device',
  issueDevice: () => undefined,
} as unknown as SignInThrottle;
