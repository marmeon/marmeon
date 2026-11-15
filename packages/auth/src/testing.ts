/**
 * Helpers for an app's tests: the code of an authenticator app (`docs/two-factor-authentication.md#testing`) and a software
 * passkey authenticator (`docs/passkeys.md#testing`). `actingAs()` of `@marmeon/testing` uses the session helper.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { cbor } from './cbor.ts';
import { Clock, type Container, type Key } from '@marmeon/core';
import { SessionConfig, sessionCookieName } from '@marmeon/session';
import { Guard, GuardRegistry, type GuardDefinition } from './define-guard.ts';
import { isGuardSlot, slotBindings, slotTarget, type GuardSlot, type TwoFactorGuardSlot } from './guard-slot.ts';
import { APP_GUARD_NAMES, type GuardNames } from './guard-names.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { AuthConfig, rememberCookieName } from './config.ts';
import { TwoFactorState } from './two-factor/state.ts';
import { hotp, base32Decode, totpStep } from './two-factor/totp.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/** The guard a test signs in to: the one `defineGuard()` made, or a slot (`defineGuardSlot()`) the package bound. */
export type ActingAsGuard<U extends { readonly id: string | number }> = GuardDefinition<U> | GuardSlot<U> | TwoFactorGuardSlot<U>;

/** What a test sets about the sign-in it starts with: when the session proved its second factor and when it last typed the password. */
export interface ActingAsProofs {
  /** When the session proved a second factor. Without it, the proof is dated now for an account that has a factor and missing otherwise. */
  readonly twoFactorAt?: Date;
  /** When the session last typed the password, which `confirmedPassword()` reads; the sign-in is dated with it. Without it, the session has not confirmed. */
  readonly confirmedAt?: Date;
}

/** What the session of a sign-in is made of, for the app's guard or one of a package. */
interface SignInTarget {
  readonly names: GuardNames;
  readonly users: UserProvider;
  readonly factors: TwoFactorState;
  readonly fingerprints: SessionFingerprints;
  readonly clock: Clock;
  readonly label: string;
}

/**
 * The guard `guard` stands for in `container`: the guard itself, or what a slot is bound to (`'web'` for the app's users).
 * Anything else, `undefined` included, a guard no provider registered and a slot nobody bound, throws: a test never signs in as another guard's user.
 */
function targetOf(container: Container, guard: unknown): 'web' | Guard {
  if (isGuardSlot(guard)) {
    slotBindings(container);
    return slotTarget(guard, (key) => container.make(key as Key) as never);
  }
  if (!(guard instanceof Guard)) throw new TypeError("actingAs(): `guard` is a guard made by defineGuard() or a guard slot made by defineGuardSlot(); leave `guard` out for the app's own users.");
  if (!container.has(GuardRegistry) || !container.make(GuardRegistry).all().includes(guard)) {
    throw new TypeError(`actingAs(): the guard '${guard.name}' is not registered in this app: its package's provider calls register() on it.`);
  }
  return guard;
}

function unixSeconds(name: string, at: unknown): number {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError(`actingAs(): \`${name}\` takes a valid Date.`);
  return Math.floor(at.getTime() / 1000);
}

/**
 * Session data that signs `user` in, exactly as a login would leave it — what `actingAs(user)` of
 * @marmeon/testing starts a request with. It skips two-factor authentication on purpose: a test that acts as a user
 * gets a signed-in session whether or not the account has a second factor (test the challenge by signing in for real). An account
 * that has a factor counts as having proven it, so the `twoFactor()` middleware lets it through; one without a factor is still sent to set one up.
 *
 * With `guard`, the session is the guard's: its keys, its fingerprint, and a proof only for a factor of the guard's own. Nothing of it
 * signs in the app's user of the same id, and the app's session signs in nobody of the guard. `proofs` dates the second factor and
 * the password confirmation, to test the middleware that asks for them. A `guard` that is passed must be a guard: `undefined` is refused, never read as the app's.
 *
 * Throws when the user does not exist in the guard's own table (the app's without a guard), when the guard is not one or no provider registered it,
 * when a slot is unbound (error A8) and when `twoFactorAt` or `confirmedAt` is not a valid `Date`.
 * See `docs/authentication.md#testing-as-a-guard-of-a-package`.
 */
