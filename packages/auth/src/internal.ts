/**
 * The framework's own entry points, for its packages and their tests: not API, can change in any release.
 * @internal
 */
export { authenticatedToken } from './test-token.ts';
export { withRequestGuard } from './request-guard.ts';
export { CONFIRM_REAUTHENTICATED, reauthenticator, type ReauthenticationProof, type Reauthenticator } from './reauthentication.ts';
export { onPasswordReset } from './reset-hooks.ts';
export { idOf } from './user.ts';
/**
 * How a package that stores something for the signed-in account claims it: inside one transaction, `await auth[CLAIM_ACCOUNT]()` first
 * (a compare-and-set of the session key that locks the account's row until the commit; `false` means the session ended, so refuse and let
 * the transaction roll back), then write. After the rollback and again after the commit, `await auth[ACCOUNT_STILL_CLAIMED]()`: `false`
 * means the session ended meanwhile (it is signed out for good), and what was written is taken out again. It assumes the transaction is the outermost one: a caller refuses to run inside another. A claim only restricts, it
 * refuses or signs out and never grants. `claimRefused` is the error for a claim that failed while the session still fits.
 */
export { ACCOUNT_STILL_CLAIMED, CLAIM_ACCOUNT } from './auth.ts';
export { claimRefused } from './account-sessions.ts';
