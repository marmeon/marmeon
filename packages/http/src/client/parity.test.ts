import { describe, expect, it } from 'vitest';
import { LOCATION_HEADER, ONCE_HEADER, ONCE_SCOPE_HEADER, RELOAD_HEADER, type PageObject } from '../protocol.ts';
import type { ConfirmRequest } from './confirm.ts';
import { defaultFormEntries, fieldPath, formObject, restoreFormEntries } from './forms.ts';
import { remember } from './features/remember.ts';
import { OnceStore } from './once.ts';
import { isSensitiveRememberField, loadSensitiveFields, rememberable } from './remember.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';
import { prefetch } from './features/prefetch.ts';
import { instant } from './features/instant.ts';
import { guard } from './features/guard.ts';

// The rules that tell sensitive fields load on first use; these tests write and read at once.
await loadSensitiveFields();

/** Remember state, once props, instant visits and the cancelable asset-version reload in the client core. */

const versionConflict = (location = '/people') => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: location, [RELOAD_HEADER]: 'version' } });
const historyConflict = (location = '/login') => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: location, [RELOAD_HEADER]: 'history' } });

const tick = async () => {
  await settle();
  await settle();
};

function tab(initial: PageObject, options: Parameters<typeof boot>[2] = {}) {
  const win = new FakeWindow(`${ORIGIN}${initial.url}`);
  const booted = boot(win, initial, options);
  // Remembered state of the page on screen's entry — the feature attached where it is used.
  const remembered = () => booted.navigator.use(remember).of(booted.owner().entry!);
  return { win, remembered, ...booted };
}