export async function authenticatedSession<U extends { readonly id: string | number }>(
  container: Container,
  user: NoInfer<U>,
  guard: ActingAsGuard<U>,
  proofs?: ActingAsProofs,
): Promise<Record<string, unknown>>;
export async function authenticatedSession(container: Container, user: AuthUser): Promise<Record<string, unknown>>;
export async function authenticatedSession(container: Container, user: AuthUser | { readonly id: string | number }, ...rest: unknown[]): Promise<Record<string, unknown>> {
  // An absent guard is the app's; one passed as `undefined` (a variable that came up empty) is refused.
  const guard = rest[0];
  const proofs = (rest[1] ?? {}) as ActingAsProofs;
  const id = idOf(user);
  const scope = container.createScope();
  const guarded = rest.length === 0 ? 'web' : targetOf(container, guard);
  const target: SignInTarget =
    guarded === 'web'
      ? {
          names: APP_GUARD_NAMES,
          users: scope.make(UserProvider),
          factors: scope.make(TwoFactorState),
          fingerprints: scope.make(SessionFingerprints),
          clock: scope.make(Clock),
          label: '',
        }
      : (() => {
          const context = scope.make(guarded.tokens.context);
          return { names: context.names, users: context.users(), factors: context.factors(), fingerprints: context.fingerprints, clock: context.clock(), label: ` of the guard '${guarded.name}'` };
        })();
  const credentials = await target.users.findById(id as never);
  if (!credentials) throw new Error(`actingAs(): there is no user ${id}${target.label} — create it first (e.g. with a factory).`);
  const keys = target.names.session;
  const session: Record<string, unknown> = { [keys.id]: id, [keys.password]: target.fingerprints.of(credentials) };
  if (proofs.twoFactorAt !== undefined) session[keys.twoFactorAt] = unixSeconds('twoFactorAt', proofs.twoFactorAt);
  else if ((await target.factors.factors(id)).length > 0) session[keys.twoFactorAt] = Math.floor(target.clock.now() / 1000);
  if (proofs.confirmedAt !== undefined) {
    // A confirmation counts only inside the sign-in it was typed for, so the sign-in is dated with it (never after the clock's now).
    const typed = unixSeconds('confirmedAt', proofs.confirmedAt);
    session[keys.confirmedAt] = typed;
    session[keys.signedInAt] = Math.min(typed, Math.floor(target.clock.now() / 1000));
  }
  return session;
}

/**
 * The names of the session and remember-me cookies of `app` (a `TestApp`, or any `{ container }`): with the `__Host-` prefix when its
 * cookies are `Secure`. Tests send and read cookies under these names, never under literals. With `guard` the remember-me cookie is the
 * guard's own; the session cookie is the one every guard shares. Throws for a guard no provider registered and for a slot nobody bound (error A8).
 * See `docs/authentication.md#testing-as-a-guard-of-a-package`.
 */
export function cookieNames(app: { container: Container }, guard: ActingAsGuard<any>): { session: string; remember: string };
export function cookieNames(app: { container: Container }): { session: string; remember: string };
export function cookieNames(app: { container: Container }, ...rest: unknown[]): { session: string; remember: string } {
  const session = app.container.make(SessionConfig);
  // An absent guard is the app's; one passed as `undefined` (a variable that came up empty) is refused.
  const target = rest.length === 0 ? 'web' : targetOf(app.container, rest[0]);
  if (target === 'web') return { session: sessionCookieName(session), remember: rememberCookieName(app.container.make(AuthConfig), session) };
  return { session: sessionCookieName(session), remember: target.names.rememberCookie(app.container.make(target.tokens.settings), session) };
}

/**
 * The session key that holds the id of whoever is signed in to `guard` (a guard, or a slot, as `actingAs()` takes them): what
 * `assertAuthenticated({ guard })` and `assertGuest({ guard })` of @marmeon/testing read. Throws like `authenticatedSession()` for anything else.
 *
 * @internal
 */
export function guardIdKey(container: Container, guard: unknown): string {
  const target = targetOf(container, guard);
  return (target === 'web' ? APP_GUARD_NAMES : target.names).session.id;
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
