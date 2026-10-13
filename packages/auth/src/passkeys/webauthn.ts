import { timingSafeEqual } from 'node:crypto';
import { cbor } from '../cbor.ts';
import { err, ok, type Logger, type Result } from '@marmeon/core';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { cose, decodeAttestationObject, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';

// The only file that imports @simplewebauthn/server: the library is loaded by `@marmeon/auth/passkeys` and by nothing else.

export type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON };

/** The COSE algorithms a passkey may use: EdDSA, ES256, RS256. */
export const PASSKEY_ALGORITHMS: readonly number[] = [-8, -7, -257];
/** How long the browser lets the user take for one ceremony, in milliseconds. */
export const PASSKEY_TIMEOUT = 300_000;
/** The specification caps credential ids at 1023 bytes; the `passkeys` table holds them base64url in 1400 characters. */
const MAX_CREDENTIAL_ID_BYTES = 1023;
const TRANSPORTS: readonly string[] = ['ble', 'hybrid', 'internal', 'nfc', 'usb'];
/** Authenticator data flags: user present, user verified, backup eligible. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
/** RSA keys: the usual exponent, and at most 4096 bits (larger moduli only cost every later verification time). */
const RSA_EXPONENT = Buffer.from([0x01, 0x00, 0x01]);
const MAX_RSA_BITS = 4096;

/**
 * Where a ceremony may happen. Both come from configuration (`APP_URL`), never from the request: a `Host` header is
 * the client's to forge, and a forged relying party would accept a response made for another site.
 */
export interface RelyingParty {
  readonly rpId: string;
  readonly origins: readonly string[];
}

/** A passkey as the verification needs it. */
export interface StoredPasskey {
  /** The credential id, base64url. */
  readonly credentialId: string;
  /** The COSE public key, base64url. */
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports?: readonly string[];
  /** The account's user handle, base64url — what a discoverable sign-in must present. */
  readonly userHandle: string;
  /** Whether the passkey may be synchronised (the BE flag at registration); it never changes. */
  readonly backupEligible: boolean;
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
}

export interface VerifiedAuthentication {
  readonly signCount: number;
  readonly backedUp: boolean;
}

/** `invalid` says nothing about why — the client never learns which check failed (the reason goes to the debug log). */
export type VerifyError = { kind: 'invalid' } | { kind: 'clone-suspected' };

/** The comparison against the challenge taken from the session: constant-time, whatever the client sent. */
function sameChallenge(expected: string): (received: string) => boolean {
  return (received) => {
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
}

/** `crossOrigin: true` — the page ran in a frame of another site. The library lets that through when no top origin is reported. */
function isCrossOrigin(clientDataJSON: unknown): boolean {
  if (typeof clientDataJSON !== 'string') return true;
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { crossOrigin?: unknown } | null;
    return typeof data !== 'object' || data === null || data.crossOrigin === true;
  } catch {
    return true;
  }
}

/** The transports a browser reported, cut to the known ones. */
function knownTransports(list: readonly unknown[] | undefined): string[] {
  return (list ?? []).filter((transport): transport is string => typeof transport === 'string' && TRANSPORTS.includes(transport)).slice(0, TRANSPORTS.length);
}

