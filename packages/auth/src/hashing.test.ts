import { createApplication } from '@marmeon/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AuthServiceProvider, DEFAULT_HASHER_OPTIONS, HashError, Hasher, MAX_PASSWORD_BYTES, PasswordHasher, type HasherOptions, type PasswordHash } from './index.ts';

/** Cheap costs: these tests are about behaviour, not strength (the app does the same in `.env.test`). */
const cheap: HasherOptions = { driver: 'argon2id', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } };
const argon2 = new PasswordHasher(cheap);
const scrypt = new PasswordHasher({ ...cheap, driver: 'scrypt' });

describe('PasswordHasher', () => {
  it('makes argon2id hashes in PHC format, with OWASP costs by default', async () => {
    const hash = await new PasswordHasher().make('correct horse');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await new PasswordHasher().verify('correct horse', hash)).toBe(true);
    expect(await new PasswordHasher().verify('correct horse!', hash)).toBe(false);
  });

  it('salts every hash: the same password twice gives two different hashes', async () => {
    const [a, b] = [await argon2.make('secret'), await argon2.make('secret')];
    expect(a).not.toBe(b);
    expect(a.split('$')[4]).not.toBe(b.split('$')[4]); // the salts differ
    expect(await argon2.verify('secret', a)).toBe(true);
    expect(await argon2.verify('secret', b)).toBe(true);
  });

  it('hashes passwords exactly as given — never trimmed, any characters', async () => {
    const spaced = await argon2.make('  pass word  ');
    expect(await argon2.verify('pass word', spaced)).toBe(false);
    expect(await argon2.verify('  pass word  ', spaced)).toBe(true);
    const unicode = await argon2.make('Pässwört 🔑');
    expect(await argon2.verify('Pässwört 🔑', unicode)).toBe(true);
    expect(await argon2.verify('Passwort 🔑', unicode)).toBe(false);
  });

  it('normalizes Unicode (NFKC, NIST 800-63B): the same password typed on another system still matches', async () => {
    const composed = 'Caf\u00e9'; // é as one code point (Windows, most keyboards)
    const decomposed = 'Cafe\u0301'; // e + combining acute (macOS input, copied text)
    expect(composed).not.toBe(decomposed);
    expect(await argon2.verify(decomposed, await argon2.make(composed))).toBe(true);
    expect(await argon2.verify(composed, await argon2.make(decomposed))).toBe(true);
    // Compatibility forms too: full-width letters and ligatures are their plain letters.
    expect(await argon2.verify('pass', await argon2.make('\uff50\uff41\uff53\uff53'))).toBe(true);
    expect(await argon2.verify('fix', await argon2.make('\ufb01x'))).toBe(true);
    // Not case or spaces, though: those are different passwords.
    expect(await argon2.verify('cafe\u0301', await argon2.make(composed))).toBe(false);
  });

  it('refuses strings with lone surrogates — they would collide with U+FFFD', async () => {
    const hash = await argon2.make('\ufffd');
    expect(await argon2.verify('\ud800', hash)).toBe(false);
    await expect(argon2.make('pass\udc00word')).rejects.toThrow('well-formed');
  });

  it('makes scrypt hashes and verifies hashes of both drivers — a driver switch needs no reset', async () => {
    const fromScrypt = await scrypt.make('secret');
    expect(fromScrypt).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
    const fromArgon2 = await argon2.make('secret');
    expect(await argon2.verify('secret', fromScrypt)).toBe(true);
    expect(await scrypt.verify('secret', fromArgon2)).toBe(true);
    expect(await scrypt.verify('wrong', fromArgon2)).toBe(false);
  });

  it('asks for a rehash when the driver or the costs changed', async () => {
    const hash = await argon2.make('secret');
    expect(argon2.needsRehash(hash)).toBe(false);
    expect(scrypt.needsRehash(hash)).toBe(true);
    expect(new PasswordHasher({ ...cheap, argon2: { ...cheap.argon2, memory: 2048 } }).needsRehash(hash)).toBe(true);
    expect(new PasswordHasher({ ...cheap, argon2: { ...cheap.argon2, time: 2 } }).needsRehash(hash)).toBe(true);
    expect(scrypt.needsRehash(await scrypt.make('secret'))).toBe(false);
    expect(argon2.needsRehash('not a hash' as PasswordHash)).toBe(true);
  });

  it('a tampered hash is false, never an exception', async () => {
    const hash = await argon2.make('secret');
    const [, , version, params, salt, digest] = hash.split('$') as [string, string, string, string, string, string];
    const tampered = [
      hash.replace('t=1', 't=2'), // other costs → another result
      hash.replace('m=1024', 'm=2048'),
      `$argon2id$${version}$${params}$${flip(salt)}$${digest}`,
      `$argon2id$${version}$${params}$${salt}$${flip(digest)}`,
      hash.slice(0, -4),
      `$argon2id$v=16$${params}$${salt}$${digest}`, // another argon2 version
      `$argon2i$${version}$${params}$${salt}$${digest}`, // another variant
      `$argon2id$${version}$${params}$${salt}=$${digest}`, // padding is not PHC
      '',
      'secret',
      '$2y$12$abcdefghijklmnopqrstuuJpGHpDgBzVJ8ZFgEe9bA7SHMm.GxT2u', // bcrypt: not (yet) a driver
    ];
    for (const candidate of tampered) expect(await argon2.verify('secret', candidate as PasswordHash), candidate).toBe(false);
    expect(await argon2.verify(undefined as never, hash)).toBe(false);
    expect(await argon2.verify('secret', null as never)).toBe(false);
  });

  it('refuses costs beyond the limits before computing anything — a planted hash cannot burn 4 GiB per login', async () => {
    const hash = await argon2.make('secret');
    const started = performance.now();
    expect(await argon2.verify('secret', hash.replace('m=1024', 'm=4194304') as PasswordHash)).toBe(false);
    expect(await argon2.verify('secret', hash.replace('t=1', 't=999') as PasswordHash)).toBe(false);
    expect(await argon2.verify('secret', (await scrypt.make('secret')).replace('ln=10', 'ln=24') as PasswordHash)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it(`limits passwords to ${MAX_PASSWORD_BYTES} bytes (UTF-8), so huge inputs cost nothing`, async () => {
    const longest = 'x'.repeat(MAX_PASSWORD_BYTES);
    const hash = await argon2.make(longest);
    expect(await argon2.verify(longest, hash)).toBe(true);
    await expect(argon2.make(`${longest}x`)).rejects.toThrow(HashError);
    await expect(argon2.make('ä'.repeat(MAX_PASSWORD_BYTES / 2 + 1))).rejects.toThrow(`limited to ${MAX_PASSWORD_BYTES} bytes`);
    expect(await argon2.verify(`${longest}x`, hash)).toBe(false);
  });

  it('dummyVerify takes as long as a real verify (unknown e-mail ≈ wrong password)', async () => {
    const hasher = new PasswordHasher(); // real costs: differences must not hide in noise
    const hash = await hasher.make('secret');
    await hasher.dummyVerify('warm-up'); // the first call also makes its reference hash
    const real: number[] = [];
    const dummy: number[] = [];
    for (let i = 0; i < 7; i++) {
      let started = performance.now();
      await hasher.verify('wrong password', hash);
      real.push(performance.now() - started);
      started = performance.now();
      expect(await hasher.dummyVerify('wrong password')).toBe(false);
      dummy.push(performance.now() - started);
    }
    const ratio = median(dummy) / median(real);
    expect(ratio).toBeGreaterThan(0.5); // wide bounds: parallel test workers add noise; skipping the hash would be ~0.02
    expect(ratio).toBeLessThan(2);
    // Without it, an unknown e-mail would answer in no time:
    expect(median(real)).toBeGreaterThan(5);
  });

  it('refuses to start with argon2id when Node lacks it — and says how to fix it', () => {
    expect(() => new PasswordHasher(DEFAULT_HASHER_OPTIONS, false)).toThrow(/HASH_DRIVER=scrypt/);
    expect(() => new PasswordHasher({ ...cheap, driver: 'scrypt' }, false)).not.toThrow();
    expect(() => new PasswordHasher({ ...cheap, argon2: { memory: 64, time: 1, parallelism: 1 } })).toThrow('argon2 memory (KiB) must be a whole number from 1024');
    expect(() => new PasswordHasher({ ...cheap, driver: 'scrypt', scrypt: { cost: 20, blockSize: 32, parallelism: 1 } })).toThrow('scrypt needs more than 256 MiB');
  });
});

describe('AuthServiceProvider', () => {
  const boot = (env: Record<string, string>) => createApplication({ root: import.meta.dirname, discover: false, env, providers: [AuthServiceProvider] });

  it('binds the Hasher, configured from the environment', async () => {
    const app = await boot({ HASH_DRIVER: 'scrypt', HASH_SCRYPT_COST: '11' });
    const hasher = app.container.make(Hasher);
    expect(await hasher.make('secret')).toMatch(/^\$scrypt\$ln=11,r=8,p=1\$/);
    expect(await (await boot({})).container.make(Hasher).make('secret')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('refuses costs outside the limits at boot', async () => {
    await expect(boot({ HASH_ARGON_MEMORY: '64' })).rejects.toThrow(/hash: HASH_ARGON_MEMORY/);
    await expect(boot({ HASH_DRIVER: 'bcrypt' })).rejects.toThrow(/hash: HASH_DRIVER/);
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

declare const hasher: Hasher;
declare const stored: PasswordHash;

export async function hasherTypes() {
  const hash = await hasher.make('secret');
  expectTypeOf(hash).toEqualTypeOf<PasswordHash>();
  await hasher.verify('secret', hash);
  // @ts-expect-error — arguments swapped: the password is no PasswordHash
  await hasher.verify(stored, 'secret');
  // @ts-expect-error — a plain string from somewhere is not a hash (declare it one where it is read)
  await hasher.verify('secret', '$argon2id$…');
  // A hash is still a string wherever one is expected (storing it).
  const column: string = hash;
  void column;
}

function flip(base64: string): string {
  const i = Math.floor(base64.length / 2);
  return base64.slice(0, i) + (base64[i] === 'A' ? 'B' : 'A') + base64.slice(i + 1);
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