describe('remembered state — in memory, per history entry', () => {
  it('survives Back/Forward with its entry: each entry has its own, the page’s owner carries it', async () => {
    const { win, navigator, remembered } = tab(page('/users/1'));
    const first = remembered();
    first.set('tab', 'links');
    win.handler = () => pageResponse(page('/people', {}, 'pages/People'));
    await navigator.visit('/people');
    expect(remembered()).not.toBe(first);
    expect(remembered().has('tab')).toBe(false);
    remembered().set('q', 'ada');
    win.back();
    await tick();
    expect(remembered().get('tab')).toBe('links');
    win.forward();
    await tick();
    expect(remembered().get('q')).toBe('ada');
  });

  it('is never in history.state — every entry the browser keeps (serialized, written to disk) is scanned', async () => {
    const { win, navigator, remembered } = tab(page('/users/1'));
    remembered().set('draft', { label: 'MARKER-typed-label' });
    win.handler = () => pageResponse(page('/people', {}, 'pages/People'));
    await navigator.visit('/people');
    remembered().set('q', 'MARKER-search');
    win.back();
    await tick();
    expect(win.entries.length).toBe(2);
    for (const entry of win.entries) expect(entry.disk).not.toContain('MARKER');
  });

  it('is forgotten on a 409 (signing out) — also in an entry a component still holds', async () => {
    const { win, navigator, remembered } = tab(page('/users/1'));
    const held = remembered();
    held.set('draft', 'secret plans');
    win.handler = () => pageResponse(page('/people', {}, 'pages/People'));
    await navigator.visit('/people');
    const second = remembered();
    second.set('q', 'ada');
    win.handler = () => historyConflict();
    await navigator.visit('/logout', { method: 'post' });
    expect(win.loads).toEqual(['assign https://app.test/login']);
    expect(held.size).toBe(0);
    expect(second.size).toBe(0);
  });

  it('gone with the entry the cache lets go of: Back to it asks the server, and nothing comes back', async () => {
    const { win, navigator, remembered } = tab(page('/a', {}, 'pages/A'), { cacheSize: 2 });
    remembered().set('draft', 'typed on a');
    win.handler = (url) => pageResponse(page(new URL(url).pathname, {}, 'pages/Other'));
    await navigator.visit('/b');
    await navigator.visit('/c');
    await navigator.visit('/d');
    win.goTo(0);
    await tick();
    expect(navigator.page.url).toBe('/a');
    expect(remembered().has('draft')).toBe(false);
  });

  it('a layer remembers with its own entry: Back closes it, Forward opens it from memory with what it kept', async () => {
    const { win, navigator } = tab(page('/users/1', {}, 'users/Show'));
    win.handler = () => pageResponse({ ...page('/users/1/edit', {}, 'users/Edit'), layer: { key: 'edit', base: '/users/1' } });
    await navigator.visit('/users/1/edit', { layer: true });
    navigator.use(remember).of(navigator.layers[0]!.entry).set('form:user-profile.update', { data: { name: 'Ada X' } });
    win.back();
    await tick();
    expect(navigator.layers).toEqual([]);
    win.forward();
    await tick();
    expect(navigator.use(remember).of(navigator.layers[0]!.entry).get('form:user-profile.update')).toEqual({ data: { name: 'Ada X' } });
  });

  it('keeps no password (even when asked), token, secret or card unless named — and never a file', () => {
    const kept = rememberable(
      {
        name: 'Ada',
        password: 'hunter2',
        password_confirmation: 'hunter2',
        account: { currentPassword: 'old', apiToken: 'marmeon_1|x', bio: 'Hi' },
        card_number: '4242',
        cvc: '123',
        avatar: new Blob(['x']),
        links: [{ url: 'https://a.test', secret: 's' }],
      },
      ['card_number', 'password'],
    );
    expect(kept).toEqual({ name: 'Ada', account: { bio: 'Hi' }, card_number: '4242', links: [{ url: 'https://a.test' }] });
    expect(isSensitiveRememberField('payment.cvc')).toBe(true);
    expect(isSensitiveRememberField('links[0][url]')).toBe(false);
  });

  it('keeps no one-time or recovery code, but a postal code — and a name in `include` lets in all but passwords', () => {
    const dropped = ['otp', 'totp_secret', 'user_otp', 'userOtp', 'otpCode', 'code', 'recovery_codes', 'backup_codes', 'smsCode', 'mfa_code', 'auth-code', 'two_factor_code', 'api_key', 'apiKey', 'private_key', 'signature', 'credentials', 'jwt', 'session_id', 'recovery', 'passcode', 'pass', 'card_number', 'cvv', 'cvc', 'iban', 'payment.otp', 'payment.code', 'dsn', 'app_key', 'appKey', 'encryption_key', 'auth'];
    expect(dropped.filter((name) => !isSensitiveRememberField(name))).toEqual([]);
    const kept = ['footprint', 'hotplate', 'rootPath', 'notPublished', 'language_code', 'currency_code', 'post_code', 'source_code', 'promoCode', 'zip_code', 'postalCode', 'country_code', 'coupon_code', 'barcode', 'passenger', 'name'];
    expect(kept.filter((name) => isSensitiveRememberField(name))).toEqual([]);
    expect(isSensitiveRememberField('otp', ['otp'])).toBe(false);
    for (const name of ['new_password', 'passcode', 'passphrase', 'pass']) expect(isSensitiveRememberField(name, [name])).toBe(true);
  });
});

