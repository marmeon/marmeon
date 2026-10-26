import * as nodeCrypto from 'node:crypto';
import { createApplication, ErrorSolutions } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { AesGcmEncrypter, DecryptError, Encrypter, EncryptionConfig, EncryptionServiceProvider, generateKey } from './index.ts';

// Counts the keys the encrypter imports (once, never per payload).
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, createSecretKey: vi.fn(actual.createSecretKey) };
});

const raw = () => crypto.getRandomValues(new Uint8Array(32));

async function failsToDecrypt(promise: Promise<string>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(DecryptError);
}

describe('AesGcmEncrypter', () => {
  it('round-trips and never produces the same payload twice (random IV)', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const first = await encrypter.encrypt('Grüße 👋', 'test');
    const second = await encrypter.encrypt('Grüße 👋', 'test');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/); // cookie- and URL-safe
    expect(await encrypter.decrypt(first, 'test')).toBe('Grüße 👋');
  });

  it('a payload that does not decrypt says so with its code, and the solution carries it', async () => {
    const error = await new AesGcmEncrypter(raw()).decrypt('garbage', 'test').catch((failure: unknown) => failure);
    expect((error as Error).message).toBe('[marmeon:A4] The payload is invalid.');
    const [solution] = await new ErrorSolutions(EncryptionServiceProvider.solutions).find(error as Error);
    expect(solution).toMatchObject({ title: 'Find out why a payload does not decrypt', code: 'A4' });
  });

  it('rejects tampered payloads, foreign keys and garbage', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const payload = await encrypter.encrypt('user=1', 'test');
    const bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    bytes[bytes.length - 1]! ^= 1;

    await failsToDecrypt(encrypter.decrypt(bytes.toBase64({ alphabet: 'base64url' }), 'test'));
    await failsToDecrypt(new AesGcmEncrypter(raw()).decrypt(payload, 'test'));
    await failsToDecrypt(encrypter.decrypt('not-a-payload', 'test'));
    await failsToDecrypt(encrypter.decrypt('', 'test'));
  });

  it('binds a payload to its context', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const payload = await encrypter.encrypt('1', 'cookie:session');
    expect(await encrypter.decrypt(payload, 'cookie:session')).toBe('1');
    await failsToDecrypt(encrypter.decrypt(payload, 'cookie:remember'));
    await failsToDecrypt(encrypter.decrypt(payload, 'cookie:session:x'));
  });

  it('decrypts with previous keys after a rotation, but encrypts with the current one', async () => {
    const [oldKey, newKey] = [raw(), raw()];
    const before = await new AesGcmEncrypter(oldKey).encrypt('kept', 'test');
    const rotated = new AesGcmEncrypter(newKey, [oldKey]);

    expect(await rotated.decrypt(before, 'test')).toBe('kept');
    await failsToDecrypt(new AesGcmEncrypter(oldKey).decrypt(await rotated.encrypt('new', 'test'), 'test'));
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => new AesGcmEncrypter(new Uint8Array(16))).toThrow('exactly 32 bytes');
  });

  it('imports its keys once — not for every payload', async () => {
    const imported = vi.mocked(nodeCrypto.createSecretKey);
    imported.mockClear();
    const encrypter = new AesGcmEncrypter(raw(), [raw()]);
    expect(imported).toHaveBeenCalledTimes(2);
    // 50 requests' worth: a cookie decrypted, two encrypted — with the previous key tried too.
    const old = await new AesGcmEncrypter(raw()).encrypt('x', 'test');
    imported.mockClear();
    for (let i = 0; i < 50; i++) {
      await encrypter.decrypt(await encrypter.encrypt(`session ${i}`, 'cookie:marmeon_session'), 'cookie:marmeon_session');
      await failsToDecrypt(encrypter.decrypt(old, 'cookie:marmeon_session'));
    }
    expect(imported).not.toHaveBeenCalled();
  });
});

describe('the context of every encryption', () => {
  it('is required: encrypt(x) and decrypt(x) do not type-check', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    // @ts-expect-error a context is required
    await encrypter.encrypt('x').catch(() => undefined);
    // @ts-expect-error a context is required
    await encrypter.decrypt('x').catch(() => undefined);
    // @ts-expect-error the interface requires it too
    await (encrypter as Encrypter).encrypt('x').catch(() => undefined);
  });

  it('refuses the empty context at run time, for encrypt and decrypt', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    await expect(encrypter.encrypt('x', '')).rejects.toThrow(TypeError);
    await expect(encrypter.encrypt('x', '')).rejects.toThrow("encrypt(value, 'billing:coupon')");
    await expect(encrypter.decrypt(await encrypter.encrypt('x', 'a'), '')).rejects.toThrow(TypeError);
    // An untyped caller that passes nothing is refused the same way.
    await expect((encrypter as unknown as { encrypt(plaintext: string): Promise<string> }).encrypt('x')).rejects.toThrow(TypeError);
  });

  it('does not decrypt a value of context a with context b', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const payload = await encrypter.encrypt('discount', 'billing:coupon');
    expect(await encrypter.decrypt(payload, 'billing:coupon')).toBe('discount');
    await failsToDecrypt(encrypter.decrypt(payload, 'billing:role'));
  });

  it('keeps the format: payloads made before keep reading with their context', async () => {
    const key = Uint8Array.fromBase64('J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=');
    const encrypter = new AesGcmEncrypter(key);
    // version 1 · iv · ciphertext · tag, the context as additional data: written by hand, not by the class under test.
    const fixture = await sealByHand(key, 'cookie:marmeon_session');
    expect(await encrypter.decrypt(fixture, 'cookie:marmeon_session')).toBe('fixture');
    expect(Uint8Array.fromBase64(fixture, { alphabet: 'base64url' })[0]).toBe(1);
  });
});

