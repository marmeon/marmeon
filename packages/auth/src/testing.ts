import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { cbor } from './cbor.ts';
import type { Container } from '@marmeon/core';
import { AUTH_SESSION_KEYS, sessionFingerprint } from './auth.ts';
import { AccessTokenStore } from './tokens.ts';
import { TwoFactorState } from './two-factor/state.ts';
import { hotp, base32Decode, totpStep } from './two-factor/totp.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/**
 * Session data that signs `user` in, exactly as a login would leave it — what `actingAs(user)` of
 * @marmeon/testing starts a request with. It skips two-factor authentication on purpose: a test that acts as a user
 * gets a signed-in session whether or not the account has a second factor (test the challenge by signing in for real). An account
 * that has a factor counts as having proven it, so the `twoFactor()` middleware lets it through; one without a factor is still sent to set one up.
 */
export async function authenticatedSession(container: Container, user: AuthUser): Promise<Record<string, unknown>> {
  const id = idOf(user);
  const scope = container.createScope();
  const credentials = await scope.make(UserProvider).findById(id as never);
  if (!credentials) throw new Error(`actingAs(): there is no user ${id} — create it first (e.g. with a factory).`);
  const proven = (await scope.make(TwoFactorState).factors(id)).length > 0 ? { [AUTH_SESSION_KEYS.twoFactorAt]: Math.floor(Date.now() / 1000) } : {};
  return { [AUTH_SESSION_KEYS.id]: id, [AUTH_SESSION_KEYS.password]: sessionFingerprint(credentials), ...proven };
}

/** A real API token for `user` with `abilities` — what `actingAs(user, { guard: 'api' })` sends as `Authorization: Bearer …`. */
export async function authenticatedToken(container: Container, user: AuthUser, abilities: readonly string[] = ['*']): Promise<string> {
  const { plainText } = await container.createScope().make(AccessTokenStore).create(idOf(user), 'test', { abilities });
  return plainText;
}

/** The code an authenticator app shows for `secret` (the key `TwoFactor.begin()` hands out) at `at` — for tests that sign in with a second factor. */
export function twoFactorCode(secret: string, at: Date = new Date()): string {
  const key = base32Decode(secret);
  if (key === undefined || key.length === 0) throw new Error('twoFactorCode() needs the Base32 key TwoFactor.begin() returned (the "secret" field).');
  return hotp(key, totpStep(at));
}

// -- A software authenticator -----------------------------------------------------------------------------------------

/** What the authenticator needs from the options the server sent — the shape of `PublicKeyCredential…OptionsJSON`. */
export interface SoftOptions {
  challenge: string;
  user?: { id: string };
  allowCredentials?: readonly { id: string }[];
}

/** A registration response in the WebAuthn JSON shape (`RegistrationResponseJSON`). */
export interface SoftRegistration {
  id: string;
  rawId: string;
  type: 'public-key';
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

/** A sign-in response in the WebAuthn JSON shape (`AuthenticationResponseJSON`). */
export interface SoftAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
}

/** What a test bends in one response: the page it came from, the checks the authenticator did, the counter, the signature. */
export interface SoftOverrides {
  origin?: string;
  rpId?: string;
  /** The challenge to answer instead of the one the server sent. */
  challenge?: string;
  userVerified?: boolean;
  /** Clears the user-present flag. */
  userPresent?: boolean;
  /** Sets or clears the backup-eligible flag, against what the credential was registered with. */
  backupEligible?: boolean;
  crossOrigin?: boolean;
  /** The sign count to report (sign-in only); the default counts up from 1. */
  signCount?: number;
  /** Registration only: the credential id's length in bytes (default 32). */
  credentialIdLength?: number;
  /** Registration only: the transports to report (default `['internal']`). */
  transports?: unknown[];
  /** Signs something else, so the signature does not verify. */
  badSignature?: boolean;
  /** Registration only: `'packed'` sends a self-attestation statement (not valid for anything) instead of `none`. */
  attestation?: 'none' | 'packed';
}

export interface SoftAuthenticatorConfig {
  /** The page the browser is on, as the browser reports it. */
  origin: string;
  /** The relying party ID the authenticator scopes its credentials to. */
  rpId: string;
  /** `'ES256'` (default), `'EdDSA'` or `'RS256'`. */
  algorithm?: 'ES256' | 'EdDSA' | 'RS256';
  /** `'RS256'` only: the key's size and public exponent (default 2048 bits, 65537) — to test the limits on RSA keys. */
  rsa?: { modulusLength?: number; publicExponent?: number };
  /** Whether the user is verified (PIN, biometrics) in every response; default `true`. */
  userVerified?: boolean;
  /** Reports a sign count of 0 every time, as synchronised passkeys do. */
  synced?: boolean;
}

interface SoftCredential {
  id: string;
  key: KeyObject;
  userHandle: string | undefined;
  signCount: number;
}

