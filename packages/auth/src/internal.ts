/**
 * The framework's own entry points, for its packages and their tests: not API, can change in any release.
 * @internal
 */
export { authenticatedToken } from './test-token.ts';
export { withRequestGuard } from './request-guard.ts';
export { CONFIRM_REAUTHENTICATED, reauthenticator, type ReauthenticationProof, type Reauthenticator } from './reauthentication.ts';
export { onPasswordReset } from './reset-hooks.ts';
export { idOf } from './user.ts';
