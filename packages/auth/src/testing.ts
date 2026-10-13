import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
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
}

export interface SoftAuthenticatorConfig {
  /** The page the browser is on, as the browser reports it. */
  origin: string;
  /** The relying party ID the authenticator scopes its credentials to. */
  rpId: string;
  /** `'ES256'` (default) or `'EdDSA'`. */
  algorithm?: 'ES256' | 'EdDSA';
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
 * WebAuthn JSON a browser would send (attestation `none`, ES256 or EdDSA keys made with Node's `crypto`). Hand the
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
      const { publicKey, privateKey } = algorithm === 'EdDSA' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
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
              ['fmt', 'none'],
              ['attStmt', new Map()],
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
      const signature = algorithm === 'EdDSA' ? sign(null, message, credential.key) : sign('sha256', message, { key: credential.key, dsaEncoding: 'der' });
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
function coseKey(publicKey: KeyObject, algorithm: 'ES256' | 'EdDSA'): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const part = (name: 'x' | 'y') => Buffer.from(jwk[name] as string, 'base64url');
  return algorithm === 'EdDSA'
    ? cbor(new Map<unknown, unknown>([[1, 1], [3, -8], [-1, 6], [-2, part('x')]]))
    : cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, part('x')], [-3, part('y')]]));
}

/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key: integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const two = Buffer.alloc(3);
    two[0] = (major << 5) | 25;
    two.writeUInt16BE(length, 1);
    return two;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('softAuthenticator: cannot encode this value.');
}
