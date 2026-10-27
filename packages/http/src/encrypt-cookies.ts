import { DecryptError, Encrypter } from '@marmeon/encryption';
import type { HttpContext, Next } from '@marmeon/router';

/**
 * Which cookies stay unencrypted — e.g. `XSRF-TOKEN`, which the browser's
 * JavaScript must read. A singleton: packages and apps add names while registering.
 */
export class CookieEncryption {
  readonly #except = new Set<string>();

  except(...names: string[]): this {
    for (const name of names) this.#except.add(name);
    return this;
  }

  /** @internal Asked by the cookie middleware and the test app. */
  isEncrypted(name: string): boolean {
    return !this.#except.has(name);
  }
}

/**
 * Encrypts every cookie the app sets and decrypts the ones it receives. Each value is bound to its cookie name, so an
 * encrypted value cannot be moved to another cookie. Tampered, foreign or unencrypted values are treated as absent.
 */
export class EncryptCookies {
  readonly #encrypter: Encrypter;
  readonly #settings: CookieEncryption;

  /** @internal Built by the container. */
  constructor(encrypter: Encrypter, settings: CookieEncryption) {
    this.#encrypter = encrypter;
    this.#settings = settings;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    await ctx.cookies.useCodec({
      decode: async (name, value) => {
        if (!this.#settings.isEncrypted(name)) return value;
        try {
          if (!this.#encrypter.decryptWithAge) return await this.#encrypter.decrypt(value, `cookie:${name}`);
          const opened = await this.#encrypter.decryptWithAge(value, `cookie:${name}`);
          if (opened.stale) ctx.cookies.markStale(name);
          return opened.value;
        } catch (error) {
          if (error instanceof DecryptError) return undefined;
          throw error;
        }
      },
      encode: (name, value) =>
        this.#settings.isEncrypted(name) ? this.#encrypter.encrypt(value, `cookie:${name}`) : Promise.resolve(value),
    });
    return next();
  }
}