/**
 * An authenticator in software, for tests: it registers credentials and signs in with them, producing the real
 * WebAuthn JSON a browser would send (attestation `none`, ES256 or EdDSA or RS256 keys made with Node's `crypto`). Hand the
 * options the server returned to `register()` or `authenticate()` and post the result back.
 * `overrides` bends one response — another origin, no user verification, a stale counter — to test the refusals.
 */
export function softAuthenticator(config: SoftAuthenticatorConfig) {
  const credentials: SoftCredential[] = [];
  const algorithm = config.algorithm ?? 'ES256';

  const clientData = (type: string, challenge: string, overrides: SoftOverrides) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: overrides.origin ?? config.origin, crossOrigin: overrides.crossOrigin ?? false }));
  const header = (overrides: SoftOverrides, extra: number, counter: number) => {
    const head = Buffer.alloc(37);
    createHash('sha256')
      .update(overrides.rpId ?? config.rpId)
      .digest()
      .copy(head, 0);
    const eligible = overrides.backupEligible ?? config.synced === true;
    // A synchronised passkey is backup eligible and backed up (BE 0x08, BS 0x10).
    head[32] = ((overrides.userPresent ?? true) ? 0x01 : 0) | ((overrides.userVerified ?? config.userVerified ?? true) ? 0x04 : 0) | (eligible ? 0x08 : 0) | (config.synced ? 0x10 : 0) | extra;
    head.writeUInt32BE(counter, 33);
    return head;
  };

  return {
    /** The ids of the credentials made so far. */
    get credentialIds(): string[] {
      return credentials.map((credential) => credential.id);
    },

    register(options: SoftOptions, overrides: SoftOverrides = {}): SoftRegistration {
      const { publicKey, privateKey } =
        algorithm === 'EdDSA'
          ? generateKeyPairSync('ed25519')
          : algorithm === 'RS256'
            ? generateKeyPairSync('rsa', { modulusLength: config.rsa?.modulusLength ?? 2048, publicExponent: config.rsa?.publicExponent ?? 65_537 })
            : generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const credentialId = randomBytes(overrides.credentialIdLength ?? 32);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([header(overrides, 0x40, 0), Buffer.alloc(16), idLength, credentialId, coseKey(publicKey, algorithm)]);
      const id = credentialId.toString('base64url');
      credentials.push({ id, key: privateKey, userHandle: options.user?.id, signCount: 0 });
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData('webauthn.create', overrides.challenge ?? options.challenge, overrides).toString('base64url'),
          attestationObject: cbor(
            new Map<unknown, unknown>([
              ['fmt', overrides.attestation ?? 'none'],
              // A `packed` statement that proves nothing: the server must not depend on it.
              ['attStmt', overrides.attestation === 'packed' ? new Map<unknown, unknown>([['alg', -7], ['sig', Buffer.from('not a signature')]]) : new Map()],
              ['authData', authData],
            ]),
          ).toString('base64url'),
          transports: (overrides.transports ?? ['internal']) as string[],
        },
      };
    },

    authenticate(options: SoftOptions, overrides: SoftOverrides = {}): SoftAssertion {
      const allowed = options.allowCredentials?.map((credential) => credential.id);
      const credential = [...credentials].reverse().find((candidate) => allowed === undefined || allowed.length === 0 || allowed.includes(candidate.id));
      if (!credential) throw new Error('softAuthenticator: it holds no credential for these options — register() first.');
      credential.signCount += 1;
      const counter = overrides.signCount ?? (config.synced ? 0 : credential.signCount);
      const authData = header(overrides, 0, counter);
      const data = clientData('webauthn.get', overrides.challenge ?? options.challenge, overrides);
      const message = Buffer.concat([overrides.badSignature ? Buffer.from('another message') : authData, createHash('sha256').update(data).digest()]);
      const signature = algorithm === 'EdDSA' ? sign(null, message, credential.key) : algorithm === 'RS256' ? sign('sha256', message, credential.key) : sign('sha256', message, { key: credential.key, dsaEncoding: 'der' });
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          ...(credential.userHandle === undefined ? {} : { userHandle: credential.userHandle }),
        },
      };
    },
  };
}

/** The COSE_Key (RFC 9052) of a public key, CBOR-encoded: ES256 as EC2 on P-256, EdDSA as OKP on Ed25519. */
function coseKey(publicKey: KeyObject, algorithm: 'ES256' | 'EdDSA' | 'RS256'): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const part = (name: 'x' | 'y' | 'n' | 'e') => Buffer.from(jwk[name] as string, 'base64url');
  if (algorithm === 'RS256') return cbor(new Map<unknown, unknown>([[1, 3], [3, -257], [-1, part('n')], [-2, part('e')]]));
  return algorithm === 'EdDSA'
    ? cbor(new Map<unknown, unknown>([[1, 1], [3, -8], [-1, 6], [-2, part('x')]]))
    : cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, part('x')], [-3, part('y')]]));
}
