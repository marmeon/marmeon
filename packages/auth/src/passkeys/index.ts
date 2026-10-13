export { authenticationOptions, PASSKEY_ALGORITHMS, PASSKEY_TIMEOUT, registrationOptions, verifyAuthentication, verifyRegistration } from './webauthn.ts';
export type { RelyingParty, StoredPasskey, VerifiedAuthentication, VerifiedRegistration, VerifyError } from './webauthn.ts';
export { CHALLENGE_SECONDS, issueChallenge, takeChallenge } from './challenge.ts';
export type { ChallengeError, ChallengePurpose } from './challenge.ts';
