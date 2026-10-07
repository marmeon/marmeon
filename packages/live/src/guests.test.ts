import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, HttpServiceProvider, island, view, type PageObject } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { LiveServiceProvider } from './index.ts';

describe('a guest without a session follows a channel (no guest sessions, W8 step 6)', async () => {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', NODE_ENV: 'test' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ServerServiceProvider, LiveServiceProvider],
    modules: [
      defineModule({
        name: 'board',
        routes: defineRoutes((Route) => {
          Route.get('/board', () => view('board/Show', {}).live('board.1'));
          Route.get('/islands/cards', () => island('board/Cards', { cards: [] }).live('board.cards'));
        }),
      }),
    ],
  });
  const kernel = createHttpKernel(application, { strictReadOnly: true });

  it('a page signs the channel and keeps the session for it', async () => {
    const answer = await kernel.request('/board', { headers: { 'x-marmeon': 'true' } });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as PageObject).live?.map((entry) => entry.channel)).toEqual(['board.1']);
    expect(answer.headers.getSetCookie().some((cookie) => cookie.startsWith('marmeon_session='))).toBe(true);
  });

  it('the stream\'s path is read-only by itself — without `Accept: text/event-stream` no cookie, the session not saved (W9 step 4)', async () => {
    const answer = await kernel.request('/board', { headers: { 'x-marmeon': 'true' } });
    const cookie = answer.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { channel, token } = ((await answer.json()) as PageObject).live![0]!;
    const query = `connection=tab-a-0001&c=${encodeURIComponent(`${token}.${channel}`)}`;
    // A script or a proxy that leaves the header out: the same stream — and nothing written (strict: a write would throw).
    for (const headers of [{ cookie }, { cookie, accept: '*/*' }]) {
      const stream = await kernel.request(`/_marmeon/live?${query}`, { headers });
      expect(stream.status).toBe(200);
      expect(stream.headers.getSetCookie()).toEqual([]);
      await stream.body?.cancel();
    }
  });

  it('an island (read-only, it cannot start a session) answers without the subscription — never a 500', async () => {
    const answer = await kernel.request('/islands/cards', { headers: { 'x-marmeon': 'true', 'x-marmeon-region': 'island' } });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as PageObject;
    expect(body.component).toBe('board/Cards');
    expect(body.live).toBeUndefined();
    expect(answer.headers.get('set-cookie')).toBeNull();
  });
});
