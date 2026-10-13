import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MemorySessionStore, plainSessionCodec, Session, type SessionConfig } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { softAuthenticator } from '../testing.ts';
import { issueChallenge, takeChallenge } from './challenge.ts';
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration, type RelyingParty, type StoredPasskey } from './webauthn.ts';

const relyingParty: RelyingParty = { rpId: 'localhost', origins: ['http://localhost:3000'] };
const authenticatorFor = (algorithm: 'ES256' | 'EdDSA' = 'ES256') => softAuthenticator({ origin: 'http://localhost:3000', rpId: 'localhost', algorithm });
const userHandle = Buffer.alloc(32, 7);
const handle = userHandle.toString('base64url');

async function creation(challenge = Buffer.alloc(32, 1)) {
  const options = await registrationOptions({
    ...relyingParty,
    rpName: 'Notes',
    userHandle,
    userName: 'ada@example.com',
    userDisplayName: 'Ada',
    challenge,
    existing: [],
  });
  return options;
}

async function request(challenge = Buffer.alloc(32, 2), allow?: { credentialId: string }[]) {
  return authenticationOptions({ rpId: 'localhost', challenge, ...(allow ? { allow } : {}) });
}

/** A registered passkey of `authenticator`, as the store would keep it. */
async function enrol(authenticator: ReturnType<typeof authenticatorFor>): Promise<StoredPasskey> {
  const options = await creation();
  const result = await verifyRegistration(authenticator.register(options), { ...relyingParty, challenge: options.challenge });
  if (!result.ok) throw new Error('the registration was refused');
  return { credentialId: result.value.credentialId, publicKey: result.value.publicKey, signCount: result.value.signCount, userHandle: handle, backupEligible: result.value.backupEligible };
}

describe('the options', () => {
  it('ask for a discoverable credential with user verification, no attestation, and the three algorithms', async () => {
    const options = await creation();
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
    expect(options.timeout).toBe(300_000);
    expect(options.rp.id).toBe('localhost');
    expect(options.user.id).toBe(userHandle.toString('base64url'));
    expect(options.challenge).toBe(Buffer.alloc(32, 1).toString('base64url'));
  });

  it('send an empty allow list for the passwordless sign-in and require user verification', async () => {
    const options = await request();
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('localhost');
  });
});

describe.each(['ES256', 'EdDSA'] as const)('registration and sign-in with %s', (algorithm) => {
  it('registers a passkey and signs in with it, the counter moving forward', async () => {
    const authenticator = authenticatorFor(algorithm);
    const options = await creation();
    const registered = await verifyRegistration(authenticator.register(options), { ...relyingParty, challenge: options.challenge });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.algorithm).toBe(algorithm === 'ES256' ? -7 : -8);
    expect(registered.value.signCount).toBe(0);
    let stored: StoredPasskey = { credentialId: registered.value.credentialId, publicKey: registered.value.publicKey, signCount: 0, userHandle: handle, backupEligible: false };

    for (const expectedCount of [1, 2]) {
      const challenge = await request(Buffer.alloc(32, expectedCount + 10), [stored]);
      const signedIn = await verifyAuthentication(authenticator.authenticate(challenge), { ...relyingParty, challenge: challenge.challenge }, stored);
      expect(signedIn).toMatchObject({ ok: true, value: { signCount: expectedCount } });
      stored = { ...stored, signCount: expectedCount };
    }
  });
});

describe('a registration is refused when', () => {
  const refuse = async (overrides: Parameters<ReturnType<typeof authenticatorFor>['register']>[1], expected: Partial<RelyingParty> & { challenge?: string } = {}) => {
    const options = await creation();
    const result = await verifyRegistration(authenticatorFor().register(options, overrides), { ...relyingParty, challenge: options.challenge, ...expected });
    expect(result).toEqual({ ok: false, error: { kind: 'invalid' } });
  };

  it('it comes from another origin', () => refuse({ origin: 'https://evil.example' }));
  it('it comes from http://127.0.0.1 instead of localhost', () => refuse({ origin: 'http://127.0.0.1:3000' }));
  it('it was made for another RP ID', () => refuse({ rpId: 'example.com' }));
  it('it answers another challenge', () => refuse({ challenge: Buffer.alloc(32, 9).toString('base64url') }));
  it('the authenticator did not verify the user', () => refuse({ userVerified: false }));
  it('the page was in a frame of another site (crossOrigin)', () => refuse({ crossOrigin: true }));
  it('the user was not present, though verified', () => refuse({ userPresent: false }));

  it('the credential id is 1024 bytes, one over the limit', () => refuse({ credentialIdLength: 1024 }));

  it('accepts a credential id of 1023 bytes', async () => {
    const options = await creation();
    const result = await verifyRegistration(authenticatorFor().register(options, { credentialIdLength: 1023 }), { ...relyingParty, challenge: options.challenge });
    expect(result.ok).toBe(true);
  });

  it('keeps only known transports, at most five', async () => {
    const options = await creation();
    const register = async (transports: unknown[]) => {
      const result = await verifyRegistration(authenticatorFor().register(options, { transports }), { ...relyingParty, challenge: options.challenge });
      if (!result.ok) throw new Error('refused');
      return result.value.transports;
    };
    expect(await register(['usb', 'carrier-pigeon', 7, null, 'hybrid'])).toEqual(['usb', 'hybrid']);
    expect(await register(Array(9).fill('usb'))).toEqual(Array(5).fill('usb'));
  });

  it('it is checked against another RP ID than the one the options named', () => refuse({}, { rpId: 'example.com' }));

  it('it is not a response at all', async () => {
    const result = await verifyRegistration({} as never, { ...relyingParty, challenge: 'x' });
    expect(result).toEqual({ ok: false, error: { kind: 'invalid' } });
  });
});

