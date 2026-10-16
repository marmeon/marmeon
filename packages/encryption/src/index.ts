import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from 'node:crypto';
import { defineConfig, defineSolutions, env, environment, token, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';

/**
 * Symmetric, authenticated encryption with the application key. Payloads cannot be read or changed without the key.
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

/** `base64:` + 32 random bytes, as written by `marmeon key:generate`. */
const KEY = env.string().check((value) => decodeKey(value) !== undefined, 'Expected "base64:" followed by 32 base64-encoded bytes — run "marmeon key:generate"');

/** Listed because it is public: the key of `.env.test` and the tests of this repository. Outside development and tests it is refused. */
const PUBLIC_TEST_KEY = decodeKey('base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=')!;

/** Compares the decoded bytes: padding, trailing bits and whitespace make other spellings of the same key. */
const isPublicTestKey = (value: string): boolean => Buffer.from(decodeKey(value) ?? []).equals(PUBLIC_TEST_KEY);

export const EncryptionConfig = defineConfig('encryption', {
  env: env({
    APP_KEY: KEY.required('Missing — run "marmeon key:generate"'),
    /** Former keys, comma-separated: payloads encrypted with them still decrypt (key rotation). */
    APP_PREVIOUS_KEYS: env.list(KEY).default([]),
    NODE_ENV: env.string().optional(),
  }).check(
    // Fail closed: a missing or unknown NODE_ENV is protected, like production.
    (e) => !isPublicTestKey(e.APP_KEY) || !environment.isProtected(e),
    'APP_KEY is the public test key of the Marmeon repository — generate one with "marmeon key:generate"',
    'APP_KEY',
  ).check(
    (e) => !e.APP_PREVIOUS_KEYS.some(isPublicTestKey) || !environment.isProtected(e),
    'APP_PREVIOUS_KEYS lists the public test key of the Marmeon repository — remove it',
    'APP_PREVIOUS_KEYS',
  ),
  resolve: (e) => ({ key: decodeKey(e.APP_KEY)!, previousKeys: e.APP_PREVIOUS_KEYS.map((key) => decodeKey(key)!) }),
});
export type EncryptionConfig = ConfigOf<typeof EncryptionConfig>;

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * AES-256-GCM through `node:crypto`. Payload: base64url(version · iv · ciphertext · tag), the 16-byte tag last: the layout
 * of WebCrypto's AES-GCM. Encrypts with the current key, decrypts with it or any previous key.
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
    // Like TextEncoder: a missing value is the empty text, anything else its string.
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
 * A missing or broken `APP_KEY` — at the start (the configuration) or in a package that needs it: the command that
 * writes one. Text only.
 */
const encryptionSolutions = defineSolutions([
  {
    for: Error,
    when: (e) => /\bAPP_KEY\b/.test(e.message),
    solve: () => ({
      title: 'Generate an application key',
      text:
        'APP_KEY encrypts the cookies (the session cookie, which carries the session id, among them), the session data when ' +
        'SESSION_ENCRYPT=true, and signs URLs; without a valid one (base64: and 32 random bytes) the app cannot start. ' +
        '"marmeon key:generate" writes a new one into .env. To replace the key of a running app use "marmeon key:generate --force": ' +
        'it moves the old key to APP_PREVIOUS_KEYS, so sessions, encrypted cookies and signed links stay valid.',
      command: 'marmeon key:generate',
    }),
  },
]);

/** Registers the `Encrypter`, keyed by `APP_KEY`. Found by `marmeon discover`. */
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
