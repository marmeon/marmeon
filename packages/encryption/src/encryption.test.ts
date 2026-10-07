import * as nodeCrypto from 'node:crypto';
import { createApplication } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { AesGcmEncrypter, DecryptError, Encrypter, EncryptionConfig, EncryptionServiceProvider, generateKey } from './index.ts';

// Counts the keys the encrypter imports (W8 step 9: once, never per payload).
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

  it('imports its keys once — not for every payload (W8 step 9)', async () => {
    const imported = vi.mocked(nodeCrypto.createSecretKey);
    imported.mockClear();
    const encrypter = new AesGcmEncrypter(raw(), [raw()]);
    expect(imported).toHaveBeenCalledTimes(2);
    // 50 requests' worth: a cookie decrypted, two encrypted — with the previous key tried too.
    const old = await new AesGcmEncrypter(raw()).encrypt('x');
    imported.mockClear();
    for (let i = 0; i < 50; i++) {
      await encrypter.decrypt(await encrypter.encrypt(`session ${i}`, 'cookie:marmeon_session'), 'cookie:marmeon_session');
      await failsToDecrypt(encrypter.decrypt(old));
    }
    expect(imported).not.toHaveBeenCalled();
  });
});

/**
 * The encrypter as it was until Wave 8 step 9 — AES-256-GCM through WebCrypto, the same payload layout. Cookies, encrypted
 * sessions (SESSION_ENCRYPT) and every other payload written by it must still decrypt, with the current and the previous keys.
 */
class WebCryptoEncrypter {
  readonly #keys: Promise<CryptoKey>[];

  constructor(key: Uint8Array<ArrayBuffer>, previousKeys: readonly Uint8Array<ArrayBuffer>[] = []) {
    this.#keys = [key, ...previousKeys].map((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }

  async encrypt(plaintext: string, context = ''): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, await this.#keys[0]!, new TextEncoder().encode(plaintext));
    const payload = new Uint8Array(1 + 12 + ciphertext.byteLength);
    payload[0] = 1;
    payload.set(iv, 1);
    payload.set(new Uint8Array(ciphertext), 13);
    return payload.toBase64({ alphabet: 'base64url', omitPadding: true });
  }

  async decrypt(payload: string, context = ''): Promise<string> {
    const bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    for (const key of this.#keys) {
      try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13), additionalData: new TextEncoder().encode(context) }, await key, bytes.subarray(13)));
      } catch {
        // the next key
      }
    }
    throw new DecryptError();
  }
}

describe('AesGcmEncrypter and the WebCrypto encrypter before it (W8 step 9)', () => {
  const texts = ['', 'user=1', 'Grüße 👋', 'x'.repeat(5000), JSON.stringify({ _token: 'abc', _flash_messages: [{ id: 'm1', text: '✓ Saved' }] })];

  it('decrypts what WebCrypto encrypted — every text, every context, with the current and a previous key', async () => {
    const [oldKey, newKey] = [raw(), raw()];
    const now = new AesGcmEncrypter(newKey, [oldKey]);
    for (const text of texts) {
      for (const context of ['', 'cookie:marmeon_session', 'session:' + 'a'.repeat(64)]) {
        expect(await now.decrypt(await new WebCryptoEncrypter(newKey).encrypt(text, context), context)).toBe(text);
        expect(await now.decrypt(await new WebCryptoEncrypter(oldKey).encrypt(text, context), context)).toBe(text);
        await failsToDecrypt(now.decrypt(await new WebCryptoEncrypter(newKey).encrypt(text, context), `${context}x`));
      }
    }
  });

  it('writes what WebCrypto decrypts — the same layout, the tag last, the context as additional data', async () => {
    const [oldKey, newKey] = [raw(), raw()];
    for (const text of texts) {
      const payload = await new AesGcmEncrypter(newKey).encrypt(text, 'cookie:XSRF-TOKEN');
      expect(await new WebCryptoEncrypter(newKey).decrypt(payload, 'cookie:XSRF-TOKEN')).toBe(text);
      expect(await new WebCryptoEncrypter(raw(), [newKey]).decrypt(payload, 'cookie:XSRF-TOKEN')).toBe(text);
      await expect(new WebCryptoEncrypter(oldKey).decrypt(payload, 'cookie:XSRF-TOKEN')).rejects.toBeInstanceOf(DecryptError);
      await expect(new WebCryptoEncrypter(newKey).decrypt(payload, 'cookie:other')).rejects.toBeInstanceOf(DecryptError);
    }
  });

  it('refuses a WebCrypto payload that was tampered with or cut short — the full 16-byte tag only', async () => {
    const key = raw();
    const payload = await new WebCryptoEncrypter(key).encrypt('user=1', 'c');
    const bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    const encrypter = new AesGcmEncrypter(key);
    for (const index of [0, 5, 13, bytes.length - 1]) {
      const changed = bytes.slice();
      changed[index]! ^= 1;
      await failsToDecrypt(encrypter.decrypt(changed.toBase64({ alphabet: 'base64url' }), 'c'));
    }
    // A shorter tag (WebCrypto's tagLength 96, say) never passes as the 128-bit one.
    await failsToDecrypt(encrypter.decrypt(bytes.subarray(0, bytes.length - 4).toBase64({ alphabet: 'base64url' }), 'c'));
    await failsToDecrypt(encrypter.decrypt(bytes.subarray(0, 1 + 12 + 15).toBase64({ alphabet: 'base64url' }), 'c'));
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
    await expect(boot({})).rejects.toThrow(/encryption: APP_KEY — .*marmeon key:generate/);
    await expect(boot({ APP_KEY: 'base64:c2hvcnQ=' })).rejects.toThrow('32 base64-encoded bytes');
    await expect(boot({ APP_KEY: generateKey(), APP_PREVIOUS_KEYS: 'nope' })).rejects.toThrow('APP_PREVIOUS_KEYS');
  });
});
