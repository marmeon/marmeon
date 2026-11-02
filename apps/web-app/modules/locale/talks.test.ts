import { defineModule } from '@marmeon/core';
import { Controller, defineRoutes, everyone } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';
import { rememberTalk } from './rememberTalk.ts';
import { TalkCatalog } from './TalkCatalog.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

/** An island of a talk's page: its request runs the hook of the talk's routes with a read-only session. */
class TalkPanelIsland extends Controller {
  handle() {
    return this.island('dashboard/RecentSignIns', { entries: [], now: new Date() });
  }
}

const fixtures = defineModule({
  name: 'talk-fixtures',
  routes: defineRoutes((Route) => {
    Route.authorize(everyone).bind('talk', TalkCatalog, { public: true }).afterAuthorize(rememberTalk).get('/fixtures/talks/:talk/panel', TalkPanelIsland);
  }),
});

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ ...application, modules: [...application.modules!, fixtures] }, { database: 'refresh' });
});

const german = { 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' };
const english = { 'accept-language': 'en' };

describe('a talk page speaks the language of its talk (RequestLocale in afterAuthorize)', () => {
  it('answers in the talk’s language whatever the browser asks for', async () => {
    const response = await app.withHeaders(english).expectingJson().get('/talks/sprachen').assertOk();
    expect(response.json()).toEqual({ locale: 'de', welcome: 'Willkommen bei „Sprachen im Request“.' });
    expect(response.headers.get('content-language')).toBe('de');
    const other = await app.withHeaders(german).expectingJson().get('/talks/routing').assertOk();
    expect(other.json()).toEqual({ locale: 'en', welcome: 'Welcome to “Typed routes”.' });
    expect(other.headers.get('content-language')).toBe('en');
  });

  it('writes the messages of a failed form in the talk’s language', async () => {
    const response = await app.withHeaders(english).expectingJson().post('/talks/sprachen/questions', { json: {} }).assertStatus(422);
    expect(response.json()).toMatchObject({ errors: { question: ['Schreib zuerst deine Frage.'] } });
    const inEnglish = await app.withHeaders(german).expectingJson().post('/talks/routing/questions', { json: {} }).assertStatus(422);
    expect(inEnglish.json()).toMatchObject({ errors: { question: ['Write your question first.'] } });
  });

  it('keeps the visitor’s language for a talk in a language the app does not support', async () => {
    const response = await app.withHeaders(german).expectingJson().get('/talks/langues').assertOk();
    expect(response.json()).toMatchObject({ locale: 'de' });
    expect(response.headers.get('content-language')).toBe('de');
  });

  it('answers a talk that takes no questions with a 403 in the visitor’s language, not the talk’s', async () => {
    const response = await app.withHeaders(english).post('/talks/ruhe/questions', { form: { question: 'Why?' } }).assertForbidden();
    expect(response.headers.get('content-language')).toBe('en');
  });

  it('answers an unknown talk in the visitor’s language', async () => {
    const response = await app.withHeaders(german).get('/talks/nobody').assertNotFound();
    expect(response.headers.get('content-language')).toBe('de');
  });
});

describe('the hook of a talk remembers it in the session only when the request may write', () => {
  it('writes on the page', async () => {
    app.travel({ minutes: 5 });
    // `at` comes from the app's clock, resolved as a token in the hook.
    const before = app.clock.now();
    const response = await app.expectingJson().get('/talks/routing').assertOk();
    const remembered = response.session()['last_talk'] as { slug: string; at: number };
    expect(remembered.slug).toBe('routing');
    // The clock of the test app moves with real time, so the stamp lies between the two readings.
    expect(remembered.at).toBeGreaterThanOrEqual(before);
    expect(remembered.at).toBeLessThanOrEqual(app.clock.now());
  });

  it('leaves an island of the page alone and still answers it', async () => {
    await app.islanding().get('/fixtures/talks/routing/panel').assertOk().assertSessionMissing('last_talk');
  });
});
