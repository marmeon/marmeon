import { token } from '@marmeon/core';
import type { Encrypter } from '@marmeon/encryption';

/**
 * Turns a session's JSON into what its store keeps, and back: as it is (the default), or encrypted (`SESSION_ENCRYPT=true`,
 * E144). `key` is the session's store key — an encrypted payload is bound to it.
 */
export interface SessionCodec {
  /** Whether payloads are encrypted. */
  readonly encrypts: boolean;
  seal(json: string, key: string): string | Promise<string>;
  /** The JSON — or undefined when the payload cannot be read: tampered with, under another key, from another session. */
  open(data: string, key: string): string | undefined | Promise<string | undefined>;
}
export const SessionCodec = token<SessionCodec>('SessionCodec');

/** Payloads as they are (JSON). */
export const plainSessionCodec: SessionCodec = {
  encrypts: false,
  seal: (json) => json,
  open: (data) => data,
};

/**
 * Payloads encrypted with the app's `Encrypter` (AES-256-GCM; `APP_PREVIOUS_KEYS` still decrypt — key rotation), bound to the
 * session's key as authenticated data: a payload copied into another session's place does not decrypt there.
 */
export class EncryptedSessionCodec implements SessionCodec {
  readonly encrypts = true;
  readonly #encrypter: Encrypter;

  constructor(encrypter: Encrypter) {
    this.#encrypter = encrypter;
  }

  seal(json: string, key: string): Promise<string> {
    return this.#encrypter.encrypt(json, `session:${key}`);
  }

  async open(data: string, key: string): Promise<string | undefined> {
    try {
      return await this.#encrypter.decrypt(data, `session:${key}`);
    } catch {
      return undefined; // tampered, another key, another session — or written before SESSION_ENCRYPT was on: a new session starts
    }
  }
}
