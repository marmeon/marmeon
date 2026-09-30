import { defineConfig, token, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';

/**
 * Symmetric, authenticated encryption with the application key (Laravel's
 * `Encrypter`). Payloads cannot be read or changed without the key.
 *
 * `context` binds a payload to its use: a value encrypted for the cookie
 * `session` does not decrypt as the cookie `remember` (additional authenticated data).
 */
export interface Encrypter {
  encrypt(plaintext: string, context?: string): Promise<string>;
  /** Throws `DecryptError` when the payload was tampered with, belongs to another key or another context. */
  decrypt(payload: string, context?: string): Promise<string>;
}
export const Encrypter = token<Encrypter>('Encrypter');

export class DecryptError extends Error {
  override name = 'DecryptError';
  constructor() {
    super('The payload is invalid.');
  }
}

/** `base64:` + 32 random bytes, as written by `bespoke key:generate`. */
const KEY = v.pipe(
  v.string(),
  v.nonEmpty('Missing — run "bespoke key:generate"'),
  v.check((value) => decodeKey(value) !== undefined, 'Expected "base64:" followed by 32 base64-encoded bytes — run "bespoke key:generate"'),
  v.transform((value) => decodeKey(value)!),
);

export const EncryptionConfig = defineConfig('encryption', {
  env: v.object({
    APP_KEY: v.optional(KEY, ''), // a missing key gets the same helpful message as an empty one
    /** Former keys, comma-separated: payloads encrypted with them still decrypt (key rotation). */
    APP_PREVIOUS_KEYS: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((key) => key.trim()).filter(Boolean)),
        v.array(KEY),
      ),
      '',
    ),
  }),
  resolve: (env) => ({ key: env.APP_KEY, previousKeys: env.APP_PREVIOUS_KEYS }),
});
export type EncryptionConfig = ConfigOf<typeof EncryptionConfig>;

const VERSION = 1;
const IV_BYTES = 12;

/**
 * AES-256-GCM through WebCrypto. Payload: base64url(version · iv · ciphertext+tag).
 * Encrypts with the current key, decrypts with it or any previous key.
 */
export class AesGcmEncrypter implements Encrypter {
  readonly #keys: Promise<CryptoKey>[];

  constructor(key: Uint8Array<ArrayBuffer>, previousKeys: readonly Uint8Array<ArrayBuffer>[] = []) {
    for (const candidate of [key, ...previousKeys]) {
      if (candidate.byteLength !== 32) throw new TypeError('AES-256-GCM needs a key of exactly 32 bytes.');
    }
    this.#keys = [key, ...previousKeys].map((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }

  static fromConfig(config: EncryptionConfig): AesGcmEncrypter {
    return new AesGcmEncrypter(config.key, config.previousKeys);
  }

  async encrypt(plaintext: string, context = ''): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      await this.#keys[0]!,
      encoder.encode(plaintext),
    );
    const payload = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
    payload[0] = VERSION;
    payload.set(iv, 1);
    payload.set(new Uint8Array(ciphertext), 1 + IV_BYTES);
    return payload.toBase64({ alphabet: 'base64url', omitPadding: true });
  }

  async decrypt(payload: string, context = ''): Promise<string> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    } catch {
      throw new DecryptError();
    }
    if (bytes[0] !== VERSION || bytes.byteLength < 1 + IV_BYTES + 16) throw new DecryptError();

    const params = { name: 'AES-GCM', iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: encoder.encode(context) };
    const ciphertext = bytes.subarray(1 + IV_BYTES);
    for (const key of this.#keys) {
      try {
        return decoder.decode(await crypto.subtle.decrypt(params, await key, ciphertext));
      } catch {
        // Wrong key or tampered: try the next key.
      }
    }
    throw new DecryptError();
  }
}

/** A new random application key, formatted for `APP_KEY`. */
export function generateKey(): string {
  return `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`;
}

/** Registers the `Encrypter`, keyed by `APP_KEY`. Found by `bespoke discover`. */
export class EncryptionServiceProvider implements ServiceProvider {
  static config = [EncryptionConfig];

  register(container: Container): void {
    container.singleton(Encrypter, (c) => AesGcmEncrypter.fromConfig(c.make(EncryptionConfig)));
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!value.startsWith('base64:')) return undefined;
  try {
    const bytes = Uint8Array.fromBase64(value.slice('base64:'.length));
    return bytes.byteLength === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
