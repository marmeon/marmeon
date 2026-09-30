import { AesGcmEncrypter } from '@bespokecore/encryption';
import { createRequestState, defineRoutes, Router, withQueuedCookies } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { CookieEncryption, EncryptCookies } from './encrypt-cookies.ts';

const encrypter = new AesGcmEncrypter(crypto.getRandomValues(new Uint8Array(32)));
const settings = new CookieEncryption().except('XSRF-TOKEN');

const router = new Router({ resolve: () => new EncryptCookies(encrypter, settings) as never }).load(
  defineRoutes((Route) => {
    Route.middleware(EncryptCookies).group((Route) => {
      Route.get('/remember', (ctx) => {
        ctx.cookies.set('theme', 'dark');
        ctx.cookies.set('XSRF-TOKEN', 'readable');
        return null;
      });
      Route.get('/read', (ctx) => ctx.cookies.all());
    });
  }),
);

/** Runs a request like the kernel does: queued cookies are written after dispatch. */
async function send(path: string, cookie = ''): Promise<Response> {
  const request = new Request(`http://app.test${path}`, { headers: { cookie } });
  const state = createRequestState(request);
  const route = router.routes.find((candidate) => candidate.path === path)!;
  return withQueuedCookies(await router.dispatch(route, { request, params: {} }, { state }), state.cookies);
}

function setCookies(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.getSetCookie().map((header) => header.split(';')[0]!.split('=') as [string, string]));
}

describe('EncryptCookies', () => {
  it('encrypts outgoing cookies, except the listed ones', async () => {
    const cookies = setCookies(await send('/remember'));
    expect(cookies.theme).not.toContain('dark');
    expect(cookies.theme!.length).toBeGreaterThan(30);
    expect(cookies['XSRF-TOKEN']).toBe('readable');
  });

  it('decrypts what it encrypted', async () => {
    const { theme } = setCookies(await send('/remember'));
    expect(await (await send('/read', `theme=${theme}`)).json()).toEqual({ theme: 'dark' });
  });

  it('treats tampered, plain, foreign or moved cookies as absent', async () => {
    const { theme } = setCookies(await send('/remember'));
    const tampered = theme!.slice(0, -2) + (theme!.endsWith('A') ? 'BB' : 'AA');
    const foreign = await new AesGcmEncrypter(crypto.getRandomValues(new Uint8Array(32))).encrypt('dark', 'cookie:theme');

    const read = async (cookie: string) => (await send('/read', cookie)).json();
    expect(await read(`theme=${tampered}`)).toEqual({});
    expect(await read('theme=dark')).toEqual({}); // set by hand, not by the app
    expect(await read(`theme=${foreign}`)).toEqual({});
    expect(await read(`accent=${theme}`)).toEqual({}); // bound to the name "theme"
    expect(await read('XSRF-TOKEN=plain')).toEqual({ 'XSRF-TOKEN': 'plain' });
  });
});
