import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_HEADER, ACTION_REDIRECT_HEADER, LOCATION_HEADER, PAGE_HEADER, VALIDATE_HEADER, VALIDATED_HEADER } from '../page.ts';
import { liveValidation } from './features/live-validation.ts';
import { liveValidationOnFirstUse, loadLiveValidation } from './lazy.ts';
import { isSensitiveField, liveValidationData, type LiveValidationOutcome } from './live-validation.ts';
import { boot, FakeWindow, ORIGIN, page } from './test-window.ts';

const valid = (fields: string) => new Response(null, { status: 204, headers: { [VALIDATED_HEADER]: fields } });
const invalid = (fields: string, errors: Record<string, string[]>) =>
  new Response(JSON.stringify({ message: 'The given data was invalid.', errors }), { status: 422, headers: { 'content-type': 'application/json', [VALIDATED_HEADER]: fields } });

/** A response the test lets through when it says so. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

function setup() {
  const win = new FakeWindow(`${ORIGIN}/register`);
  const bodies: unknown[] = [];
  const { navigator } = boot(win, page('/register', {}, 'auth/Register'));
  // Attached where a form uses it (E70, E74) — no navigator has it by default.
  const live = navigator.use(liveValidation);
  const record = (init?: RequestInit) => bodies.push(JSON.parse(String(init?.body ?? 'null')));
  return { win, navigator, live, bodies, record };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('live validation in the core (E62)', () => {
  it('sends the form’s own request naming the fields — never cached, never followed, no page or action header', async () => {
    const { win, live, record } = setup();
    let init: RequestInit | undefined;
    win.handler = (_url, request) => {
      init = request;
      record(request);
      return valid('name,email');
    };
    const outcome = await live.validate('/register', { method: 'post', data: { name: 'Ada', email: 'ada@example.com' }, fields: ['name', 'email'] });
    expect(outcome).toEqual({ kind: 'valid', fields: ['name', 'email'] });
    expect(win.requests[0]).toMatchObject({ url: `${ORIGIN}/register`, method: 'POST', headers: expect.objectContaining({ [VALIDATE_HEADER]: 'name,email', accept: 'application/json' }) });
    expect(win.requests[0]!.headers[PAGE_HEADER]).toBeUndefined();
    expect(win.requests[0]!.headers[ACTION_HEADER]).toBeUndefined();
    expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
  });

  it('never sends a password field — not named, not in the body, at no depth (Gegenprobe: the body of the check)', async () => {
    const { win, live, bodies, record } = setup();
    win.handler = (_url, request) => {
      record(request);
      return valid('name');
    };
    const data = { name: 'Ada', password: 'hunter2-secret', password_confirmation: 'hunter2-secret', account: { currentPassword: 'old-secret', email: 'a@b.c' } };
    await live.validate('/register', { method: 'post', data, fields: ['name', 'password', 'account.currentPassword'] });
    expect(win.requests[0]!.headers[VALIDATE_HEADER]).toBe('name');
    expect(bodies[0]).toEqual({ name: 'Ada', account: { email: 'a@b.c' } });
    expect(JSON.stringify(bodies)).not.toContain('secret');
    // Only password fields named: nothing to ask — no request at all.
    expect(await live.validate('/register', { method: 'post', data, fields: ['password'] })).toEqual({ kind: 'cancelled' });
    expect(win.requests).toHaveLength(1);
  });

  it('knows password fields by name, and leaves files out (they go with the submit)', () => {
    expect(['password', 'password_confirmation', 'currentPassword', 'NEW_PASSWORD', 'account.password'].every(isSensitiveField)).toBe(true);
    expect(['name', 'email', 'passport'].some(isSensitiveField)).toBe(false);
    expect(liveValidationData({ avatar: new Blob(['x']), tags: ['a', new Blob(['y'])], at: new Date(0), name: 'Ada' })).toEqual({ tags: ['a'], at: new Date(0), name: 'Ada' });
  });

  it('a 422 gives the errors of the named fields only; anything that is not its answer is an exception, never errors', async () => {
    const { win, live } = setup();
    win.handler = () => invalid('email', { email: ['Taken.'], name: ['Not asked.'] });
    expect(await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).toEqual({ kind: 'invalid', fields: ['email'], errors: { email: ['Taken.'] } });
    // A 422 that is not a live validation's (no x-marmeon-validated — a proxy, an old server): no errors shown.
    win.handler = () => new Response(JSON.stringify({ errors: { email: ['?'] } }), { status: 422, headers: { 'content-type': 'application/json' } });
    expect((await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).kind).toBe('exception');
    win.handler = () => new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/me' } });
    expect(await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).toEqual({ kind: 'exception', exception: { type: 'server', status: 302, message: undefined } });
    for (const status of [403, 419, 429, 500]) {
      win.handler = () => new Response(JSON.stringify({ message: 'no' }), { status, headers: { 'content-type': 'application/json' } });
      expect(await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).toEqual({ kind: 'exception', exception: { type: 'server', status, message: undefined } });
    }
    win.handler = () => Promise.reject(new TypeError('Failed to fetch'));
    expect((await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).kind).toBe('exception');
  });

  it('a 409 (the document changed: signed out) loads fully — like an action', async () => {
    const { win, live } = setup();
    win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
    expect(await live.validate('/register', { method: 'post', data: {}, fields: ['email'] })).toEqual({ kind: 'cancelled' });
    expect(win.loads).toEqual(['assign /login']);
  });

  it('refuses another site (the XSRF token and the data stay here)', async () => {
    const { live } = setup();
    await expect(live.validate('https://evil.test/register', { method: 'post', data: {}, fields: ['email'] })).rejects.toThrow(/to this site/);
  });
});

describe('LiveValidation — one form (E62)', () => {
  function form(options: { on?: 'blur' | 'change'; fields?: string[]; errors?: Record<string, string> } = {}) {
    const { win, live: feature, bodies, record } = setup();
    const data: Record<string, unknown> = { name: '', email: '', password: '' };
    const results: LiveValidationOutcome[] = [];
    const errors = options.errors ?? {};
    const live = feature.form('/register', {
      method: 'post',
      data: () => data,
      onResult: (outcome) => results.push(outcome),
      hasError: (field) => errors[field] !== undefined,
      ...(options.on ? { on: options.on } : {}),
      ...(options.fields ? { fields: options.fields } : {}),
    });
    return { win, live, data, results, bodies, record, errors };
  }

  it('blur: a field is checked when it is left — only once it was changed; each check names every touched field', async () => {
    const { win, live, data, results } = form();
    win.handler = (_url, init) => valid(new Headers(init?.headers as Record<string, string>).get(VALIDATE_HEADER) ?? '');
    live.blurred('name'); // tabbing through: nothing
    await vi.waitFor(() => expect(win.requests).toHaveLength(0));
    data.name = 'Ada';
    live.changed('name');
    live.blurred('name');
    await vi.waitFor(() => expect(results).toHaveLength(1));
    data.email = 'ada@example.com';
    live.changed('email');
    live.blurred('email');
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(win.requests.map((request) => request.headers[VALIDATE_HEADER])).toEqual(['name', 'name,email']);
    // A password field is never touched for live validation.
    live.changed('password');
    expect(live.touched).toEqual(['name', 'email']);
  });

  it('change: checked after a pause in typing — one request for a burst of keys', async () => {
    vi.useFakeTimers();
    const { win, live } = form({ on: 'change' });
    win.handler = () => valid('email');
    for (let i = 0; i < 5; i++) {
      live.changed('email');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(win.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(win.requests).toHaveLength(1);
  });

  it('blur mode: a field showing an error is checked again while it is typed into — so fixing it clears the message', async () => {
    vi.useFakeTimers();
    const { win, live, errors } = form({ errors: { email: 'Taken.' } });
    win.handler = () => valid('email');
    live.changed('email');
    await vi.advanceTimersByTimeAsync(300);
    expect(win.requests).toHaveLength(1);
    delete errors.email;
    live.changed('email');
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toHaveLength(1);
  });

  it('only allowed fields: `fields` limits what is checked', async () => {
    const { win, live } = form({ fields: ['email'] });
    win.handler = () => valid('email');
    live.changed('name');
    live.changed('email');
    await live.validate();
    expect(win.requests.map((request) => request.headers[VALIDATE_HEADER])).toEqual(['email']);
  });

  it('a newer check aborts the one under way; its answer never lands (Gegenprobe: older answer last)', async () => {
    const { win, live, results } = form();
    const first = gate<Response>();
    const second = gate<Response>();
    const gates = [first, second];
    let call = 0;
    const signals: AbortSignal[] = [];
    win.handler = (_url, init) =>
      new Promise((resolve, reject) => {
        const mine = gates[call++]!;
        signals.push(init!.signal!);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        void mine.promise.then(resolve);
      });
    live.changed('email');
    const older = live.validate();
    expect(live.validating('email')).toBe(true);
    const newer = live.validate();
    // Aborted on the wire, not just ignored (the server need not answer it).
    expect(signals[0]!.aborted).toBe(true);
    second.open(invalid('email', { email: ['Taken.'] }));
    first.open(valid('email'));
    expect(await older).toEqual({ kind: 'cancelled' });
    expect(await newer).toMatchObject({ kind: 'invalid' });
    expect(results).toEqual([{ kind: 'invalid', fields: ['email'], errors: { email: ['Taken.'] } }]);
    expect(live.validating()).toBe(false);
  });

  it('a field changed while it was checked: its (older) result is not shown, the others are', async () => {
    const { win, live, results } = form();
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    live.changed('name');
    live.changed('email');
    const running = live.validate();
    live.changed('email'); // typed on (blur mode, no error: no new check yet)
    answer.open(invalid('name,email', { name: ['Too short.'], email: ['Taken.'] }));
    await running;
    expect(results).toEqual([{ kind: 'invalid', fields: ['name'], errors: { name: ['Too short.'] } }]);
  });

  it('cancel (the form is sent): what is scheduled or under way never lands; reset forgets the touched fields', async () => {
    vi.useFakeTimers();
    const { win, live, results } = form({ on: 'change' });
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    live.changed('email');
    await vi.advanceTimersByTimeAsync(300);
    expect(live.validating('email')).toBe(true);
    live.cancel();
    expect(live.validating()).toBe(false);
    answer.open(valid('email'));
    await vi.advanceTimersByTimeAsync(10);
    expect(results).toEqual([]);
    live.reset();
    expect(live.touched).toEqual([]);
  });

  it('pending per field, as a snapshot that changes only when the check does', async () => {
    const { win, live } = form();
    const answer = gate<Response>();
    win.handler = () => answer.promise;
    let notified = 0;
    live.subscribe(() => notified++);
    live.changed('name');
    const running = live.validate();
    const pending = live.pending;
    expect(pending).toEqual(['name']);
    expect(live.validating('name')).toBe(true);
    expect(live.validating('email')).toBe(false);
    answer.open(valid('name'));
    await running;
    expect(live.pending).toEqual([]);
    expect(notified).toBe(2);
  });
});

describe('live validation loaded on first use (E74)', () => {
  /** A navigator without the feature, and a form whose live validation loads its code when first used. */
  function lazyForm(load?: () => Promise<never>) {
    const win = new FakeWindow(`${ORIGIN}/register`);
    const { navigator } = boot(win, page('/register', {}, 'auth/Register'));
    const loads: Promise<unknown>[] = [];
    const counted: Pick<typeof navigator, 'load'> = {
      load: (loader) => {
        const loading = navigator.load(load ?? loader);
        loads.push(loading.catch(() => undefined));
        return loading;
      },
    };
    const results: LiveValidationOutcome[] = [];
    const data = { name: 'Ada', email: 'ada@example.com' };
    const live = liveValidationOnFirstUse(counted, '/register', { method: 'post', data: () => data, onResult: (outcome) => results.push(outcome) });
    /** Once the code is there (and what waited for it ran). */
    const loaded = async () => {
      await Promise.all(loads);
      await new Promise((done) => setTimeout(done, 0));
    };
    return { win, navigator, live, loads, loaded, results };
  }

  it('loads its code on the first change — and checks what was touched and left meanwhile, once it is there', async () => {
    const { win, live, loads, loaded, results } = lazyForm();
    win.handler = () => valid('name,email');
    expect(live.pending).toEqual([]);
    live.changed('name');
    live.changed('email');
    live.blurred('email');
    expect(win.requests).toEqual([]); // nothing until the code is there
    await loaded();
    await vi.waitFor(() => expect(results).toEqual([{ kind: 'valid', fields: ['name', 'email'] }]));
    expect(loads).toHaveLength(1); // one load, however much happened meanwhile
    expect(win.requests.map((request) => request.headers[VALIDATE_HEADER])).toEqual(['name,email']);
    // Loaded: every call goes straight to the form's live validation.
    live.blurred('name');
    await vi.waitFor(() => expect(win.requests).toHaveLength(2));
    expect(loads).toHaveLength(1);
  });

  it('a form sent (or gone) before its code arrived asks nothing — `cancel()` forgets what waited', async () => {
    const { win, live, loaded, results } = lazyForm();
    win.handler = () => valid('name');
    live.changed('name');
    live.blurred('name');
    const asked = live.validate();
    live.cancel();
    expect(await asked).toEqual({ kind: 'cancelled' });
    await loaded();
    await new Promise((done) => setTimeout(done, 350)); // past any debounce
    expect(win.requests).toEqual([]);
    expect(results).toEqual([]);
    live.blurred('name'); // not touched since
    live.changed('name');
    live.blurred('name');
    await vi.waitFor(() => expect(win.requests.map((request) => request.headers[VALIDATE_HEADER])).toEqual(['name']));
  });

  it('a chunk that cannot load checks nothing and throws nothing — and is asked for again on the next change', async () => {
    const { win, live, loads } = lazyForm(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    live.changed('email');
    expect(await live.validate()).toEqual({ kind: 'cancelled' });
    expect(win.requests).toEqual([]);
    live.changed('email');
    expect(loads).toHaveLength(2);
  });

  it('is in a chunk of its own: the loader imports the feature module', async () => {
    expect(await loadLiveValidation()).toBe(liveValidation);
  });
});
