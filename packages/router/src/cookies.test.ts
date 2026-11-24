import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CookieJar, parseCookies, serializeCookie, withQueuedCookies } from './cookies.ts';
import { Router } from './router.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

describe('cookies', () => {
  it('parses the Cookie header — decoded, quoted values unwrapped, first occurrence wins', () => {
    const cookies = parseCookies('a=1; b=hello%20world; c="quoted"; a=2; broken; =x; bad=%E0%A4%A');
    expect(Object.fromEntries(cookies)).toEqual({ a: '1', b: 'hello world', c: 'quoted', bad: '%E0%A4%A' });
  });

  it('serializes with safe defaults (HttpOnly, SameSite=Lax, Path=/)', () => {
    expect(serializeCookie('session', 'a b;c')).toBe('session=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax');
    expect(serializeCookie('x', '1', { maxAge: 60, secure: true, httpOnly: false, sameSite: 'strict', domain: 'app.test' })).toBe(
      'x=1; Path=/; Domain=app.test; Max-Age=60; Secure; SameSite=Strict',
    );
  });

  it('writes maxAge as whole seconds, rounded down, from seconds or parts', () => {
    expect(serializeCookie('x', '1', { maxAge: { days: 1 } })).toContain('Max-Age=86400;');
    expect(serializeCookie('x', '1', { maxAge: { seconds: 1, milliseconds: 900 } })).toContain('Max-Age=1;');
    expect(serializeCookie('x', '1', { maxAge: 90.7 })).toContain('Max-Age=90;');
    // @ts-expect-error a string is no span of time
    expect(() => serializeCookie('x', '1', { maxAge: '1d' })).toThrow(TypeError);
  });

  it('gives every cookie the jar\'s defaults (Secure from the session config) — unless set says otherwise', async () => {
    const jar = new CookieJar(null, { secure: true });
    jar.set('plain', '1');
    jar.set('opted_out', '1', { secure: false });
    jar.delete('gone');
    const [plain, optedOut, gone] = await jar.queued();
    expect(plain).toContain('; Secure');
    expect(optedOut).not.toContain('Secure');
    expect(gone).toContain('; Secure');
    const [without] = await (() => {
      const other = new CookieJar(null);
      other.set('plain', '1');
      return other.queued();
    })();
    expect(without).not.toContain('Secure');
  });

  it('refuses invalid names and SameSite=None without Secure', () => {
    expect(() => serializeCookie('bad name', '1')).toThrow('Invalid cookie name "bad name".');
    expect(() => serializeCookie('x', '1', { sameSite: 'none' })).toThrow('SameSite=None requires secure: true');
  });

  it('reads incoming cookies and queues outgoing ones', async () => {
    const jar = new CookieJar('theme=dark');
    jar.set('theme', 'light');
    jar.set('theme', 'blue'); // the last set wins
    jar.delete('old');

    expect(jar.get('theme')).toBe('dark'); // what the client sent
    expect(jar.has('missing')).toBe(false);
    expect(await jar.queued()).toEqual([
      'theme=blue; Path=/; HttpOnly; SameSite=Lax',
      'old=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('adds queued cookies even to responses with immutable headers', async () => {
    const jar = new CookieJar(null);
    jar.set('a', '1');
    const response = await withQueuedCookies(Response.redirect('http://app.test/next', 302), jar);
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('run through a codec both ways — undecodable cookies vanish, deletions stay plain', async () => {
    const jar = new CookieJar('a=enc(1); b=garbage');
    await jar.useCodec({
      decode: async (_name, value) => /^enc\((.*)\)$/.exec(value)?.[1],
      encode: async (name, value) => `enc(${name}:${value})`,
    });
    jar.set('c', '3');
    jar.delete('a');

    expect(jar.all()).toEqual({ a: '1' });
    expect(await jar.queued()).toEqual([
      'c=enc(c%3A3); Path=/; HttpOnly; SameSite=Lax',
      'a=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('validate names when set, not only when written', () => {
    expect(() => new CookieJar(null).set('bad name', '1')).toThrow('Invalid cookie name');
    expect(() => new CookieJar(null).set('x', '1', { sameSite: 'none' })).toThrow('SameSite=None requires secure: true');
    // The jar's `secure` default counts — as when the header is written.
    expect(() => new CookieJar(null, { secure: true }).set('x', '1', { sameSite: 'none' })).not.toThrow();
  });

  it('never set a __Host- name without Secure, Path=/ and no Domain — also a deletion, also by the jar\'s default', () => {
    expect(() => new CookieJar(null).set('__Host-x', '1')).toThrow('__Host- prefix requires');
    expect(() => new CookieJar(null).set('__Host-x', '1', { secure: false })).toThrow('__Host- prefix requires');
    expect(() => new CookieJar(null).delete('__Host-x')).toThrow('__Host- prefix requires');
    expect(() => new CookieJar(null, { secure: true }).set('__Host-x', '1', { domain: 'example.com' })).toThrow('__Host- prefix requires');
    expect(() => new CookieJar(null, { secure: true }).set('__Host-x', '1', { path: '/app' })).toThrow('__Host- prefix requires');
    expect(() => serializeCookie('__Host-x', '1')).toThrow('__Host- prefix requires');
    expect(serializeCookie('__Host-x', '1', { secure: true })).toBe('__Host-x=1; Path=/; HttpOnly; Secure; SameSite=Lax');
    const jar = new CookieJar(null, { secure: true });
    jar.delete('__Host-x'); // the jar's default makes the deletion Secure, as the browser demands
  });

  it('read a cookie name exactly: only SP and HTAB are trimmed, so a tossed \u00A0__Host- name stays what it is, and a non-token name is dropped', () => {
    const cookies = parseCookies('\u00A0__Host-marmeon_session=evil; \t__Host-ok=1 ; bad name=2; \u2003x=3; y\u00A0=4');
    expect([...cookies.keys()]).toEqual(['__Host-ok']);
    expect(cookies.get('__Host-marmeon_session')).toBeUndefined();
    expect(new CookieJar('\u00A0__Host-marmeon_session=evil').get('__Host-marmeon_session')).toBeUndefined();
  });

  it('treat the __Host- and __Secure- prefixes without regard to case', () => {
    for (const name of ['__host-x', '__HOST-x', '__Host-x']) {
      expect(() => new CookieJar(null).set(name, '1')).toThrow('__Host- prefix requires');
      expect(() => new CookieJar(null, { secure: true }).set(name, '1', { domain: 'example.com' })).toThrow('__Host- prefix requires');
    }
    for (const name of ['__secure-x', '__SECURE-x', '__Secure-x']) {
      expect(() => new CookieJar(null).set(name, '1')).toThrow('__Secure- prefix requires secure: true');
      expect(() => new CookieJar(null, { secure: true }).set(name, '1')).not.toThrow();
    }
  });

  it('are part of every context the router dispatches', async () => {
    const router = new Router().load(
      openRoutes((Route) => {
        Route.post('/prefs', async (ctx) => {
          const { theme } = await ctx.input();
          ctx.cookies.set('theme', String(theme));
          return { previous: ctx.cookies.get('theme') ?? null, page: ctx.query.get('page') };
        });
      }),
    );
    const request = new Request('http://app.test/prefs?page=3', {
      method: 'POST',
      body: new URLSearchParams({ theme: 'light' }),
      headers: { cookie: 'theme=dark' },
    });
    const response = await router.dispatch(router.routes[0]!, { request, params: {} });
    expect(await response.json()).toEqual({ previous: 'dark', page: '3' });
  });
});

describe('cookie names — which characters are trimmed', () => {
  // Reference: SP and HTAB only, at either end; any character the parser treats differently shows up here.
  const reference = (name: string): string => name.replace(/^[ \t]+|[ \t]+$/g, '');
  const characters = [' ', '\t', '\n', '\r', '\v', '\f', '\u00A0', '\u1680', '\u2003', '\u2028', '\u3000', '\uFEFF', 'a', '-'];

  it('trims exactly what /^[ \\t]+|[ \\t]+$/g trims, for every blank-like character at either end and inside', () => {
    for (const lead of characters) {
      for (const middle of ['', ' ', '\t ', lead]) {
        for (const trail of characters) {
          const name = `${lead}${lead}a${middle}b${trail}${trail}`;
          const trimmed = reference(name);
          const expected = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed) ? { [trimmed]: '1' } : {};
          expect(Object.fromEntries(parseCookies(`${name}=1`)), JSON.stringify(name)).toEqual(expected);
        }
      }
    }
    expect(parseCookies('   \t ').size).toBe(0);
    expect(parseCookies(' \t =1').size).toBe(0);
  });
});

describe('CookieJar — locked (a read-only request)', () => {
  it('queues nothing a lock refuses, and asks for deletions too', async () => {
    const jar = new CookieJar('a=1');
    const asked: string[] = [];
    jar.lock((what) => (asked.push(what), false));
    jar.set('b', '2');
    jar.delete('a');
    expect(await jar.queued()).toEqual([]);
    expect(asked).toEqual(["cookies.set('b')", "cookies.set('a')"]);
    expect(jar.get('a')).toBe('1');
  });
});

describe('cookie values and attributes that cannot be written', () => {
  const half = String.fromCharCode(0xd83d);

  it('refuses a value with half of a surrogate pair at set(), naming the cookie', () => {
    expect(() => new CookieJar(null).set('a', half)).toThrow(TypeError);
    expect(() => new CookieJar(null).set('a', half)).toThrow(/Cookie "a": the value has half of a surrogate pair/);
  });

  it('refuses it with a codec installed too', async () => {
    const jar = new CookieJar(null);
    await jar.useCodec({ decode: async (_n, v) => v, encode: async (_n, v) => `enc:${v}` });
    expect(() => jar.set('a', half)).toThrow(/Cookie "a": the value has half of a surrogate pair/);
  });

  it('refuses it in serializeCookie', () => {
    expect(() => serializeCookie('a', half)).toThrow(/Cookie "a": the value has half of a surrogate pair/);
  });

  it('refuses a path or domain with ";", a control character or a character above U+00FF', () => {
    const jar = new CookieJar(null);
    expect(() => jar.set('a', 'x', { path: '/; Domain=evil' })).toThrow(/Cookie "a": the path must not contain/);
    expect(() => jar.set('a', 'x', { domain: 'a.test\r\nX: y' })).toThrow(/Cookie "a": the domain must not contain/);
    for (const bad of ['/\u0000', '/\t', '/\u007f', '/\u0085', '/€', '/\u{1F600}']) {
      expect(() => jar.set('a', 'x', { path: bad })).toThrow(/the path must not/);
      expect(() => serializeCookie('a', 'x', { path: bad })).toThrow(TypeError);
    }
    expect(() => jar.set('a', 'x', { domain: '\ud83d.test' })).toThrow(/the domain must not/);
  });

  it('still allows Latin-1 characters in a path', () => {
    expect(serializeCookie('a', 'x', { path: '/caf\u00e9\u00a0' })).toContain('Path=/caf\u00e9\u00a0');
  });

  it('refuses a value that is not a string', () => {
    expect(() => new CookieJar(null).set('a', 5 as unknown as string)).toThrow(/Cookie "a": the value must be a string/);
    expect(() => serializeCookie('a', 5 as unknown as string)).toThrow(/the value must be a string/);
  });

  it('refuses an unknown sameSite, also in another case, and accepts none given', () => {
    const jar = new CookieJar(null);
    const sameSite = (value: string) => ({ secure: true, sameSite: value as 'lax' });
    expect(() => jar.set('a', 'x', sameSite('lax; Domain=evil.test'))).toThrow(/Cookie "a": sameSite must be/);
    expect(() => jar.set('a', 'x', sameSite('None'))).toThrow(/sameSite must be/);
    expect(() => jar.set('a', 'x', { sameSite: undefined })).not.toThrow();
  });

  it('queues nothing for a refused set() and keeps the earlier value', async () => {
    const jar = new CookieJar(null);
    jar.set('a', '1');
    expect(() => jar.set('a', half)).toThrow(TypeError);
    expect(await jar.queued()).toEqual([expect.stringContaining('a=1;')]);
  });

  it('does not ask a lock about a refused value', () => {
    const jar = new CookieJar(null);
    const asked: string[] = [];
    jar.lock((what) => (asked.push(what), false));
    expect(() => jar.set('a', half)).toThrow(TypeError);
    expect(asked).toEqual([]);
  });

  it('judges the name before the value', () => {
    expect(() => new CookieJar(null).set('a b', half)).toThrow(/Invalid cookie name/);
    expect(() => serializeCookie('a b', half)).toThrow(/Invalid cookie name/);
  });

  it('writes the options as they were when set() was called', async () => {
    const jar = new CookieJar(null);
    const given = { path: '/a' };
    jar.set('x', 'v', given);
    given.path = '/; Domain=evil';
    expect(await jar.queued()).toEqual([expect.stringContaining('Path=/a;')]);
  });

  it('refuses a maxAge that is not a span of time and an invalid expires, and accepts valid ones', () => {
    const jar = new CookieJar(null);
    expect(() => jar.set('a', 'x', { maxAge: Number.NaN })).toThrow(/Cookie "a": maxAge is not a span of time/);
    expect(() => serializeCookie('a', 'x', { maxAge: Number.POSITIVE_INFINITY })).toThrow(/Cookie "a": maxAge is not a span of time — /);
    expect(() => jar.set('a', 'x', { maxAge: null as unknown as number })).toThrow(/maxAge is not a span of time/);
    expect(() => jar.set('a', 'x', { maxAge: { days: Number.NaN } })).toThrow(/maxAge is not a span of time/);
    expect(() => jar.set('a', 'x', { expires: '2030-01-01' as unknown as Date })).toThrow(/Cookie "a": expires is not a valid date/);
    expect(serializeCookie('a', 'x', { expires: runInNewContext('new Date(0)') as Date })).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(() => jar.set('a', 'x', { expires: new Date(Number.NaN) })).toThrow(/Cookie "a": expires is not a valid date/);
    expect(() => jar.set('a', 'x', { maxAge: { days: 1 }, expires: new Date(0) })).not.toThrow();
    expect(() => jar.set('b', 'x', { maxAge: 0 })).not.toThrow();
    expect(() => jar.delete('b')).not.toThrow();
  });

  it('writes the expires and maxAge as they were when set() was called', async () => {
    const jar = new CookieJar(null);
    const given = { expires: new Date(0), maxAge: { days: 1 } };
    jar.set('a', 'x', given);
    given.expires.setTime(Number.NaN);
    given.maxAge.days = Number.NaN;
    expect(await jar.queued()).toEqual([expect.stringMatching(/Max-Age=86400; Expires=Thu, 01 Jan 1970/)]);
  });

  it('writes the getters of a class that implements the options', async () => {
    class Options {
      get path() {
        return '/app';
      }
      get domain() {
        return 'example.test';
      }
      get maxAge() {
        return { days: 30 };
      }
    }
    const jar = new CookieJar(null);
    jar.set('a', 'x', new Options());
    expect(await jar.queued()).toEqual([expect.stringContaining('Path=/app; Domain=example.test; Max-Age=2592000')]);
    const other = new CookieJar(null);
    other.delete('a', new Options());
    expect(await other.queued()).toEqual([expect.stringContaining('a=; Path=/app; Domain=example.test; Max-Age=0')]);
  });

  it('reads each option once, so a getter that changes cannot slip a value past the check', async () => {
    let reads = 0;
    const options = {
      get path() {
        return reads++ === 0 ? '/ok' : '/; Domain=evil.test';
      },
    };
    const jar = new CookieJar(null);
    jar.set('a', 'x', options);
    expect(await jar.queued()).toEqual([expect.stringContaining('Path=/ok;')]);
  });

  it('refuses delete() with a path that cannot be written', () => {
    expect(() => new CookieJar(null).delete('a', { path: '/;x' })).toThrow(/the path must not/);
    expect(() => new CookieJar(null).delete('a', { domain: 'a;b' })).toThrow(/the domain must not/);
  });

  it('still writes emoji values and ordinary attributes', async () => {
    const jar = new CookieJar(null);
    jar.set('a', '\u{1F600}', { path: '/app', domain: 'example.test' });
    expect(await jar.queued()).toEqual([expect.stringContaining('a=%F0%9F%98%80; Path=/app; Domain=example.test')]);
  });
});
