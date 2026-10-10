import { tmpdir } from 'node:os';
import { defineModule, type ApplicationOptions } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRoutes, HttpServiceProvider, LIVE_PATH, ServerClosing, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { Broadcaster, LiveServiceProvider } from '@marmeon/live';
import { Session, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /** The live test app's counter in every layout. */
    counter?: number;
  }
}

class ShowBoardController extends Controller {
  handle(ctx: HttpContext<{}, { board: string }>) {
    return this.view('board/Show', { cards: ['a'], title: 'Board' }).live(`board.${ctx.params.board}`, { only: ['cards'] });
  }
}

class EditBoardController extends Controller {
  handle(ctx: HttpContext<{}, { board: string }>) {
    return this.view('board/Edit', { title: 'Board' })
      .layer({ base: 'board.show' as never, params: { board: ctx.params.board } as never })
      .live(`board.${ctx.params.board}`, { only: ['title'] });
  }
}

class BoardIslandController extends Controller {
  handle() {
    return this.island('board/Cards', { cards: ['a'] }).live('board.cards');
  }
}

class AddCardController extends Controller {
  readonly #broadcast: Broadcaster;
  constructor(broadcast: Broadcaster) {
    super();
    this.#broadcast = broadcast;
  }
  async handle(ctx: HttpContext<{}, { board: string }>) {
    await this.#broadcast.refresh(`board.${ctx.params.board}`, { only: ['cards'] });
    return this.redirect().route('board.show' as never, { board: ctx.params.board } as never);
  }
}

class SignOutController {
  readonly #session: Session;
  constructor(session: Session) {
    this.#session = session;
  }
  handle() {
    this.#session.invalidate();
    return new Response(null, { status: 204 });
  }
}

/** Shares a live channel with every page — like the bell in a layout. */
class ShareCounter {
  readonly #shared: SharedData;
  constructor(shared: SharedData) {
    this.#shared = shared;
  }
  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('counter', 1).live(() => 'counters.everyone', { only: ['counter'] });
    return next();
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/boards/:board', ShowBoardController).name('board.show');
  Route.get('/boards/:board/edit', EditBoardController);
  Route.get('/islands/board', BoardIslandController);
  Route.post('/boards/:board/cards', AddCardController);
  Route.post('/sign-out', SignOutController);
});

const definition: ApplicationOptions = {
  root: tmpdir(),
  discover: false,
  env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LIVE_HEARTBEAT: '1' },
  providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, LiveServiceProvider],
  middleware: { web: [ShareCounter] },
  modules: [defineModule({ name: 'board', routes })],
};

