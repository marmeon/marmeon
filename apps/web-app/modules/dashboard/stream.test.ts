import { UserRepository, type User } from '#modules/auth';
import { MemberStats } from '#modules/user-profile';
import { Session } from '@marmeon/session';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileActivity } from '../user-profile/ProfileActivity.ts';
import { ProfileDirectory } from '../user-profile/ProfileDirectory.ts';

// The dashboard as a browser gets it: the shell first, the islands — and deferred props — later in the same response.
// "Members" and the profile's activity are held back by a gate the test opens once the part before them has arrived: what
// streams first is a matter of order, not of milliseconds.
let app: TestApp;
let ada: User;
// Taken before any test replaces them: `ProfileActivity` is scoped, so it cannot be resolved from the app once it was re-registered.
let realMembers: MemberStats;
let realActivity: ProfileActivity;
beforeAll(async () => {
  app = await createTestApp(application, {
    database: 'refresh',
    seed: true,
    ssr: 'stream',
    env: { DASHBOARD_ADMINS: 'ada@example.com' },
  });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada] = users as [User];
  realMembers = app.make(MemberStats);
  realActivity = app.make(ProfileActivity);
  // Warm up Vite's SSR modules: the first render of a page loads them.
  await (await app.actingAs(ada).stream('/dashboard')).text();
  await (await app.actingAs(ada).stream(`/users/${ada.public_id}`)).text();
});
afterAll(() => app.close());

/** A promise the test settles by hand, to hold a part of a page back until the part before it has arrived. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: () => resolve() };
}

/** Holds `MemberStats.current()` (the "Members" island) back until `opened` settles. */
function holdMembers(opened: Promise<void>) {
  const real = realMembers;
  app.container.scoped(MemberStats, () =>
    Object.assign(Object.create(real) as MemberStats, {
      current: async () => {
        await opened;
        return real.current();
      },
    }),
  );
}

/** Holds `ProfileActivity.recent()` (the profile's deferred panel) back until `opened` settles. */
function holdActivity(opened: Promise<void>) {
  const real = realActivity;
  app.container.scoped(ProfileActivity, () =>
    Object.assign(Object.create(real) as ProfileActivity, {
      recent: async (...args: Parameters<ProfileActivity['recent']>) => {
        await opened;
        return real.recent(...args);
      },
    }),
  );
}

/**
 * Reads a streamed response and returns the markers in the order they first appeared. `onFirst` runs when a marker appears —
 * that is where a test opens its gate, so a part held back can only arrive after the part it waits for.
 */
async function follow(response: Response, markers: Record<string, RegExp>, onFirst: (name: string) => void = () => {}) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let html = '';
  const order: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    for (const [name, marker] of Object.entries(markers)) {
      if (order.includes(name) || !marker.test(html)) continue;
      order.push(name);
      onFirst(name);
    }
  }
  return { html, order };
}

describe('the dashboard as it streams', () => {
  it('a slow island does not hold the shell back — it arrives later in the same response', async () => {
    const members = gate();
    holdMembers(members.opened);
    try {
      // The response itself comes while "Members" is held; the island follows once the shell and the other islands are in.
      const response = await app.actingAs(ada).stream('/dashboard');
      const { order } = await follow(
        response,
        {
          shell: /<h1>Dashboard<\/h1>/,
          signIns: /data-island="dashboard\.sign-ins" data-status="ready"/,
          members: /data-island="dashboard\.members" data-status="ready"/,
        },
        (name) => {
          if (name === 'signIns') members.open();
        },
      );
      expect(response.status).toBe(200);
      expect(order).toEqual(['shell', 'signIns', 'members']);
    } finally {
      members.open();
      app.container.singleton(MemberStats);
    }
  });

  it('streams under the strict CSP: React\'s scripts that reveal the late islands carry the response\'s nonce — every script does', async () => {
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

  it('an island that writes the session after the headers throws in development — nothing reaches the session', async () => {
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

describe('deferred props in the first response', () => {
  it('streams the profile’s activity with the page — the page object says so, the browser does not ask again', async () => {
    const activity = gate();
    holdActivity(activity.opened);
    try {
      const response = await app.actingAs(ada).stream(`/users/${ada.public_id}`);
      const { order, html } = await follow(response, { shell: /<h1>Ada Lovelace<\/h1>/, activity: /id="marmeon-deferred-[^"]*">\{"props":\{"activity"/ }, (name) => {
        if (name === 'shell') activity.open();
      });
      const page = JSON.parse(/<script type="application\/json" id="marmeon-page">(.*?)<\/script>/.exec(html)![1]!) as { streamedProps?: string[]; deferredProps?: Record<string, string[]> };
      expect(page).toMatchObject({ streamedProps: ['default'], deferredProps: { default: ['activity'] } });
      expect(order).toEqual(['shell', 'activity']);
    } finally {
      activity.open();
      app.container.scoped(ProfileActivity);
    }
  });

  it('a deferred prop that writes the session once the headers are out throws in development — the browser loads the group', async () => {
    const real = realActivity;
    app.container.scoped(ProfileActivity, (container) =>
      Object.assign(Object.create(real) as ProfileActivity, {
        recent: async (...args: Parameters<ProfileActivity['recent']>) => {
          container.make(Session).put('deferred_wrote', true);
          return real.recent(...args);
        },
      }),
    );
    try {
      const response = await app.actingAs(ada).get(`/users/${ada.public_id}`, { headers: { accept: 'text/html' } }).assertOk();
      expect(response.body).toMatch(/id="marmeon-deferred-[^"]*">null<\/script>/);
      response.assertSessionMissing('deferred_wrote');
    } finally {
      app.container.scoped(ProfileActivity);
    }
  });
});

describe('a deep link of a layer, streamed', () => {
  it('the layer renders in the shell over its base — with the page, not a boundary streamed later', async () => {
    const streamed = await app.actingAs(ada).stream(`/users/${ada.public_id}/edit`);
    const { html } = await follow(streamed, {});
    // In the shell — it hydrates there (ssr.test.ts), the browser loads the layer code first.
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
    await app.actingAs(ada).get(`/users/${ada.public_id}`, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    await app.actingAs(ada).get(`/users/${ada.public_id}/edit`, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
  });
});
