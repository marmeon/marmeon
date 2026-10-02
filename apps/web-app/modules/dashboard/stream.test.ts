import { UserRepository, type User } from '#modules/auth';
import { Session } from '@bespokecore/session';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileActivity } from '../user-profile/ProfileActivity.ts';
import { ProfileDirectory } from '../user-profile/ProfileDirectory.ts';

// The dashboard as a browser gets it (E49): the shell first, the islands — and deferred props — later in the same response.
// "Members" is slow on purpose here (DASHBOARD_ISLAND_DELAY), the profile's activity too (PROFILE_ACTIVITY_DELAY).
const DELAY = 400;
let app: TestApp;
let ada: User;
beforeAll(async () => {
  app = await createTestApp(application, {
    database: 'refresh',
    seed: true,
    ssr: 'stream',
    env: { DASHBOARD_ADMINS: 'ada@example.com', DASHBOARD_ISLAND_DELAY: String(DELAY), PROFILE_ACTIVITY_DELAY: '150' },
  });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada] = users as [User];
  // Warm up Vite's SSR modules: the first render of a page loads them.
  await (await app.actingAs(ada).stream('/dashboard')).text();
  await (await app.actingAs(ada).stream(`/users/${ada.id}`)).text();
});
afterAll(() => app.close());

/** Reads a streamed response, noting when each marker first appeared (ms after the request started). */
async function follow(started: number, response: Response, markers: Record<string, RegExp>) {
  const headers = performance.now() - started;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let html = '';
  const at: Record<string, number> = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    for (const [name, marker] of Object.entries(markers)) if (at[name] === undefined && marker.test(html)) at[name] = performance.now() - started;
  }
  return { headers, html, at, end: performance.now() - started };
}

describe('the dashboard as it streams (E49)', () => {
  it('counter-check: a slow island does not hold the shell back — it arrives later in the same response', async () => {
    const started = performance.now();
    const response = await app.actingAs(ada).stream('/dashboard');
    const { headers, at, end } = await follow(started, response, {
      shell: /<h1>Dashboard<\/h1>/,
      signIns: /data-island="dashboard\.sign-ins" data-status="ready"/,
      members: /data-island="dashboard\.members" data-status="ready"/,
    });
    expect(response.status).toBe(200);
    expect(headers).toBeLessThan(DELAY / 2);
    expect(at.shell!).toBeLessThan(DELAY / 2);
    expect(at.signIns!).toBeLessThan(DELAY / 2);
    expect(at.members!).toBeGreaterThanOrEqual(DELAY);
    expect(end).toBeGreaterThanOrEqual(DELAY);
  });

  it('gives a bot every island in the HTML — the whole page at once', async () => {
    const response = await app.actingAs(ada).stream('/dashboard', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    const html = await response.text();
    expect(html).toMatch(/data-island="dashboard\.members" data-status="ready"/);
    // Complete: no boundary was sent as a fallback first (no `<template>` for a late part, no streaming script).
    expect(html).not.toContain('$RC');
  });

  it('counter-check: an island that writes the session after the headers throws in development — nothing reaches the session', async () => {
    const real = app.make(ProfileDirectory);
    app.container.scoped(ProfileDirectory, (container) =>
      Object.assign(Object.create(real) as ProfileDirectory, {
        recentSignIns: async (...args: Parameters<ProfileDirectory['recentSignIns']>) => {
          container.make(Session).put('island_wrote', true);
          return real.recentSignIns(...args);
        },
      }),
    );
    try {
      const response = await app.actingAs(ada).get('/dashboard', { headers: { accept: 'text/html' } }).assertOk();
      expect(response.body).toMatch(/data-island="dashboard\.sign-ins" data-status="exception"/);
      response.assertSessionMissing('island_wrote');
    } finally {
      app.container.scoped(ProfileDirectory);
    }
  });
});

describe('deferred props in the first response (E49 bonus)', () => {
  it('streams the profile’s activity with the page — the page object says so, the browser does not ask again', async () => {
    const started = performance.now();
    const response = await app.actingAs(ada).stream(`/users/${ada.id}`);
    const { at, html } = await follow(started, response, { shell: /<h1>Ada Lovelace<\/h1>/, activity: /id="bespoke-deferred-[^"]*">\{"props":\{"activity"/ });
    const page = JSON.parse(/<script type="application\/json" id="bespoke-page">(.*?)<\/script>/.exec(html)![1]!) as { streamedProps?: string[]; deferredProps?: Record<string, string[]> };
    expect(page).toMatchObject({ streamedProps: ['default'], deferredProps: { default: ['activity'] } });
    expect(at.shell!).toBeLessThan(150);
    expect(at.activity!).toBeGreaterThanOrEqual(150);
  });

  it('counter-check: a deferred prop that writes the session once the headers are out throws in development — the browser loads the group', async () => {
    const real = app.make(ProfileActivity);
    app.container.scoped(ProfileActivity, (container) =>
      Object.assign(Object.create(real) as ProfileActivity, {
        recent: async (...args: Parameters<ProfileActivity['recent']>) => {
          container.make(Session).put('deferred_wrote', true);
          return real.recent(...args);
        },
      }),
    );
    try {
      const response = await app.actingAs(ada).get(`/users/${ada.id}`, { headers: { accept: 'text/html' } }).assertOk();
      expect(response.body).toMatch(/id="bespoke-deferred-[^"]*">null<\/script>/);
      response.assertSessionMissing('deferred_wrote');
    } finally {
      app.container.scoped(ProfileActivity);
    }
  });
});
