import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
import { token } from '@bespokecore/core';

declare const passwordHash: unique symbol;

/**
 * A password hash in PHC string format (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`). Branded,
 * so `verify(hash, password)` — arguments swapped — is a compile error. `Hasher.make` creates one;
 * a hash read from the database is declared one where it is read (the `UserProvider`).
 */
export type PasswordHash = string & { readonly [passwordHash]: true };

/**
 * Hashes and checks passwords (Laravel's `Hash`). Passwords are hashed exactly as given — never
 * trimmed — and at most {@link MAX_PASSWORD_BYTES} long.
 */
export interface Hasher {
  /** A new hash with a fresh salt, by the configured driver and costs. */
  make(password: string): Promise<PasswordHash>;
  /**
   * Whether `password` matches — compared in constant time. Also checks hashes of the other
   * built-in driver (switching drivers needs no mass reset). A broken or tampered hash is `false`,
   * never an exception.
   */
  verify(password: string, hash: PasswordHash): Promise<boolean>;
  /** Whether `hash` was made by another driver or with other costs than configured — rehash after a successful login. */
  needsRehash(hash: PasswordHash): boolean;
  /**
   * Takes as long as a real `verify` and is always `false`: for logins with an unknown e-mail, so
   * the response time does not tell which addresses have an account.
   */
  dummyVerify(password: string): Promise<false>;
}
export const Hasher = token<Hasher>('Hasher');

export type HashDriver = 'argon2id' | 'scrypt';

export interface Argon2Options {
  /** KiB of memory per hash (OWASP: 19456 = 19 MiB). */
  readonly memory: number;
  /** Iterations (OWASP: 2). */
  readonly time: number;
  /** Lanes (OWASP: 1). */
  readonly parallelism: number;
}

export interface ScryptOptions {
  /** log2 of N, the CPU/memory cost (OWASP: 17 = 2^17). */
  readonly cost: number;
  /** r (OWASP: 8). */
  readonly blockSize: number;
  /** p (OWASP: 1). */
  readonly parallelism: number;
}

export interface HasherOptions {
  readonly driver: HashDriver;
  readonly argon2: Argon2Options;
  readonly scrypt: ScryptOptions;
}

/** OWASP's recommendations (Password Storage Cheat Sheet). */
export const DEFAULT_HASHER_OPTIONS: HasherOptions = {
  driver: 'argon2id',
  argon2: { memory: 19_456, time: 2, parallelism: 1 },
  scrypt: { cost: 17, blockSize: 8, parallelism: 1 },
};

/** Longer passwords are refused: hashing megabytes per attempt would be a cheap way to burn CPU. */
export const MAX_PASSWORD_BYTES = 4096;

/**
 * What a hash may ask for. Configuration is checked against the same bounds, and so is every
 * stored hash before it is used: a planted hash with `m=4194304` must not cost 4 GiB per login.
 */
export const HASH_LIMITS = {
  argon2: { memory: [1024, 262_144], time: [1, 16], parallelism: [1, 16] },
  scrypt: { cost: [10, 20], blockSize: [1, 32], parallelism: [1, 16] },
  /** 128 · N · r bytes */
  scryptMemory: 256 * 1024 * 1024,
  salt: [8, 64],
  hash: [16, 64],
} as const;

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const ARGON2_VERSION = 19;

export class HashError extends Error {
  override name = 'HashError';
}

type Parsed =
  | { readonly id: 'argon2id'; readonly options: Argon2Options; readonly salt: Buffer; readonly hash: Buffer }
  | { readonly id: 'scrypt'; readonly options: ScryptOptions; readonly salt: Buffer; readonly hash: Buffer };

const scryptAsync = promisify(crypto.scrypt) as (password: Buffer, salt: Buffer, length: number, options: crypto.ScryptOptions) => Promise<Buffer>;

/** argon2 needs Node ≥ 24.7 built with OpenSSL ≥ 3.2 (the official builds are). */
export function argon2Available(): boolean {
  return typeof (crypto as { argon2?: unknown }).argon2 === 'function';
}

