import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CursorEncrypter } from '../pagination.ts';

/** AES-256-GCM with a key of its own and the context as additional data — the shape of `@marmeon/encryption`'s `Encrypter`, for tests. */
export function testEncrypter(key: Uint8Array = randomBytes(32)): CursorEncrypter {
  return {
    async encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const sealed = Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return sealed.toString('base64url');
    },
    async decrypt(payload, context) {
      const sealed = Buffer.from(payload, 'base64url');
      if (sealed.length < 28) throw new Error('The payload is invalid.');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(sealed.subarray(-16));
      return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}
