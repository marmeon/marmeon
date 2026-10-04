import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { defineConfig, defineSolutions, token, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
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
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * AES-256-GCM through `node:crypto`. Payload: base64url(version · iv · ciphertext · tag) — the 16-byte tag last, as WebCrypto
 * writes it (the encrypter used WebCrypto until Wave 8 step 9: every payload written before still decrypts, and the other way
 * round). Encrypts with the current key, decrypts with it or any previous key. The keys are imported once (`KeyObject`s). A
 * session payload of 250 bytes: ≈ 3.9 µs to encrypt, ≈ 2.8 µs to decrypt — through WebCrypto (a job per call, its promise) it
 * was ≈ 18.5 and ≈ 17.5 µs.
 */
export class AesGcmEncrypter implements Encrypter {
  readonly #keys: readonly KeyObject[];

  constructor(key: Uint8Array<ArrayBuffer>, previousKeys: readonly Uint8Array<ArrayBuffer>[] = []) {
    for (const candidate of [key, ...previousKeys]) {
      if (candidate.byteLength !== 32) throw new TypeError('AES-256-GCM needs a key of exactly 32 bytes.');
    }
    this.#keys = [key, ...previousKeys].map((raw) => createSecretKey(raw));
  }

  static fromConfig(config: EncryptionConfig): AesGcmEncrypter {
    return new AesGcmEncrypter(config.key, config.previousKeys);
  }

  async encrypt(plaintext: string, context = ''): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#keys[0]!, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    // As WebCrypto's TextEncoder took it: a missing value is the empty text, anything else its string.
    const ciphertext = cipher.update(plaintext === undefined ? '' : String(plaintext), 'utf8');
    const rest = cipher.final(); // empty for GCM, a stream cipher — kept for correctness
    const payload = Buffer.allocUnsafe(1 + IV_BYTES + ciphertext.length + rest.length + TAG_BYTES);
    payload[0] = VERSION;
    iv.copy(payload, 1);
    ciphertext.copy(payload, 1 + IV_BYTES);
    rest.copy(payload, 1 + IV_BYTES + ciphertext.length);
    cipher.getAuthTag().copy(payload, payload.length - TAG_BYTES);
    return payload.toString('base64url');
  }

  async decrypt(payload: string, context = ''): Promise<string> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.fromBase64(payload, { alphabet: 'base64url' });
    } catch {
      throw new DecryptError();
    }
    if (bytes[0] !== VERSION || bytes.byteLength < 1 + IV_BYTES + TAG_BYTES) throw new DecryptError();

    const iv = bytes.subarray(1, 1 + IV_BYTES);
    const ciphertext = bytes.subarray(1 + IV_BYTES, bytes.byteLength - TAG_BYTES);
    const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
    const aad = Buffer.from(context, 'utf8');
    for (const key of this.#keys) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const head = decipher.update(ciphertext);
        const tail = decipher.final(); // throws when the tag does not match: tampered, another key or another context
        return (tail.length === 0 ? head : Buffer.concat([head, tail])).toString('utf8');
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

/**
 * A missing or broken `APP_KEY` — at the start (the configuration) or in a package that needs it (E130): the command that
 * writes one. Text only.
 */
export const encryptionSolutions = defineSolutions([
  {
    for: Error,
    when: (e) => /\bAPP_KEY\b/.test(e.message),
    solve: () => ({
      title: 'Generate an application key',
      text:
        'APP_KEY encrypts the cookies (the session cookie, which carries the session id, among them), the session data when ' +
        'SESSION_ENCRYPT=true, and signs URLs; without a valid one (base64: and 32 random bytes) the app cannot start. ' +
        '"bespoke key:generate" writes a new one into .env. To replace the key of a running app use "bespoke key:generate --force": ' +
        'it moves the old key to APP_PREVIOUS_KEYS, so sessions, encrypted cookies and signed links stay valid.',
      command: 'bespoke key:generate',
    }),
  },
]);

/** Registers the `Encrypter`, keyed by `APP_KEY`. Found by `bespoke discover`. */
export class EncryptionServiceProvider implements ServiceProvider {
  static config = [EncryptionConfig];
  static solutions = encryptionSolutions;

  register(container: Container): void {
    container.singleton(Encrypter, (c) => AesGcmEncrypter.fromConfig(c.make(EncryptionConfig)));
  }
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!value.startsWith('base64:')) return undefined;
  try {
    const bytes = Uint8Array.fromBase64(value.slice('base64:'.length));
    return bytes.byteLength === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