describe('a sign-in is refused when', () => {
  const setup = async () => {
    const authenticator = authenticatorFor();
    const stored = await enrol(authenticator);
    const options = await request(Buffer.alloc(32, 3), [stored]);
    return { authenticator, stored, options };
  };
  const refuse = async (overrides: Parameters<ReturnType<typeof authenticatorFor>['authenticate']>[1], kind: 'invalid' | 'clone-suspected' = 'invalid', tweak?: (stored: StoredPasskey) => StoredPasskey) => {
    const { authenticator, stored, options } = await setup();
    const result = await verifyAuthentication(authenticator.authenticate(options, overrides), { ...relyingParty, challenge: options.challenge }, tweak ? tweak(stored) : stored);
    expect(result).toEqual({ ok: false, error: { kind } });
  };

  it('it comes from another origin', () => refuse({ origin: 'https://evil.example' }));
  it('it comes from http://127.0.0.1 instead of localhost', () => refuse({ origin: 'http://127.0.0.1:3000' }));
  it('it was made for another RP ID', () => refuse({ rpId: 'example.com' }));
  it('it answers another challenge', () => refuse({ challenge: Buffer.alloc(32, 9).toString('base64url') }));
  it('the authenticator did not verify the user', () => refuse({ userVerified: false }));
  it('the user was not present, though verified', () => refuse({ userPresent: false }));
  it('the signature is wrong', () => refuse({ badSignature: true }));
  it('the page was in a frame of another site (crossOrigin)', () => refuse({ crossOrigin: true }));

  it('the credential belongs to another passkey (another account)', async () => {
    const other = await enrol(authenticatorFor());
    await refuse({}, 'invalid', (stored) => ({ ...other, signCount: stored.signCount }));
  });

  it('the passkey became backup eligible (or stopped being) since it was registered', async () => {
    await refuse({ backupEligible: true });
    await refuse({}, 'invalid', (stored) => ({ ...stored, backupEligible: true }));
  });

  it('a discoverable sign-in carries no user handle, or another one', async () => {
    const { authenticator, stored, options } = await setup();
    const expected = { ...relyingParty, challenge: options.challenge, discoverable: true };
    const response = authenticator.authenticate(options);
    expect(await verifyAuthentication(response, expected, stored)).toMatchObject({ ok: true });
    delete response.response.userHandle;
    expect(await verifyAuthentication(response, expected, stored)).toEqual({ ok: false, error: { kind: 'invalid' } });
    response.response.userHandle = Buffer.alloc(32, 8).toString('base64url');
    expect(await verifyAuthentication(response, expected, stored)).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('a handle is sent that is not the passkey owner\'s, though none was required', async () => {
    const { authenticator, stored, options } = await setup();
    const response = authenticator.authenticate(options);
    response.response.userHandle = Buffer.alloc(32, 8).toString('base64url');
    expect(await verifyAuthentication(response, { ...relyingParty, challenge: options.challenge }, stored)).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('the counter does not move forward: possibly a clone', async () => {
    await refuse({ signCount: 5 }, 'clone-suspected', (stored) => ({ ...stored, signCount: 5 }));
    await refuse({ signCount: 3 }, 'clone-suspected', (stored) => ({ ...stored, signCount: 9 }));
  });

  it('a forged response never raises a clone suspicion: the signature is checked first', async () => {
    await refuse({ signCount: 3, badSignature: true }, 'invalid', (stored) => ({ ...stored, signCount: 9 }));
  });

  it('accepts a synchronised passkey that reports 0 every time', async () => {
    const authenticator = softAuthenticator({ origin: 'http://localhost:3000', rpId: 'localhost', synced: true });
    const stored = await enrol(authenticator);
    const options = await request(Buffer.alloc(32, 4), [stored]);
    const result = await verifyAuthentication(authenticator.authenticate(options), { ...relyingParty, challenge: options.challenge }, stored);
    expect(result).toMatchObject({ ok: true, value: { signCount: 0 } });
  });

  it('does not tell the client why', async () => {
    const { authenticator, stored, options } = await setup();
    const result = await verifyAuthentication(authenticator.authenticate(options, { userVerified: false }), { ...relyingParty, challenge: options.challenge }, stored);
    expect(JSON.stringify(result)).not.toMatch(/verif|origin|challenge/i);
  });
});

describe('the challenge in the session', () => {
  const config = { lifetime: 120 } as SessionConfig;
  const startSession = async () => {
    const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
    await session.start();
    return session;
  };
  const now = 1_000_000;

  it('works once, for its purpose: taking it removes it even when the check after fails', async () => {
    const session = await startSession();
    const { challenge } = issueChallenge(session, 'sign-in', now);
    expect(takeChallenge(session, 'sign-in', now + 1)).toEqual({ ok: true, value: { challenge } });
    expect(takeChallenge(session, 'sign-in', now + 1)).toEqual({ ok: false, error: { kind: 'no-challenge' } });
  });

  it('is gone after a refused take: a wrong purpose burns it', async () => {
    const session = await startSession();
    issueChallenge(session, 'sign-in', now);
    expect(takeChallenge(session, 'register', now + 1)).toEqual({ ok: false, error: { kind: 'invalid' } });
    expect(takeChallenge(session, 'sign-in', now + 1)).toEqual({ ok: false, error: { kind: 'no-challenge' } });
  });

  it('expires after five minutes', async () => {
    const session = await startSession();
    issueChallenge(session, 'sign-in', now);
    expect(takeChallenge(session, 'sign-in', now + 300)).toEqual({ ok: false, error: { kind: 'expired' } });
  });

  it('belongs to the account it was issued for', async () => {
    const session = await startSession();
    issueChallenge(session, 'second-factor', now, 7);
    expect(takeChallenge(session, 'second-factor', now + 1, 8)).toEqual({ ok: false, error: { kind: 'invalid' } });
    issueChallenge(session, 'second-factor', now, 7);
    expect(takeChallenge(session, 'second-factor', now + 1, 7).ok).toBe(true);
  });

  it('refuses a challenge for an account when none is named, and the reverse', async () => {
    const session = await startSession();
    issueChallenge(session, 'second-factor', now, 7);
    expect(takeChallenge(session, 'second-factor', now + 1)).toEqual({ ok: false, error: { kind: 'invalid' } });
    issueChallenge(session, 'sign-in', now);
    expect(takeChallenge(session, 'sign-in', now + 1, 7)).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('is replaced by a newer one: a session holds one', async () => {
    const session = await startSession();
    const first = issueChallenge(session, 'sign-in', now);
    const second = issueChallenge(session, 'sign-in', now);
    expect(second.challenge).not.toBe(first.challenge);
    expect(takeChallenge(session, 'sign-in', now + 1)).toEqual({ ok: true, value: { challenge: second.challenge } });
  });

  it('is not there in a session that never started', () => {
    const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
    expect(takeChallenge(session, 'sign-in', now)).toEqual({ ok: false, error: { kind: 'no-challenge' } });
  });
});

describe('the import boundary', () => {
  const library = '@simplewebauthn/server';
  const src = resolve(import.meta.dirname, '..');

  /** Every source file reachable from `entry` through relative imports. */
  function reachable(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const text = readFileSync(entry, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+\.ts)'/g)) reachable(resolve(dirname(entry), match[1]!), seen);
    return seen;
  }

  it.each(['index.ts', 'two-factor/index.ts'])('%s never reaches the library or the passkeys subpath', (entry) => {
    for (const file of reachable(resolve(src, entry))) {
      expect(file, 'the passkeys subpath is reachable from the main entry').not.toContain('/passkeys/');
      expect(readFileSync(file, 'utf8'), file).not.toContain(library);
      expect(readFileSync(file, 'utf8'), file).not.toContain('@marmeon/auth/passkeys');
    }
  });

  it('only passkeys/webauthn.ts imports the library', () => {
    const importers = [...reachable(resolve(src, 'passkeys/index.ts'))].filter((file) => readFileSync(file, 'utf8').includes(`'${library}`));
    expect(importers.map((file) => file.slice(src.length + 1))).toEqual(['passkeys/webauthn.ts']);
  });
});