/** The format written out by hand with node:crypto, independent of the class under test: version 1, IV 01..0b, AAD = context. */
async function sealByHand(key: Uint8Array, context: string): Promise<string> {
  const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update('fixture', 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, body, cipher.getAuthTag()]).toString('base64url');
}

describe('AesGcmEncrypter payload', () => {
  it('refuses a payload that was tampered with or cut short — the full 16-byte tag only', async () => {
    const key = raw();
    const encrypter = new AesGcmEncrypter(key);
    const bytes = Uint8Array.fromBase64(await encrypter.encrypt('user=1', 'c'), { alphabet: 'base64url' });
    for (const index of [0, 5, 13, bytes.length - 1]) {
      const changed = bytes.slice();
      changed[index]! ^= 1;
      await failsToDecrypt(encrypter.decrypt(changed.toBase64({ alphabet: 'base64url' }), 'c'));
    }
    // A shorter tag never passes as the 128-bit one.
    await failsToDecrypt(encrypter.decrypt(bytes.subarray(0, bytes.length - 4).toBase64({ alphabet: 'base64url' }), 'c'));
    await failsToDecrypt(encrypter.decrypt(bytes.subarray(0, 1 + 12 + 15).toBase64({ alphabet: 'base64url' }), 'c'));
  });
});

describe('EncryptionConfig & provider', () => {
  const boot = (env: Record<string, string>) =>
    createApplication({ root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider] }, { env });

  it('binds an Encrypter keyed by APP_KEY, with APP_PREVIOUS_KEYS for rotation', async () => {
    const [current, previous] = [generateKey(), generateKey()];
    const app = await boot({ APP_KEY: current, APP_PREVIOUS_KEYS: ` ${previous} ,` });
    const config = app.container.make(EncryptionConfig);

    expect(config.key).toEqual(Uint8Array.fromBase64(current.slice(7)));
    expect(config.previousKeys).toHaveLength(1);
    expect(app.container.make(Encrypter)).toBe(app.container.make(Encrypter));
    const encrypter = app.container.make(Encrypter);
    expect(await encrypter.decrypt(await encrypter.encrypt('x', 'test'), 'test')).toBe('x');
  });

  it('refuses to boot without a valid key and says how to fix it', async () => {
    await expect(boot({})).rejects.toThrow(/encryption: APP_KEY — .*marmeon key:generate/);
    await expect(boot({ APP_KEY: 'base64:c2hvcnQ=' })).rejects.toThrow('32 base64-encoded bytes');
    await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: 'nope' })).rejects.toThrow('APP_PREVIOUS_KEYS');
  });

  describe('the public test key', () => {
    const publicKey = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

    it.each<Record<string, string>>([{ NODE_ENV: 'production' }, {}, { NODE_ENV: '' }])('is refused outside development and tests (%j)', async (node) => {
      await expect(boot({ APP_KEY: publicKey, ...node })).rejects.toThrow(/encryption: APP_KEY — APP_KEY is the public test key.*marmeon key:generate/);
    });

    it('does not get past an unknown NODE_ENV', async () => {
      await expect(boot({ APP_KEY: publicKey, NODE_ENV: 'staging' })).rejects.toThrow('NODE_ENV=staging');
    });

    // The same bytes in another spelling: no padding, other trailing bits, whitespace inside.
    const spellings = ['base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY', 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvZ=', 'base64:J1THMmM0weaSNoc1xHnSWExH WTxE/5A9NwgE4YJajvY='];

    it.each(spellings)('is refused in every spelling: %s', async (spelling) => {
      await expect(boot({ APP_KEY: spelling, NODE_ENV: 'production' })).rejects.toThrow('public test key');
      await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: spelling, NODE_ENV: 'production' })).rejects.toThrow('public test key');
    });

    it('is refused among APP_PREVIOUS_KEYS outside development and tests, and accepted in test', async () => {
      const previous = `${generateKey()},${publicKey}`;
      await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: previous, NODE_ENV: 'production' })).rejects.toThrow(/encryption: APP_PREVIOUS_KEYS — APP_PREVIOUS_KEYS lists the public test key/);
      await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: previous })).rejects.toThrow('public test key');
      expect(await boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: previous, NODE_ENV: 'test' })).toBeDefined();
    });

    it.each(['test', 'development'])('is accepted with NODE_ENV=%s', async (NODE_ENV) => {
      expect(await boot({ APP_KEY: publicKey, NODE_ENV })).toBeDefined();
    });

    it('does not stop another valid key in production', async () => {
      expect(await boot({ APP_KEY: generateKey(), NODE_ENV: 'production' })).toBeDefined();
    });
  });
});
