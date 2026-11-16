import { Container } from '@marmeon/core';
import { RedirectResult } from '@marmeon/http';
import { Flasher, INTENDED_KEY, IntendedKey } from '@marmeon/http/internal';
import { describe, expect, it } from 'vitest';
import { createResponseFactory } from './render.ts';

/** A session that holds the given values and records which key was pulled. */
function sessionWith(stored: Record<string, unknown>) {
  const pulled: string[] = [];
  const flasher: Flasher = {
    flashData: () => {},
    pull: (key) => {
      pulled.push(key);
      const value = stored[key];
      delete stored[key];
      return value;
    },
    queueFlash: () => {},
    takeFlash: () => [],
    hasFlash: () => false,
  };
  return { flasher, pulled };
}

function scopeOf(flasher: Flasher, key?: () => string | null): Container {
  const scope = new Container();
  scope.instance(Flasher, flasher);
  if (key) scope.instance(IntendedKey, { get key() { return key(); } });
  return scope;
}

const answer = (scope: Container) => createResponseFactory()(new RedirectResult('/fallback').intended(), { request: new Request('http://localhost/login', { method: 'POST' }) }, scope);

describe('a redirect to the intended page', () => {
  it('reads the key the scope binds, and never the default one', async () => {
    const { flasher, pulled } = sessionWith({ [INTENDED_KEY]: '/app-page', '_auth:office:intended': '/office-page' });
    const response = await answer(scopeOf(flasher, () => '_auth:office:intended'));
    expect(response.headers.get('location')).toBe('/office-page');
    expect(pulled).toEqual(['_auth:office:intended']);
  });

  it('reads the key when the redirect is made, not when the scope was built', async () => {
    const { flasher } = sessionWith({ [INTENDED_KEY]: '/app-page', '_auth:office:intended': '/office-page' });
    let key = INTENDED_KEY;
    const scope = scopeOf(flasher, () => key);
    key = '_auth:office:intended';
    expect((await answer(scope)).headers.get('location')).toBe('/office-page');
  });

  it('reads no key when the scope binds none to read, and takes the fallback', async () => {
    const { flasher, pulled } = sessionWith({ [INTENDED_KEY]: '/app-page', '_auth:office:intended': '/office-page' });
    expect((await answer(scopeOf(flasher, () => null))).headers.get('location')).toBe('/fallback');
    expect(pulled).toEqual([]);
  });

  it('does not ask for the key of a plain redirect: a scope whose key cannot be made still redirects', async () => {
    const { flasher } = sessionWith({});
    const scope = scopeOf(flasher, () => {
      throw new Error('no session');
    });
    const response = await createResponseFactory()(new RedirectResult('/plain'), { request: new Request('http://localhost/login', { method: 'POST' }) }, scope);
    expect(response.headers.get('location')).toBe('/plain');
  });

  it('takes the fallback without asking for a key where the app has no session', async () => {
    const scope = new Container();
    scope.instance(IntendedKey, { get key(): string { throw new Error('no session is bound'); } });
    const response = await answer(scope);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/fallback');
  });

  it('reads the default key where nothing binds one', async () => {
    const { flasher } = sessionWith({ [INTENDED_KEY]: '/app-page', '_auth:office:intended': '/office-page' });
    expect((await answer(scopeOf(flasher))).headers.get('location')).toBe('/app-page');
  });
});
