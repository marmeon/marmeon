import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
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
