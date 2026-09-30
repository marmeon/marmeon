import { createApplication } from '@bespokecore/core';
import { describe, expect, it } from 'vitest';
import { AesGcmEncrypter, DecryptError, Encrypter, EncryptionConfig, EncryptionServiceProvider, generateKey } from './index.ts';

const raw = () => crypto.getRandomValues(new Uint8Array(32));

async function failsToDecrypt(promise: Promise<string>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(DecryptError);
}

describe('AesGcmEncrypter', () => {
  it('round-trips and never produces the same payload twice (random IV)', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const first = await encrypter.encrypt('Grüße 👋');
    const second = await encrypter.encrypt('Grüße 👋');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/); // cookie- and URL-safe
    expect(await encrypter.decrypt(first)).toBe('Grüße 👋');
  });

  it('rejects tampered payloads, foreign keys and garbage', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const payload = await encrypter.encrypt('user=1');
    const bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    bytes[bytes.length - 1]! ^= 1;

    await failsToDecrypt(encrypter.decrypt(bytes.toBase64({ alphabet: 'base64url' })));
    await failsToDecrypt(new AesGcmEncrypter(raw()).decrypt(payload));
    await failsToDecrypt(encrypter.decrypt('not-a-payload'));
    await failsToDecrypt(encrypter.decrypt(''));
  });

  it('binds a payload to its context', async () => {
    const encrypter = new AesGcmEncrypter(raw());
    const payload = await encrypter.encrypt('1', 'cookie:session');
    expect(await encrypter.decrypt(payload, 'cookie:session')).toBe('1');
    await failsToDecrypt(encrypter.decrypt(payload, 'cookie:remember'));
    await failsToDecrypt(encrypter.decrypt(payload));
  });

  it('decrypts with previous keys after a rotation, but encrypts with the current one', async () => {
    const [oldKey, newKey] = [raw(), raw()];
    const before = await new AesGcmEncrypter(oldKey).encrypt('kept');
    const rotated = new AesGcmEncrypter(newKey, [oldKey]);

    expect(await rotated.decrypt(before)).toBe('kept');
    await failsToDecrypt(new AesGcmEncrypter(oldKey).decrypt(await rotated.encrypt('new')));
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => new AesGcmEncrypter(new Uint8Array(16))).toThrow('exactly 32 bytes');
  });
});

describe('EncryptionConfig & provider', () => {
  const boot = (env: Record<string, string>) =>
    createApplication({ root: import.meta.dirname, discover: false, env, providers: [EncryptionServiceProvider] });

  it('binds an Encrypter keyed by APP_KEY, with APP_PREVIOUS_KEYS for rotation', async () => {
    const [current, previous] = [generateKey(), generateKey()];
    const app = await boot({ APP_KEY: current, APP_PREVIOUS_KEYS: ` ${previous} ,` });
    const config = app.container.make(EncryptionConfig);

    expect(config.key).toEqual(Uint8Array.fromBase64(current.slice(7)));
    expect(config.previousKeys).toHaveLength(1);
    expect(app.container.make(Encrypter)).toBe(app.container.make(Encrypter));
    const encrypter = app.container.make(Encrypter);
    expect(await encrypter.decrypt(await encrypter.encrypt('x'))).toBe('x');
  });

  it('refuses to boot without a valid key and says how to fix it', async () => {
    await expect(boot({})).rejects.toThrow(/encryption: APP_KEY — .*bespoke key:generate/);
    await expect(boot({ APP_KEY: 'base64:c2hvcnQ=' })).rejects.toThrow('32 base64-encoded bytes');
    await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: 'nope' })).rejects.toThrow('APP_PREVIOUS_KEYS');
  });
});
