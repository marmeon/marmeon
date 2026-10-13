export { authenticationOptions, PASSKEY_ALGORITHMS, PASSKEY_TIMEOUT, registrationOptions, verifyAuthentication, verifyRegistration } from './webauthn.ts';
export type { RelyingParty, StoredPasskey, VerifiedAuthentication, VerifiedRegistration, VerifyError } from './webauthn.ts';
export { PasskeyConfig, PasskeyConfigError, relyingPartyFrom } from './config.ts';
export type { PasskeyConfigValue } from './config.ts';
export { PASSKEYS_TABLE, PasskeyStore } from './store.ts';
export type { NewPasskey, PasskeyRecord, PasskeyTable } from './store.ts';
export { CHALLENGE_SECONDS, issueChallenge, takeChallenge } from './challenge.ts';
export type { ChallengeError, ChallengePurpose } from './challenge.ts';