describe('once props — kept by the tab, skipped by the server', () => {
  const withLocales = (url: string, props: Record<string, unknown>, scope = 'scope-a'): PageObject => ({ ...page(url, props), onceProps: { locales: { key: 'locales' } }, onceScope: scope });

  it('keeps a once prop, names it with every page request, and puts it back when the server skipped it — before anything renders', async () => {
    const { win, navigator, shown } = tab(withLocales('/a', { locales: ['en', 'de'] }));
    win.handler = () => pageResponse(withLocales('/b', {}));
    await navigator.visit('/b');
    expect(win.requests[0]!.headers).toMatchObject({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: 'scope-a' });
    // The page the adapter renders has it — as it came with the first page.
    expect(shown.at(-1)!.props).toEqual({ locales: ['en', 'de'] });
  });

  it('a page of another scope (someone else signed in in another tab) drops what was kept — its own value counts', () => {
    const store = new OnceStore();
    store.receive(withLocales('/a', { locales: ['en'] }, 'ada'));
    expect(store.headers()).toEqual({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: 'ada' });
    const forAlan = store.receive(withLocales('/b', { locales: ['de'] }, 'alan'));
    expect(forAlan.props).toEqual({ locales: ['de'] });
    expect(store.headers()).toEqual({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: 'alan' });
    // Skipped for Alan's scope: Alan's value goes back in, never Ada's.
    expect(store.receive(withLocales('/c', {}, 'alan')).props).toEqual({ locales: ['de'] });
  });

  it('after a scope change nothing of the old scope is named again — the server would trust the new scope', () => {
    const store = new OnceStore();
    store.receive({ ...page('/a', { locales: ['en'], countries: ['DE'] }), onceProps: { locales: { key: 'locales' }, countries: { key: 'countries' } }, onceScope: 'ada' });
    // Alan's first page (another tab signed him in) has only the locale list: Ada's countries must not be named under his scope.
    store.receive(withLocales('/b', { locales: ['en'] }, 'alan'));
    expect(store.headers()).toEqual({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: 'alan' });
  });

  it('a once prop with a `ttl` is not named after it expired — the server sends it again', () => {
    let now = 1_000;
    const store = new OnceStore(() => now);
    store.receive({ ...page('/a', { rates: [1] }), onceProps: { rates: { key: 'rates', expiresAt: 2_000 } } });
    expect(store.keys()).toEqual(['rates']);
    now = 2_000;
    expect(store.headers()).toEqual({});
  });

  it('a prefetched page is filled when it arrives — the visit that takes it shows the kept value', async () => {
    const { win, navigator } = tab(withLocales('/a', { locales: ['en'] }));
    win.handler = () => pageResponse(withLocales('/b', {}));
    await navigator.use(prefetch).prefetch('/b');
    expect(win.requests[0]!.headers).toMatchObject({ [ONCE_HEADER]: 'locales' });
    win.handler = () => new Response('unused', { status: 500 });
    const shown = await navigator.visit('/b');
    expect(shown?.props).toEqual({ locales: ['en'] });
  });
});

describe('instant visits — the placeholder first, the page when it lands', () => {
  const people = (url = '/people') => pageResponse(page(url, { people: [{ id: 2, name: 'Grace' }] }, 'pages/People'));

  it('renders the target view’s placeholder with what the link gave it — never the view with partial props — then the page', async () => {
    const { win, navigator, renders } = tab(page('/users/1', { name: 'Ada' }, 'users/Show'));
    navigator.use(instant); // attached where an instant link renders
    let answer!: () => void;
    win.handler = () => new Promise<Response>((resolve) => (answer = () => resolve(pageResponse(page('/users/2', { profile: { id: 2, name: 'Grace', bio: 'Hopper' } }, 'users/Show')))));
    const visiting = navigator.visit('/users/2', { instant: { component: 'users/Show', props: { name: 'Grace' } } });
    await settle();
    expect(renders.at(-1)).toEqual({ placeholder: true, page: { component: 'users/Show', props: { name: 'Grace' }, url: '/users/2' } });
    // Not committed yet: the address bar and the history are the page's before.
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`]);
    expect(navigator.page.url).toBe('/users/1');
    answer();
    await visiting;
    expect(renders.at(-1)).toMatchObject({ placeholder: false, page: { url: '/users/2', props: { profile: { name: 'Grace', bio: 'Hopper' } } } });
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`, `${ORIGIN}/users/2`]);
    // The real view rendered only with its page — every non-placeholder render had the server's props.
    for (const { page: rendered } of renders.filter((render) => !render.placeholder && render.page.url === '/users/2')) expect(rendered.props).toHaveProperty('profile');
  });

  it('a visit that fails shows the page on screen again — the history untouched, scrolled where it was', async () => {
    const { win, navigator, renders } = tab(page('/users/1', { name: 'Ada' }, 'users/Show'));
    navigator.use(instant); // attached where an instant link renders
    win.scroll(420);
    win.handler = () => new Response('<h1>Down</h1>', { status: 503 });
    await navigator.visit('/people', { instant: { component: 'pages/People' } });
    await settle();
    expect(renders.map((render) => [render.placeholder, render.page.url])).toEqual([
      [true, '/people'],
      [false, '/users/1'],
    ]);
    expect(win.entries.length).toBe(1);
    expect(win.scrollY).toBe(420);
  });

  it('Back during an instant visit cancels it — what the entry shows takes the placeholder’s place, the page never lands', async () => {
    const { win, navigator, renders } = tab(page('/a', {}, 'pages/A'));
    navigator.use(instant); // attached where an instant link renders
    win.handler = () => pageResponse(page('/b', {}, 'pages/B'));
    await navigator.visit('/b');
    let answer!: () => void;
    win.handler = () => new Promise<Response>((resolve) => (answer = () => resolve(people())));
    const visiting = navigator.visit('/people', { instant: { component: 'pages/People' } });
    await settle();
    expect(renders.at(-1)!.placeholder).toBe(true);
    win.back();
    await tick();
    answer();
    await visiting;
    await tick();
    expect(navigator.page.url).toBe('/a');
    expect(renders.at(-1)).toMatchObject({ placeholder: false, page: { url: '/a' } });
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
  });

  it('Back to an entry not in memory during an instant visit — the page left is not shown again under its URL', async () => {
    const { win, navigator, renders } = tab(page('/a', {}, 'pages/A'), { cacheSize: 1 });
    navigator.use(instant); // attached where an instant link renders
    win.handler = () => pageResponse(page('/b', {}, 'pages/B'));
    await navigator.visit('/b');
    const answers: Record<string, () => void> = {};
    win.handler = (url) =>
      new Promise<Response>((resolve) => {
        const path = new URL(url).pathname;
        answers[path] = () => resolve(path === '/a' ? pageResponse(page('/a', {}, 'pages/A')) : people());
      });
    const visiting = navigator.visit('/people', { instant: { component: 'pages/People' } });
    await settle();
    win.back();
    await tick();
    answers['/people']!();
    await visiting;
    await tick();
    // While /a loads (it is not in memory), nothing shows /b again — the placeholder stays until /a is here.
    expect(renders.at(-1)).toMatchObject({ placeholder: true, page: { url: '/people' } });
    answers['/a']!();
    await tick();
    expect(renders.at(-1)).toMatchObject({ placeholder: false, page: { url: '/a' } });
  });

  it('a page fetched ahead shows at once — no placeholder in between', async () => {
    const { win, navigator, renders } = tab(page('/users/1', {}, 'users/Show'));
    navigator.use(instant); // attached where an instant link renders
    win.handler = () => people();
    await navigator.use(prefetch).prefetch('/people');
    await navigator.visit('/people', { instant: { component: 'pages/People' } });
    expect(renders.some((render) => render.placeholder)).toBe(false);
    expect(navigator.page.url).toBe('/people');
  });
});