/** Equal in constant time; a missing value is never equal. */
function sameHandle(received: unknown, stored: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received, 'base64url');
  const b = Buffer.from(stored, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bit length of a big-endian number. */
function bitLength(bytes: Uint8Array): number {
  const first = bytes.findIndex((byte) => byte !== 0);
  return first === -1 ? 0 : (bytes.length - first) * 8 - Math.clz32(bytes[first]!) + 24;
}

/**
 * The same response with its attestation reduced to `none`: format `none`, an empty statement, the authenticator data as it was.
 * The statement is never trusted, so it is never read — the library then cannot reach its X.509 and ASN.1 parsing, or fetch
 * revocation lists, for bytes the client chose. The key, the RP ID hash and the flags are in the authenticator data and still checked.
 */
function withoutAttestation(response: RegistrationResponseJSON): RegistrationResponseJSON {
  const decoded = decodeAttestationObject(Buffer.from(response.response.attestationObject, 'base64url'));
  const attestationObject = cbor(new Map<unknown, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', decoded.get('authData')]])).toString('base64url');
  return { ...response, response: { ...response.response, attestationObject } };
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Checks a registration response against the challenge the session held (taken out of it before this call). Fixed on
 * purpose: user presence and verification are required, the algorithm is on the list, the origin and RP ID are the
 * configured ones. The attestation is not trusted whatever its format: only the new key is kept.
 */
export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expected: RelyingParty & { readonly challenge: string },
  logger?: Logger,
): Promise<Result<VerifiedRegistration, VerifyError>> {
  try {
    if (isCrossOrigin(response?.response?.clientDataJSON)) throw new Error('cross-origin response');
    const verified = await verifyRegistrationResponse({
      response: withoutAttestation(response),
      expectedChallenge: sameChallenge(expected.challenge),
      expectedOrigin: [...expected.origins],
      expectedRPID: expected.rpId,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
    if (!verified.verified) throw new Error('not verified');
    const { credential, aaguid, userVerified, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
    // Checked again on the result: a parameter forgotten above would otherwise let a response without verification through unseen.
    if (userVerified !== true) throw new Error('user not verified');
    // Presence and verification once more on the flags byte itself — the one place a check of the library's cannot be forgotten.
    const flags = decodeAttestationObject(verified.registrationInfo.attestationObject).get('authData')[32]!;
    if ((flags & (FLAG_UP | FLAG_UV)) !== (FLAG_UP | FLAG_UV)) throw new Error('user not present and verified');
    if (Buffer.from(credential.id, 'base64url').length > MAX_CREDENTIAL_ID_BYTES) throw new Error('credential id too long');
    const algorithm = decodeCredentialPublicKey(credential.publicKey).get(cose.COSEKEYS.alg);
    if (typeof algorithm !== 'number' || !PASSKEY_ALGORITHMS.includes(algorithm)) throw new Error('algorithm not offered');
    if (algorithm === -257) {
      // COSE labels of an RSA key (RFC 8230): -1 the modulus n, -2 the exponent e.
      const key = decodeCredentialPublicKey(credential.publicKey) as unknown as Map<number, unknown>;
      const modulus = key.get(-1) as Uint8Array | undefined;
      const exponent = key.get(-2) as Uint8Array | undefined;
      if (!modulus || !exponent || bitLength(modulus) > MAX_RSA_BITS) throw new Error('RSA key too large');
      if (exponent.length !== RSA_EXPONENT.length || !timingSafeEqual(Buffer.from(exponent), RSA_EXPONENT)) throw new Error('RSA exponent is not 65537');
    }
    return ok({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      algorithm,
      signCount: credential.counter,
      transports: knownTransports(response.response.transports ?? credential.transports),
      aaguid,
      backupEligible: credentialDeviceType === 'multiDevice',
      backedUp: credentialBackedUp,
    });
  } catch (error) {
    logger?.debug('A passkey registration was refused', { reason: reasonOf(error) });
    return err({ kind: 'invalid' });
  }
}

/**
 * Checks a sign-in response against the challenge taken out of the session and the passkey the caller found for it
 * (and matched to the expected account — that is the caller's check). Signature, origin, RP ID, flags and the user
 * verification are the library's and checked again here; the counter rule is ours.
 *
 * The library gets a counter of 0 on purpose: it would throw for a counter that did not advance, which is
 * indistinguishable from any other failure. The rule runs here, after the signature is proven, so only an assertion
 * the key really made can raise a clone suspicion — never a forged one.
 */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expected: RelyingParty & {
    readonly challenge: string;
    /** A sign-in without a username: the response must carry the account's user handle. Sent without it, a handle must still match. */
    readonly discoverable?: boolean;
  },
  stored: StoredPasskey,
  logger?: Logger,
): Promise<Result<VerifiedAuthentication, VerifyError>> {
  let verified;
  try {
    if (isCrossOrigin(response?.response?.clientDataJSON)) throw new Error('cross-origin response');
    if (response.id !== stored.credentialId || response.rawId !== stored.credentialId) throw new Error('response is for another credential');
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: sameChallenge(expected.challenge),
      expectedOrigin: [...expected.origins],
      expectedRPID: expected.rpId,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: 0,
        ...(stored.transports ? { transports: [...stored.transports] } : {}),
      },
    });
    if (!verified.verified) throw new Error('not verified');
    if (verified.authenticationInfo.userVerified !== true) throw new Error('user not verified');
    const flags = Buffer.from(response.response.authenticatorData, 'base64url')[32]!;
    if ((flags & (FLAG_UP | FLAG_UV)) !== (FLAG_UP | FLAG_UV)) throw new Error('user not present and verified');
    // The flag never changes for a key; a change means this is not the key that was registered.
    if (((flags & FLAG_BE) !== 0) !== stored.backupEligible) throw new Error('backup eligibility changed');
    const handle = response.response.userHandle;
    if (expected.discoverable ? !sameHandle(handle, stored.userHandle) : handle !== undefined && handle !== '' && !sameHandle(handle, stored.userHandle)) {
      throw new Error('user handle missing or not the passkey owner\'s');
    }
  } catch (error) {
    logger?.debug('A passkey sign-in was refused', { reason: reasonOf(error) });
    return err({ kind: 'invalid' });
  }
  const { newCounter, credentialBackedUp } = verified.authenticationInfo;
  // Synchronised passkeys report 0 every time and pass; any other counter must move forward, or the key may have been copied.
  if ((newCounter > 0 || stored.signCount > 0) && newCounter <= stored.signCount) {
    logger?.debug('A passkey sign-in was refused', { reason: `counter ${newCounter} did not pass ${stored.signCount}` });
    return err({ kind: 'clone-suspected' });
  }
  return ok({ signCount: newCounter, backedUp: credentialBackedUp });
}

const descriptors = (list: readonly { credentialId: string; transports?: readonly string[] }[]) =>
  list.map((passkey) => ({ id: passkey.credentialId, ...(passkey.transports ? { transports: [...passkey.transports] } : {}) }));

/** Options for `navigator.credentials.create()`: a discoverable credential, user verification required, no attestation. */
export function registrationOptions(
  input: RelyingParty & {
    readonly rpName: string;
    /** The account's random handle (bytes) — never its id or address. */
    readonly userHandle: Uint8Array;
    readonly userName: string;
    readonly userDisplayName: string;
    /** The challenge as bytes; the options carry it base64url. */
    readonly challenge: Uint8Array;
    readonly existing: readonly { credentialId: string; transports?: readonly string[] }[];
  },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rpId,
    userID: input.userHandle as Uint8Array<ArrayBuffer>,
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    challenge: input.challenge as Uint8Array<ArrayBuffer>,
    timeout: PASSKEY_TIMEOUT,
    attestationType: 'none',
    supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: descriptors(input.existing),
  });
}

/**
 * Options for `navigator.credentials.get()`. Without `allow` the list is empty — the passwordless sign-in, where the
 * browser offers the passkeys it holds and the server learns nothing about who exists.
 */
export function authenticationOptions(
  input: Pick<RelyingParty, 'rpId'> & {
    readonly challenge: Uint8Array;
    readonly allow?: readonly { credentialId: string; transports?: readonly string[] }[];
  },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.rpId,
    challenge: input.challenge as Uint8Array<ArrayBuffer>,
    timeout: PASSKEY_TIMEOUT,
    userVerification: 'required',
    ...(input.allow ? { allowCredentials: descriptors(input.allow) } : {}),
  });
}
