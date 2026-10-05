import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { defineRoutes, HttpServiceProvider, island, view, type PageObject } from '@bespokecore/http';
import { createHttpKernel, ServerServiceProvider } from '@bespokecore/server';
import { SessionServiceProvider } from '@bespokecore/session';
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
    const answer = await kernel.request('/board', { headers: { 'x-bespoke': 'true' } });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as PageObject).live?.map((entry) => entry.channel)).toEqual(['board.1']);
    expect(answer.headers.getSetCookie().some((cookie) => cookie.startsWith('bespoke_session='))).toBe(true);
  });

  it('an island (read-only, it cannot start a session) answers without the subscription — never a 500', async () => {
    const answer = await kernel.request('/islands/cards', { headers: { 'x-bespoke': 'true', 'x-bespoke-region': 'island' } });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as PageObject;
    expect(body.component).toBe('board/Cards');
    expect(body.live).toBeUndefined();
    expect(answer.headers.get('set-cookie')).toBeNull();
  });
});