describe('the asset-version reload — cancelable; signing in or out is not', () => {
  it('fires `version` for a new build: prevented, the page stays — and the user’s next visit loads fully', async () => {
    const { win, navigator } = tab(page('/users/1'));
    const events: string[] = [];
    navigator.on('version', (event) => {
      events.push(`${event.location} unsaved=${event.unsaved}`);
      event.preventDefault();
    });
    win.handler = () => versionConflict('/people');
    expect(await navigator.visit('/people')).toBeUndefined();
    expect(events).toEqual(['https://app.test/people unsaved=false']);
    expect(win.loads).toEqual([]);
    expect(navigator.page.url).toBe('/users/1');
    expect(navigator.newVersion).toBe('https://app.test/people');
    // Background requests find out again — no new event, no load.
    await navigator.reload({ only: ['activity'], async: true });
    expect(events.length).toBe(1);
    await navigator.visit('/dashboard');
    expect(win.loads).toEqual([`assign ${ORIGIN}/dashboard`]);
  });

  it('the 409 of signing in or out is never cancelable — the `version` listener is not even asked', async () => {
    const { win, navigator } = tab(page('/users/1'));
    const events: string[] = [];
    navigator.on('version', (event) => {
      events.push(event.location);
      event.preventDefault();
    });
    win.handler = () => historyConflict('/login');
    await navigator.visit('/logout', { method: 'post' });
    expect(events).toEqual([]);
    expect(win.loads).toEqual(['assign https://app.test/login']);
  });

  it('an unknown reload value is a full load nothing can postpone — the `version` listener is not asked', async () => {
    const { win, navigator } = tab(page('/users/1'));
    const asked: string[] = [];
    navigator.on('version', (event) => (asked.push(event.location), event.preventDefault()));
    win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'a-reason-of-a-later-release' } });
    await navigator.visit('/people');
    expect(asked).toEqual([]);
    expect(win.loads).toEqual(['assign https://app.test/login']);
  });

  it('a 409 without a reason (an older server, a proxy) or with any other value is a document change too', async () => {
    for (const reason of [undefined, 'Version', 'version, history', 'history']) {
      const { win, navigator } = tab(page('/users/1'));
      navigator.on('version', (event) => event.preventDefault());
      win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', ...(reason !== undefined ? { [RELOAD_HEADER]: reason } : {}) } });
      await navigator.visit('/people');
      expect(win.loads).toEqual(['assign https://app.test/login']);
    }
  });

  it('with unsaved changes a new build asks first (the guard) — Stay keeps the page and the input; Leave loads', async () => {
    for (const answer of [false, true]) {
      const asked: ConfirmRequest[] = [];
      const { win, navigator } = tab(page('/users/1'), { confirm: async (request) => (asked.push(request), answer) });
      navigator.use(guard).add({ message: 'Unsaved changes — leave?' });
      // A poll (in the background) finds the new build: nobody agreed to leave.
      win.handler = () => versionConflict('/users/1');
      await navigator.reload({ only: ['activity'], async: true });
      expect(asked.map((request) => request.message)).toEqual(['Unsaved changes — leave?']);
      expect(win.loads).toEqual(answer ? ['replace https://app.test/users/1'] : []);
      expect(navigator.newVersion).toBe(answer ? undefined : 'https://app.test/users/1');
    }
  });

  it('a visit that was allowed to leave the unsaved changes already asks nothing more — the new build loads', async () => {
    const asked: ConfirmRequest[] = [];
    const { win, navigator } = tab(page('/users/1'), { confirm: async (request) => (asked.push(request), true) });
    navigator.use(guard).add({ message: 'Unsaved changes — leave?' });
    win.handler = () => versionConflict('/people');
    await navigator.visit('/people');
    expect(asked.length).toBe(1);
    expect(win.loads).toEqual(['assign https://app.test/people']);
  });

  it('signing out with unsaved changes never asks — the full load wins over the guard', async () => {
    const asked: ConfirmRequest[] = [];
    const { win, navigator } = tab(page('/users/1'), { confirm: async (request) => (asked.push(request), false) });
    navigator.use(guard).add({ message: 'Unsaved changes — leave?' });
    // Signed out in another tab: the next poll gets the 409 of the session change.
    win.handler = () => historyConflict('/login');
    await navigator.reload({ only: ['activity'], async: true });
    expect(asked).toEqual([]);
    expect(win.loads).toEqual(['replace https://app.test/login']);
    expect(win.unload()).toBe(false);
  });
});

