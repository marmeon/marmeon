import * as crypto from 'node:crypto';
import { createApplication } from '@marmeon/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AuthServiceProvider, HashError, Hasher, MAX_PASSWORD_BYTES, PasswordHasher, type HasherOptions, type PasswordHash } from './index.ts';
import { DEFAULT_HASHER_OPTIONS } from './hashing.ts';

// Passes through; lets a test count the key derivations that were started.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, argon2: vi.fn(actual.argon2), scrypt: vi.fn(actual.scrypt) };
});

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
    const bigScrypt = (await scrypt.make('secret')).replace('ln=10', 'ln=24') as PasswordHash;
    vi.mocked(crypto.argon2).mockClear();
    vi.mocked(crypto.scrypt).mockClear();
    expect(await argon2.verify('secret', hash.replace('m=1024', 'm=4194304') as PasswordHash)).toBe(false);
    expect(await argon2.verify('secret', hash.replace('t=1', 't=999') as PasswordHash)).toBe(false);
    expect(await argon2.verify('secret', bigScrypt)).toBe(false);
    // What ran was the check of the configured costs (a refused hash answers like a wrong one), never the planted ones.
    for (const [, options] of vi.mocked(crypto.argon2).mock.calls as unknown as [string, { memory: number; passes: number }][]) expect(options).toMatchObject({ memory: 1024, passes: 1 });
    for (const [, , , options] of vi.mocked(crypto.scrypt).mock.calls as unknown as [unknown, unknown, unknown, { N: number }][]) expect(options.N).toBe(2 ** 10);
    expect(vi.mocked(crypto.argon2).mock.calls.length + vi.mocked(crypto.scrypt).mock.calls.length).toBeGreaterThan(0); // the loops above saw something
  });

  it(`limits passwords to ${MAX_PASSWORD_BYTES} bytes (UTF-8), so huge inputs cost nothing`, async () => {
    const longest = 'x'.repeat(MAX_PASSWORD_BYTES);
    const hash = await argon2.make(longest);
    expect(await argon2.verify(longest, hash)).toBe(true);
    await expect(argon2.make(`${longest}x`)).rejects.toThrow(HashError);
    await expect(argon2.make('ä'.repeat(MAX_PASSWORD_BYTES / 2 + 1))).rejects.toThrow(`limited to ${MAX_PASSWORD_BYTES} bytes`);
    await expect(argon2.make('ä'.repeat(MAX_PASSWORD_BYTES / 2 + 1))).rejects.toThrow(`[marmeon:A2] Passwords are limited to ${MAX_PASSWORD_BYTES} bytes.`);
    expect(await argon2.verify(`${longest}x`, hash)).toBe(false);
  });

  // The cost of a dummy check is proven here and measured in `hashing.timing.test.ts`.
  it('dummyVerify does the work of a real verify: one check against a hash made with the configured costs', async () => {
    const hasher = new PasswordHasher(cheap);
    const verify = vi.spyOn(hasher, 'verify');
    expect(await hasher.dummyVerify('wrong password')).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    const [password, hash] = verify.mock.calls[0]!;
    expect(password).toBe('wrong password');
    expect(hasher.needsRehash(hash)).toBe(false); // the configured driver and costs: no cheaper than a real check
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  describe('failureFloorMs', () => {
    const scrypt = (cost: number, blockSize = 8): HasherOptions => ({ ...cheap, driver: 'scrypt', scrypt: { cost, blockSize, parallelism: 1 } });
    /** A hasher whose clock reports the duration set in `took` for every check, so no test depends on real time. */
    // A huge spacing keeps the background re-measure out of the tests that do not look at it.
    const clocked = (options: HasherOptions = scrypt(10), isArgon2Available = true, gapsMs: readonly number[] = [1_000_000]) => {
      const state = { took: 1, flip: false, queue: [] as number[] };
      const now = () => {
        state.flip = !state.flip;
        return state.flip ? 0 : (state.queue.shift() ?? state.took);
      };
      const hasher = new PasswordHasher(options, { isArgon2Available, remeasureGapsMs: gapsMs, now });
      return { state, hasher };
    };

    it('is the slowest, over the parameter sets, of the fastest check of each', async () => {
      const { state, hasher } = clocked();
      const old = await new PasswordHasher(scrypt(11)).make('secret');
      const current = await hasher.make('secret');
      state.took = 80;
      await hasher.verify('wrong', old);
      state.took = 5;
      await hasher.verify('wrong', current);
      expect(await hasher.failureFloorMs()).toBe(80);
    });

    it('keeps the minimum of a set: a slower, queued sample does not raise it', async () => {
      const { state, hasher } = clocked();
      const current = await hasher.make('secret');
      for (const took of [30, 10, 500, 20]) {
        state.took = took;
        await hasher.verify('wrong', current);
      }
      expect(await hasher.failureFloorMs()).toBe(10);
    });

    it('keeps the slow set after many cheap checks (nothing ages out)', async () => {
      const { state, hasher } = clocked();
      const old = await new PasswordHasher(scrypt(11)).make('secret');
      state.took = 80;
      await hasher.verify('wrong', old);
      state.took = 1;
      for (let i = 0; i < 100; i++) await hasher.verify('wrong', 'not a hash' as PasswordHash);
      expect(await hasher.failureFloorMs()).toBe(80);
    });

    it('has a sample of the configured costs before anything was checked', async () => {
      const { state, hasher } = clocked();
      state.took = 7;
      expect(await hasher.failureFloorMs()).toBe(7);
    });

    it('sends a broken hash, and an argon2id hash without argon2, through the dummy check', async () => {
      const argon = await new PasswordHasher(cheap).make('secret');
      const { hasher } = clocked(scrypt(10), false);
      let dummies = 0;
      const real = hasher.dummyVerify.bind(hasher);
      hasher.dummyVerify = (password) => (dummies++, real(password));
      expect(await hasher.verify('x', 'garbage' as PasswordHash)).toBe(false);
      expect(await hasher.verify('secret', argon)).toBe(false);
      expect(dummies).toBe(2);
    });

    it('replaces an inflated first sample of another set by a background re-measure', async () => {
      const { state, hasher } = clocked(scrypt(10), true, [0, 0, 0, 0, 0]);
      state.took = 5;
      await hasher.verify('x', await hasher.make('secret')); // the configured set
      const foreign = await new PasswordHasher(scrypt(11)).make('secret');
      state.took = 900; // the thread pool was busy
      await hasher.verify('x', foreign);
      expect(await hasher.failureFloorMs()).toBe(900);
      state.took = 20;
      await vi.waitFor(async () => expect(await hasher.failureFloorMs()).toBe(20));
    });

    it('keeps re-measuring a set while the runs get lower, so a burst of a few seconds does not stick', async () => {
      const { state, hasher } = clocked(scrypt(10), true, [0, 0, 0, 0, 0]);
      state.took = 5;
      await hasher.verify('x', await hasher.make('secret'));
      const foreign = await new PasswordHasher(scrypt(11)).make('secret');
      state.took = 900;
      await hasher.verify('x', foreign);
      state.queue = [800, 700, 20]; // the first two runs still fall in the burst
      await vi.waitFor(async () => expect(await hasher.failureFloorMs()).toBe(20));
    });

    it('stops re-measuring at a run that is not lower (after two)', async () => {
      const { state, hasher } = clocked(scrypt(10), true, [0, 0, 0, 0, 0]);
      state.took = 5;
      await hasher.verify('x', await hasher.make('secret'));
      state.took = 50;
      await hasher.verify('x', await new PasswordHasher(scrypt(11)).make('secret'));
      state.queue = [60, 70, 10]; // not lower from the first run; the second ends it
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(state.queue).toEqual([10]);
      expect(await hasher.failureFloorMs()).toBe(50);
    });

    it('never evicts the configured set, even when 32 dearer sets are known', async () => {
      const { state, hasher } = clocked();
      state.took = 1;
      await hasher.verify('x', await hasher.make('secret'));
      for (let parallelism = 1; parallelism <= 16; parallelism++) {
        for (const blockSize of [1, 2]) {
          state.took = 50 + parallelism;
          const options: HasherOptions = { ...cheap, driver: 'scrypt', scrypt: { cost: 10, blockSize, parallelism } };
          await hasher.verify('x', await new PasswordHasher(options).make('secret'));
        }
      }
      let dummies = 0;
      const real = hasher.dummyVerify.bind(hasher);
      hasher.dummyVerify = (password) => (dummies++, real(password));
      await hasher.failureFloorMs();
      expect(dummies).toBe(0); // the configured sample is still there
    });

    it('holds at most 32 sets, and the most expensive ones stay', async () => {
      const { state, hasher } = clocked();
      for (let blockSize = 1; blockSize <= 32; blockSize++) {
        state.took = blockSize;
        await hasher.verify('x', await new PasswordHasher(scrypt(10, blockSize)).make('secret'));
      }
      state.took = 100; // a 33rd set, dearer than the cheapest
      await hasher.verify('x', await new PasswordHasher({ ...scrypt(10, 1), scrypt: { cost: 10, blockSize: 1, parallelism: 2 } }).make('secret'));
      expect(await hasher.failureFloorMs()).toBe(100);
      state.took = 0.5; // dearer than nothing: dropped
      await hasher.verify('x', await new PasswordHasher({ ...scrypt(10, 1), scrypt: { cost: 10, blockSize: 1, parallelism: 3 } }).make('secret'));
      expect(await hasher.failureFloorMs()).toBe(100);
    });
  });

  it('refuses to start with argon2id when Node lacks it — and says how to fix it', () => {
    expect(() => new PasswordHasher(DEFAULT_HASHER_OPTIONS, { isArgon2Available: false })).toThrow(/HASH_DRIVER=scrypt/);
    expect(() => new PasswordHasher({ ...cheap, driver: 'scrypt' }, { isArgon2Available: false })).not.toThrow();
    expect(() => new PasswordHasher({ ...cheap, argon2: { memory: 64, time: 1, parallelism: 1 } })).toThrow('argon2 memory (KiB) must be a whole number from 1024');
    expect(() => new PasswordHasher({ ...cheap, driver: 'scrypt', scrypt: { cost: 20, blockSize: 32, parallelism: 1 } })).toThrow('scrypt needs more than 256 MiB');
  });
});

describe('AuthServiceProvider', () => {
  const boot = (env: Record<string, string>) => createApplication({ root: import.meta.dirname, discover: false, providers: [AuthServiceProvider] }, { env });

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