/**
 * The built-in {@link Hasher}: argon2id (default) and scrypt from `node:crypto`, both computed
 * in libuv's thread pool — a login never blocks the event loop.
 */
export class PasswordHasher implements Hasher {
  readonly #options: HasherOptions;
  #dummy: Promise<PasswordHash> | undefined;

  constructor(options: HasherOptions = DEFAULT_HASHER_OPTIONS, isArgon2Available = argon2Available()) {
    if (options.driver === 'argon2id' && !isArgon2Available) {
      throw new HashError(
        `Password hashing with argon2id needs crypto.argon2 (Node ≥ 24.7 built with OpenSSL ≥ 3.2); this Node ${process.version} with OpenSSL ${process.versions.openssl} does not have it. ` +
          'Use an official Node build, or set HASH_DRIVER=scrypt.',
      );
    }
    for (const problem of problems(options)) throw new HashError(`Invalid hashing configuration: ${problem}.`);
    this.#options = options;
  }

  async make(password: string): Promise<PasswordHash> {
    const bytes = Buffer.from(password, 'utf8');
    if (bytes.byteLength > MAX_PASSWORD_BYTES) throw new HashError(`Passwords are limited to ${MAX_PASSWORD_BYTES} bytes.`);
    const salt = crypto.randomBytes(SALT_BYTES);
    const parsed: Parsed =
      this.#options.driver === 'argon2id'
        ? { id: 'argon2id', options: this.#options.argon2, salt, hash: Buffer.alloc(0) }
        : { id: 'scrypt', options: this.#options.scrypt, salt, hash: Buffer.alloc(0) };
    return format({ ...parsed, hash: await derive(parsed, bytes, HASH_BYTES) }) as PasswordHash;
  }

  async verify(password: string, hash: PasswordHash): Promise<boolean> {
    if (typeof password !== 'string' || typeof hash !== 'string') return false;
    const bytes = Buffer.from(password, 'utf8');
    if (bytes.byteLength > MAX_PASSWORD_BYTES) return false;
    const parsed = parse(hash);
    if (!parsed || (parsed.id === 'argon2id' && !argon2Available())) return false;
    try {
      return crypto.timingSafeEqual(await derive(parsed, bytes, parsed.hash.byteLength), parsed.hash);
    } catch {
      return false;
    }
  }

  needsRehash(hash: PasswordHash): boolean {
    const parsed = parse(hash);
    if (!parsed || parsed.id !== this.#options.driver || parsed.hash.byteLength !== HASH_BYTES) return true;
    const wanted: object = parsed.id === 'argon2id' ? this.#options.argon2 : this.#options.scrypt;
    return Object.entries(wanted).some(([key, value]) => (parsed.options as unknown as Record<string, number>)[key] !== value);
  }

  async dummyVerify(password: string): Promise<false> {
    // A reference hash with the configured costs, made on first use (a random password nobody knows).
    this.#dummy ??= this.make(crypto.randomBytes(18).toString('base64'));
    await this.verify(password, await this.#dummy);
    return false;
  }
}

// --- PHC strings ---------------------------------------------------------------------------

const B64 = '[A-Za-z0-9+/]+';
const ARGON2 = new RegExp(`^\\$argon2id\\$v=(\\d+)\\$m=(\\d{1,7}),t=(\\d{1,3}),p=(\\d{1,3})\\$(${B64})\\$(${B64})$`);
const SCRYPT = new RegExp(`^\\$scrypt\\$ln=(\\d{1,2}),r=(\\d{1,3}),p=(\\d{1,3})\\$(${B64})\\$(${B64})$`);

function format(parsed: Parsed): string {
  const salt = b64(parsed.salt);
  const hash = b64(parsed.hash);
  if (parsed.id === 'argon2id') {
    const { memory, time, parallelism } = parsed.options;
    return `$argon2id$v=${ARGON2_VERSION}$m=${memory},t=${time},p=${parallelism}$${salt}$${hash}`;
  }
  const { cost, blockSize, parallelism } = parsed.options;
  return `$scrypt$ln=${cost},r=${blockSize},p=${parallelism}$${salt}$${hash}`;
}

/** A well-formed hash within {@link HASH_LIMITS} — or undefined. */
function parse(hash: string): Parsed | undefined {
  if (hash.length > 512) return undefined;
  let parsed: Parsed | undefined;
  const argon2 = ARGON2.exec(hash);
  if (argon2) {
    if (Number(argon2[1]) !== ARGON2_VERSION) return undefined;
    const options = { memory: Number(argon2[2]), time: Number(argon2[3]), parallelism: Number(argon2[4]) };
    parsed = { id: 'argon2id', options, salt: unb64(argon2[5]!), hash: unb64(argon2[6]!) };
  }
  const scrypt = SCRYPT.exec(hash);
  if (scrypt) {
    const options = { cost: Number(scrypt[1]), blockSize: Number(scrypt[2]), parallelism: Number(scrypt[3]) };
    parsed = { id: 'scrypt', options, salt: unb64(scrypt[4]!), hash: unb64(scrypt[5]!) };
  }
  if (!parsed) return undefined;
  const options: HasherOptions =
    parsed.id === 'argon2id' ? { ...DEFAULT_HASHER_OPTIONS, driver: 'argon2id', argon2: parsed.options } : { ...DEFAULT_HASHER_OPTIONS, driver: 'scrypt', scrypt: parsed.options };
  if (problems(options).length) return undefined;
  const within = (bytes: Buffer, [min, max]: readonly [number, number]) => bytes.byteLength >= min && bytes.byteLength <= max;
  return within(parsed.salt, HASH_LIMITS.salt) && within(parsed.hash, HASH_LIMITS.hash) ? parsed : undefined;
}

/** What is wrong with options for their driver, against {@link HASH_LIMITS}. */
export function problems(options: HasherOptions): string[] {
  const found: string[] = [];
  const check = (name: string, value: number, [min, max]: readonly [number, number]) => {
    if (!Number.isInteger(value) || value < min || value > max) found.push(`${name} must be a whole number from ${min} to ${max}, got ${value}`);
  };
  if (options.driver === 'argon2id') {
    const { memory, time, parallelism } = options.argon2;
    check('argon2 memory (KiB)', memory, HASH_LIMITS.argon2.memory);
    check('argon2 time', time, HASH_LIMITS.argon2.time);
    check('argon2 parallelism', parallelism, HASH_LIMITS.argon2.parallelism);
    if (memory < 8 * parallelism) found.push('argon2 memory must be at least 8 KiB per lane');
  } else {
    const { cost, blockSize, parallelism } = options.scrypt;
    check('scrypt cost (log2 N)', cost, HASH_LIMITS.scrypt.cost);
    check('scrypt block size', blockSize, HASH_LIMITS.scrypt.blockSize);
    check('scrypt parallelism', parallelism, HASH_LIMITS.scrypt.parallelism);
    if (128 * 2 ** cost * blockSize > HASH_LIMITS.scryptMemory) found.push(`scrypt needs more than ${HASH_LIMITS.scryptMemory / 1024 / 1024} MiB (128 · N · r)`);
  }
  return found;
}

function derive(parsed: Parsed, password: Buffer, length: number): Promise<Buffer> {
  if (parsed.id === 'scrypt') {
    const { cost, blockSize, parallelism } = parsed.options;
    return scryptAsync(password, parsed.salt, length, { N: 2 ** cost, r: blockSize, p: parallelism, maxmem: HASH_LIMITS.scryptMemory + 1024 * 1024 });
  }
  const { memory, time, parallelism } = parsed.options;
  return new Promise((resolve, reject) =>
    crypto.argon2('argon2id', { message: password, nonce: parsed.salt, memory, passes: time, parallelism, tagLength: length }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** PHC uses standard base64 without padding. */
function b64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** Strict: Node's decoder skips what it cannot read, so only canonical encodings are accepted. */
function unb64(text: string): Buffer {
  const bytes = Buffer.from(text, 'base64');
  return b64(bytes) === text ? bytes : Buffer.alloc(0);
}