describe('uncontrolled forms — what a native form holds', () => {
  it('builds the data the server builds: bracket notation, lists, nested objects — no `__proto__`', () => {
    expect(
      formObject([
        ['name', 'Ada'],
        ['abilities[]', 'users:read'],
        ['abilities[]', 'users:write'],
        ['links[0][url]', 'https://a.test'],
        ['links[0][label]', 'A'],
        ['user[address][city]', 'London'],
        ['__proto__[x]', 'y'],
      ]),
    ).toEqual({ name: 'Ada', abilities: ['users:read', 'users:write'], links: [{ url: 'https://a.test', label: 'A' }], user: { address: { city: 'London' } } });
    expect(fieldPath('links[0][url]')).toBe('links.0.url');
    expect(fieldPath('abilities[]')).toBe('abilities');
  });

  it('reads the defaults of the controls and puts remembered entries back by name', () => {
    const text = { name: 'name', type: 'text', value: 'typed', defaultValue: 'Ada' };
    const box = { name: 'abilities[]', type: 'checkbox', value: 'users:read', checked: false, defaultChecked: true };
    const other = { name: 'abilities[]', type: 'checkbox', value: 'users:write', checked: false, defaultChecked: false };
    const token = { name: 'card_number', type: 'text', value: '', defaultValue: '' };
    const form = { elements: [text, box, other, token] };
    expect(defaultFormEntries(form)).toEqual([
      ['name', 'Ada'],
      ['abilities[]', 'users:read'],
      ['card_number', ''],
    ]);
    restoreFormEntries(form, [['name', 'Ada L.'], ['abilities[]', 'users:write']], ['name', 'abilities[]']);
    expect([text.value, box.checked, other.checked, token.value]).toEqual(['Ada L.', false, true, '']);
  });
});
