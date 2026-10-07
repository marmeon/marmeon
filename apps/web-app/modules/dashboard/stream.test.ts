import { UserRepository, type User } from '#modules/auth';
import { Session } from '@marmeon/session';
import { createTestApp, type TestApp } from '@marmeon/testing';
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

  it('streams under the strict CSP (E147): React\'s scripts that reveal the late islands carry the response\'s nonce — every script does', async () => {
    const response = await app.actingAs(ada).stream('/dashboard');
    const html = await response.text();
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(response.headers.get('content-security-policy')).toBe(`script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'self'; style-src 'self' 'nonce-${nonce}'; frame-ancestors 'none'`);
    expect(html).toMatch(/data-island="dashboard\.members" data-status="ready"/);
    expect(html).toContain('$RC'); // a boundary streamed in after the shell
    const scripts = html.match(/<script\b[^>]*>/g)!;
    const executable = scripts.filter((tag) => !tag.includes('type="application/json"'));
    expect(executable.length).toBeGreaterThan(2);
    for (const tag of executable) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).not.toContain('__marmeon_csp_nonce__');
    // Another response, another nonce.
    const next = await app.actingAs(ada).stream('/dashboard');
    await next.text();
    expect(next.headers.get('content-security-policy')).not.toContain(nonce);
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
    const { at, html } = await follow(started, response, { shell: /<h1>Ada Lovelace<\/h1>/, activity: /id="marmeon-deferred-[^"]*">\{"props":\{"activity"/ });
    const page = JSON.parse(/<script type="application\/json" id="marmeon-page">(.*?)<\/script>/.exec(html)![1]!) as { streamedProps?: string[]; deferredProps?: Record<string, string[]> };
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
      expect(response.body).toMatch(/id="marmeon-deferred-[^"]*">null<\/script>/);
      response.assertSessionMissing('deferred_wrote');
    } finally {
      app.container.scoped(ProfileActivity);
    }
  });
});

describe('a deep link of a layer, streamed (E53, E71)', () => {
  it('the layer renders in the shell over its base — with the page, not a boundary streamed later', async () => {
    const started = performance.now();
    const streamed = await app.actingAs(ada).stream(`/users/${ada.id}/edit`);
    const { at, html } = await follow(started, streamed, { shell: /<h1>Ada Lovelace<\/h1>/, layer: /<dialog open="" data-marmeon-layer="user-profile\/Edit"/ });
    // In the shell — it hydrates there (ssr.test.ts), the browser loads the layer code first: no later than the profile's
    // deferred activity (150 ms) would take, counted from the shell — not from the request, whose shell a loaded machine
    // can hold back on its own (W6.11: 228 ms under a full `test:pgsql`).
    expect(at.layer! - at.shell!).toBeLessThan(150);
    expect(html.indexOf('data-marmeon-layer')).toBeGreaterThan(html.indexOf('<h1>Ada Lovelace</h1>'));
    // Not a part streamed after the shell (React sends those as hidden segments).
    expect(html.slice(0, html.indexOf('data-marmeon-layer'))).not.toContain('<div hidden id="');
    // Rendered at once, not suspended: the layer stack's code was loaded before rendering (a boundary already resolved, `<!--$-->`).
    expect(html).toContain('<!--$--><div data-marmeon-layers="">');
  });
});

describe('hydration, streamed (assertHydrates with ssr: "stream")', () => {
  it('the dashboard, the profile with its streamed activity and a layer’s deep link hydrate — compared as the browser has them once everything streamed in', async () => {
    await app.actingAs(ada).get('/dashboard', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    await app.actingAs(ada).get(`/users/${ada.id}`, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    await app.actingAs(ada).get(`/users/${ada.id}/edit`, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
  });
});