describe('live props through the app — the page declares, the stream hints', () => {
  it('signs what a page, a layer and an island follow into their objects — a page also what every page shares', async () => {
    const app = await createTestApp(definition);
    const ada = app.withSession({ who: 'ada' });
    const page = (await ada.navigating().get('/boards/7').assertOk()).page()!;
    expect(page.live).toEqual([
      { channel: 'counters.everyone', only: ['counter'], token: expect.stringMatching(/^[\w-]{43}$/) },
      { channel: 'board.7', only: ['cards'], token: expect.stringMatching(/^[\w-]{43}$/) },
    ]);
    // A layer shows no layout: only its own channel.
    const layer = (await ada.layering().get('/boards/7/edit').assertOk()).page()!;
    expect(layer.live).toEqual([{ channel: 'board.7', only: ['title'], token: page.live![1]!.token }]);
    const island = (await ada.islanding().get('/islands/board').assertOk()).json() as { live?: unknown };
    expect(island.live).toEqual([{ channel: 'board.cards', token: expect.any(String) }]);
    // Another session: other tokens for the same channels.
    const grace = (await app.withSession({ who: 'grace' }).navigating().get('/boards/7')).page()!;
    expect(grace.live![1]!.token).not.toBe(page.live![1]!.token);
  });

  it('a refresh reaches the tabs that follow the channel — the tab that caused it gets nothing to reload; app.broadcast saw it', async () => {
    const app = await createTestApp(definition);
    const ada = app.withSession({ who: 'ada' });
    const tabA = await ada.live('/boards/7', { connection: 'tab-a-0001' });
    const tabB = await ada.live('/boards/7', { connection: 'tab-b-0001' });
    expect(await tabB.hello()).toEqual({ seq: { 'counters.everyone': 0, 'board.7': 0 } });
    await tabA.hello();
    await ada.withHeaders({ 'x-marmeon-connection': 'tab-a-0001' }).post('/boards/7/cards').assertRedirect('/boards/7');
    await Promise.all([tabA.waitFor(1), tabB.waitFor(1)]);
    expect(tabB.hints).toEqual([{ channel: 'board.7', only: ['cards'], seq: 1 }]);
    expect(tabA.hints).toEqual([{ channel: 'board.7', only: [], seq: 1 }]);
    app.broadcast.assertRefreshed('board.7', { only: ['cards'], times: 1 }).assertNotRefreshed('board.8');
    expect(app.broadcast.refreshed('board.7')[0]?.connection).toBe('tab-a-0001');
  });

  it('the stream is read-only: no cookie, the session not written — with the stream headers', async () => {
    const app = await createTestApp(definition);
    const ada = app.withSession({ who: 'ada' });
    const stream = await ada.live('/boards/7');
    await stream.hello();
    expect(stream.status).toBe(200);
    expect(stream.response.headers.get('set-cookie')).toBeNull();
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.response.headers.get('cache-control')).toBe('no-cache, no-store, no-transform');
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  });

  it('a token rewritten to another channel, or of another session, opens no stream (403)', async () => {
    const app = await createTestApp(definition);
    const ada = app.withSession({ who: 'ada' });
    const page = (await ada.navigating().get('/boards/7')).page()!;
    const forged = page.live!.map((subscription) => ({ ...subscription, channel: subscription.channel.replace('board.7', 'board.8') }));
    expect((await ada.live(forged)).status).toBe(403);
    expect((await app.withSession({ who: 'grace' }).live(page.live!)).status).toBe(403);
    expect((await ada.live(page.live!)).status).toBe(200);
  });

  it('signing out in one tab closes the streams of the session in every tab — `end`, no further hints; the old tokens are void', async () => {
    const app = await createTestApp(definition);
    const ada = app.withSession({ who: 'ada' });
    const page = (await ada.navigating().get('/boards/7')).page()!;
    const tabB = await ada.live(page.live!, { connection: 'tab-b-0001' });
    await tabB.hello();
    await ada.post('/sign-out').assertStatus(204);
    await tabB.closed;
    expect(tabB.events.map((each) => each.event)).toEqual(['hello', 'end']);
    await app.withSession({ who: 'grace' }).post('/boards/7/cards');
    expect(tabB.hints).toEqual([]);
    // The tab's cookie still names the old session — gone from the store: no session, no stream (none is made for it).
    expect((await ada.withHeaders({}).live(page.live!)).status).toBe(200); // `withSession` writes the session afresh (a test view)
    const stale = await app.withUnencryptedCookie('marmeon_session', 'gone').live(page.live!);
    expect(stale.status).toBe(401);
  });

  it('the server closing ends every stream', async () => {
    const app = await createTestApp(definition);
    const stream = await app.withSession({ who: 'ada' }).live('/boards/7');
    await stream.hello();
    app.make(ServerClosing).close();
    await stream.closed;
    expect(stream.events.map((each) => each.event)).toEqual(['hello']);
  });

  it('a page that follows a channel in an app without @marmeon/live says what to install', async () => {
    const app = await createTestApp({ ...definition, providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider], middleware: {} });
    const answer = await app.withSession({ who: 'ada' }).navigating().get('/boards/7');
    expect(answer.status).toBe(500);
    expect(() => app.broadcast).toThrow('app.broadcast needs @marmeon/live in the app.');
    expect(LIVE_PATH).toBe('/_marmeon/live');
  });
});
