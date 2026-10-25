import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { TestClock } from '@marmeon/core/testing';
import { HttpError, Router } from '@marmeon/router';
import { createRequestState } from '@marmeon/router/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRoutes } from './test-helpers/open-routes.ts';
import { isWebhookMiddleware, signWebhook, verifyWebhook, Webhooks } from './webhooks.ts';

// Token-shaped values are put together at run time: no literal in the source looks like a real secret.
const prefixed = (bytes: string) => ['whsec', Buffer.from(bytes).toString('base64')].join('_');
const STANDARD = prefixed('a'.repeat(32));
const STANDARD_OLD = prefixed('b'.repeat(32));
const OTHER = prefixed('c'.repeat(32));
const PLAIN = ['sk', 'x'.repeat(24)].join('_');
const PLAIN_OTHER = ['sk', 'y'.repeat(24)].join('_');
const BODY = JSON.stringify({ type: 'invoice.paid', amount: 1200 });

const clock = new TestClock();
clock.freeze();
const seconds = () => Math.floor(clock.now() / 1000);

// The signatures below are made by hand, not by the helper under test.
const keyOf = (secret: string) => Buffer.from(secret.slice('whsec_'.length), 'base64');
const hmac = (key: Buffer | string, content: string) => createHmac('sha256', key).update(content);
const standard = (secret: string, body: string, id = 'msg_1', timestamp: string | number = seconds()) => ({
  'webhook-id': id,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': `v1,${hmac(keyOf(secret), `${id}.${timestamp}.${body}`).digest('base64')}`,
});
const stripe = (secret: string, body: string, timestamp: string | number = seconds()) => ({
  'stripe-signature': `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`).digest('hex')}`,
});
const github = (secret: string, body: string) => ({
  'x-hub-signature-256': `sha256=${hmac(secret, body).digest('hex')}`,
  'x-github-delivery': 'delivery-1',
});

const webhooks = new Webhooks()
  .define('standard', { scheme: 'standard', secrets: STANDARD })
  .define('rotating', { scheme: 'standard', secrets: [STANDARD, STANDARD_OLD] })
  .define('stripe', { scheme: 'stripe', secrets: PLAIN })
  .define('github', { scheme: 'github', secrets: [PLAIN, PLAIN_OTHER] })
  .define('short', { scheme: 'standard', secrets: STANDARD, tolerance: { seconds: 10 } });

const resolve = (Class: unknown) => new (Class as new (...args: unknown[]) => never)(webhooks, clock);

const router = new Router({ resolve }).load(
  openRoutes((Route) => {
    for (const name of ['standard', 'rotating', 'stripe', 'github', 'short']) {
      Route.middleware(verifyWebhook(name)).post(`/hooks/${name}`, async (ctx) => ({
        webhook: { id: ctx.webhook.id, timestamp: ctx.webhook.timestamp?.getTime() ?? null, body: ctx.webhook.body },
        input: await ctx.input(),
      }));
    }
  }),
);

async function send(name: string, body: string, headers: Record<string, string>, { maxBodyBytes }: { maxBodyBytes?: number } = {}) {
  const request = new Request(`http://app.test/hooks/${name}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  const route = router.routes.find((candidate) => candidate.path === `/hooks/${name}`)!;
  try {
    const response = await router.dispatch(route, { request, params: {} }, { state: createRequestState(request, maxBodyBytes === undefined ? {} : { maxBodyBytes }) });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, text: error.message };
    throw error;
  }
}

const REFUSED = { status: 401, text: JSON.stringify({ error: 'webhook_signature_invalid' }) };

afterEach(() => vi.restoreAllMocks());

describe('verifyWebhook — a signature that holds', () => {
  it('passes the Standard Webhooks format and hands the app the id, the time and the body', async () => {
    const response = await send('standard', BODY, standard(STANDARD, BODY, 'msg_7'));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      webhook: { id: 'msg_7', timestamp: seconds() * 1000, body: BODY },
      input: { type: 'invoice.paid', amount: 1200 },
    });
  });

  it('passes the Stripe-Signature format, with no id', async () => {
    const response = await send('stripe', BODY, stripe(PLAIN, BODY));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).webhook).toEqual({ timestamp: seconds() * 1000, body: BODY });
  });

  it('passes the X-Hub-Signature-256 format, with the delivery id and no time', async () => {
    const response = await send('github', BODY, github(PLAIN, BODY));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).webhook).toEqual({ id: 'delivery-1', timestamp: null, body: BODY });
  });

  it('accepts a signature made by any of several secrets (rotation), and refuses one made by none', async () => {
    expect((await send('rotating', BODY, standard(STANDARD, BODY))).status).toBe(200);
    expect((await send('rotating', BODY, standard(STANDARD_OLD, BODY))).status).toBe(200);
    expect(await send('rotating', BODY, standard(OTHER, BODY))).toEqual(REFUSED);
    expect((await send('github', BODY, github(PLAIN_OTHER, BODY))).status).toBe(200);
  });

  it('accepts any entry of a signature header that lists several (an old secret next to the new one)', async () => {
    const valid = standard(STANDARD, BODY);
    const old = standard(STANDARD_OLD, BODY)['webhook-signature'];
    expect((await send('standard', BODY, { ...valid, 'webhook-signature': `${old} ${valid['webhook-signature']}` })).status).toBe(200);
    expect((await send('standard', BODY, { ...valid, 'webhook-signature': `v2,AAAA ${valid['webhook-signature']}` })).status).toBe(200);
    const sentStripe = stripe(PLAIN, BODY)['stripe-signature'];
    expect((await send('stripe', BODY, { 'stripe-signature': `${sentStripe},v1=${'0'.repeat(64)}` })).status).toBe(200);
  });

  it('parses the body from the very bytes it verified', async () => {
    const parsed = JSON.parse((await send('standard', BODY, standard(STANDARD, BODY))).text);
    expect(parsed.input).toEqual(JSON.parse(parsed.webhook.body));
  });

  it('treats the body as bytes: a multi-byte body verifies', async () => {
    const body = JSON.stringify({ name: 'Zoë — 日本語' });
    expect((await send('standard', body, standard(STANDARD, body))).status).toBe(200);
  });
});

describe('verifyWebhook — forged and changed requests', () => {
  it('refuses a body changed by one byte, for each format', async () => {
    const changed = BODY.replace('1200', '1201');
    expect(await send('standard', changed, standard(STANDARD, BODY))).toEqual(REFUSED);
    expect(await send('stripe', changed, stripe(PLAIN, BODY))).toEqual(REFUSED);
    expect(await send('github', changed, github(PLAIN, BODY))).toEqual(REFUSED);
  });

  it('refuses the signature of another secret', async () => {
    expect(await send('standard', BODY, standard(OTHER, BODY))).toEqual(REFUSED);
    expect(await send('stripe', BODY, stripe(PLAIN_OTHER, BODY))).toEqual(REFUSED);
    expect(await send('github', BODY, github(PLAIN_OTHER.replace('y', 'z'), BODY))).toEqual(REFUSED);
  });

  it('refuses a message whose id or time was changed after it was signed', async () => {
    const signed = standard(STANDARD, BODY, 'msg_1', seconds());
    expect(await send('standard', BODY, { ...signed, 'webhook-id': 'msg_2' })).toEqual(REFUSED);
    expect(await send('standard', BODY, { ...signed, 'webhook-timestamp': String(seconds() + 1) })).toEqual(REFUSED);
    const sent = stripe(PLAIN, BODY, seconds());
    expect(await send('stripe', BODY, { 'stripe-signature': sent['stripe-signature'].replace(`t=${seconds()}`, `t=${seconds() + 1}`) })).toEqual(REFUSED);
  });

  it('refuses a signature of another format', async () => {
    expect(await send('standard', BODY, github(PLAIN, BODY))).toEqual(REFUSED);
    expect(await send('stripe', BODY, standard(STANDARD, BODY))).toEqual(REFUSED);
    expect(await send('github', BODY, { 'x-hub-signature-256': `sha1=${hmac(PLAIN, BODY).digest('hex').slice(0, 40)}` })).toEqual(REFUSED);
    expect(await send('github', BODY, { 'x-hub-signature-256': hmac(PLAIN, BODY).digest('hex') })).toEqual(REFUSED); // no `sha256=`
  });

  it('refuses a request with no signature headers at all', async () => {
    for (const name of ['standard', 'stripe', 'github']) expect(await send(name, BODY, {})).toEqual(REFUSED);
  });

  it('refuses every reason with the same answer, saying nothing of the headers, the body or the secret', async () => {
    const answers = await Promise.all([
      send('standard', BODY, {}),
      send('standard', BODY, standard(OTHER, BODY)),
      send('standard', BODY, standard(STANDARD, BODY, 'msg_1', seconds() - 3600)),
      send('standard', BODY, { ...standard(STANDARD, BODY), 'webhook-timestamp': 'abc' }),
    ]);
    for (const answer of answers) expect(answer).toEqual(REFUSED);
  });
});

describe('verifyWebhook — the time window', () => {
  it('passes a message exactly at the tolerance and refuses one second beyond it — in the past and in the future', async () => {
    for (const offset of [300, -300]) {
      expect((await send('standard', BODY, standard(STANDARD, BODY, 'm', seconds() - offset))).status).toBe(200);
      expect((await send('stripe', BODY, stripe(PLAIN, BODY, seconds() - offset))).status).toBe(200);
    }
    for (const offset of [301, -301]) {
      expect(await send('standard', BODY, standard(STANDARD, BODY, 'm', seconds() - offset))).toEqual(REFUSED);
      expect(await send('stripe', BODY, stripe(PLAIN, BODY, seconds() - offset))).toEqual(REFUSED);
    }
  });

  it('holds a definition to its own tolerance', async () => {
    expect((await send('short', BODY, standard(STANDARD, BODY, 'm', seconds() - 10))).status).toBe(200);
    expect(await send('short', BODY, standard(STANDARD, BODY, 'm', seconds() - 11))).toEqual(REFUSED);
  });

  it('follows the app clock', async () => {
    const headers = standard(STANDARD, BODY);
    expect((await send('standard', BODY, headers)).status).toBe(200);
    clock.travel({ minutes: 6 });
    try {
      expect(await send('standard', BODY, headers)).toEqual(REFUSED);
    } finally {
      clock.travel({ minutes: -6 });
    }
  });

  it('refuses a timestamp that is not a whole number of seconds: fraction, exponent, sign, words, milliseconds, empty', async () => {
    for (const bad of ['1.5', '1e9', '-5', '+5', '0x10', 'now', '', String(clock.now()), '9'.repeat(13)]) {
      expect(await send('standard', BODY, standard(STANDARD, BODY, 'm', bad)), `[${bad}]`).toEqual(REFUSED);
      expect(await send('stripe', BODY, stripe(PLAIN, BODY, bad)), `[${bad}]`).toEqual(REFUSED);
    }
  });

  it('refuses the epoch itself and a negative time, whatever they sign', async () => {
    expect(await send('standard', BODY, standard(STANDARD, BODY, 'm', 0))).toEqual(REFUSED);
    expect(await send('standard', BODY, standard(STANDARD, BODY, 'm', -1))).toEqual(REFUSED);
  });
});

describe('verifyWebhook — odd headers', () => {
  const valid = standard(STANDARD, BODY);

  it('refuses empty headers', async () => {
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      expect(await send('standard', BODY, { ...valid, [name]: '' }), name).toEqual(REFUSED);
    }
    expect(await send('stripe', BODY, { 'stripe-signature': '' })).toEqual(REFUSED);
    expect(await send('github', BODY, { 'x-hub-signature-256': '' })).toEqual(REFUSED);
  });

  it('refuses a header sent twice (a request joins the two with a comma)', async () => {
    const twice = (name: string, value: string, base: Record<string, string> = valid) => {
      const headers = new Headers(base);
      headers.set(name, value);
      headers.append(name, value);
      return Object.fromEntries(headers);
    };
    expect(await send('standard', BODY, twice('webhook-id', 'msg_1'))).toEqual(REFUSED);
    expect(await send('standard', BODY, twice('webhook-timestamp', String(seconds())))).toEqual(REFUSED);
    const signature = valid['webhook-signature'];
    expect(await send('standard', BODY, { ...valid, 'webhook-signature': `${signature}, ${signature}` })).toEqual(REFUSED);
    expect(await send('standard', BODY, twice('webhook-signature', signature))).toEqual(REFUSED);
    expect(await send('stripe', BODY, twice('stripe-signature', stripe(PLAIN, BODY)['stripe-signature'], {}))).toEqual(REFUSED);
    expect(await send('github', BODY, twice('x-hub-signature-256', github(PLAIN, BODY)['x-hub-signature-256'], {}))).toEqual(REFUSED);
  });

  it('refuses a stripe header with two times, none, or an entry out of shape', async () => {
    const v1 = hmac(PLAIN, `${seconds()}.${BODY}`).digest('hex');
    for (const header of [`t=${seconds()},t=${seconds()},v1=${v1}`, `v1=${v1}`, `t=${seconds()}`, `t=${seconds()},v1`, `t=${seconds()},v1=`, `${seconds()},${v1}`]) {
      expect(await send('stripe', BODY, { 'stripe-signature': header }), header).toEqual(REFUSED);
    }
  });

  it('refuses v1 entries of the wrong length or alphabet', async () => {
    const full = valid['webhook-signature'].slice('v1,'.length);
    for (const entry of [`v1,${full.slice(0, -4)}`, `v1,${full}AAAA`, 'v1,', `v1,${full.slice(0, 20)}`, `v1,${'!'.repeat(44)}`, full, `v1 ${full}`]) {
      expect(await send('standard', BODY, { ...valid, 'webhook-signature': entry }), entry).toEqual(REFUSED);
    }
    const hex = hmac(PLAIN, `${seconds()}.${BODY}`).digest('hex');
    for (const entry of [hex.slice(0, 62), `${hex}00`, `${hex.slice(0, 63)}g`, '']) {
      expect(await send('stripe', BODY, { 'stripe-signature': `t=${seconds()},v1=${entry}` }), entry).toEqual(REFUSED);
    }
    const plainHex = hmac(PLAIN, BODY).digest('hex');
    for (const entry of [plainHex.slice(0, 32), `${plainHex}00`, `${plainHex.slice(0, 63)}z`]) {
      expect(await send('github', BODY, { 'x-hub-signature-256': `sha256=${entry}` }), entry).toEqual(REFUSED);
    }
  });

  it('refuses an id with a space or a comma, which only a repeated header or an attack carries', async () => {
    for (const id of ['msg 1', 'a,b', 'x'.repeat(300)]) {
      expect(await send('standard', BODY, standard(STANDARD, BODY, id)), id).toEqual(REFUSED);
    }
  });

  it('does not try an endless list of signatures — not even to find the valid one in it', async () => {
    const entries = Array.from({ length: 500 }, (_, index) => `v1,${Buffer.alloc(32, index).toString('base64')}`);
    expect(await send('standard', BODY, { ...valid, 'webhook-signature': entries.join(' ') })).toEqual(REFUSED);
    expect(await send('standard', BODY, { ...valid, 'webhook-signature': [...entries, valid['webhook-signature']].join(' ') })).toEqual(REFUSED);
  });
});

describe('verifyWebhook — the body', () => {
  it('answers 413 for a body over maxBodyBytes — a valid signature does not lift the limit', async () => {
    const big = JSON.stringify({ filler: 'x'.repeat(2000) });
    expect((await send('standard', big, standard(STANDARD, big), { maxBodyBytes: 1000 })).status).toBe(413);
    expect((await send('standard', big, standard(STANDARD, big), { maxBodyBytes: 100_000 })).status).toBe(200);
  });

  it('cleans a __proto__ key out of the input as it does for any JSON, though the verified body keeps it', async () => {
    const body = '{"__proto__":{"admin":true},"nested":{"__proto__":{"admin":true},"ok":1}}';
    const response = await send('standard', body, standard(STANDARD, body));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.text);
    expect(parsed.input).toEqual({ nested: { ok: 1 } });
    expect(parsed.webhook.body).toBe(body);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('does not run the route for a refused request', async () => {
    const seen = vi.fn();
    const guarded = new Router({ resolve }).load(openRoutes((Route) => Route.middleware(verifyWebhook('standard')).post('/hooks/x', () => (seen(), null))));
    const request = new Request('http://app.test/hooks/x', { method: 'POST', body: BODY, headers: standard(OTHER, BODY) });
    await guarded.dispatch(guarded.routes[0]!, { request, params: {} }, { state: createRequestState(request) });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('verifyWebhook — nothing sensitive in the logs', () => {
  it('writes no line holding the body, a signature or a secret, for a passed or a refused request', async () => {
    const written: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args) => void written.push(args.map(String).join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));

    const headers = standard(STANDARD, BODY);
    await send('standard', BODY, headers);
    const forged = standard(OTHER, BODY);
    const refused = await send('standard', BODY, forged);
    await send('stripe', BODY, stripe(PLAIN_OTHER, BODY));

    const secrets = [STANDARD, STANDARD_OLD, OTHER, PLAIN, PLAIN_OTHER, STANDARD.slice('whsec_'.length)];
    const everything = [...written, refused.text].join('\n');
    for (const sensitive of [BODY, headers['webhook-signature'], forged['webhook-signature'], ...secrets]) expect(everything).not.toContain(sensitive);
  });
});

describe('Webhooks.define', () => {
  const failing = (definition: Parameters<Webhooks['define']>[1]) => () => new Webhooks().define('x', definition);

  it('refuses a name defined twice, and no secret', () => {
    const known = new Webhooks().define('x', { scheme: 'stripe', secrets: PLAIN });
    expect(() => known.define('x', { scheme: 'stripe', secrets: PLAIN })).toThrow(/\[marmeon:H12\] Webhook \[x\] is defined twice/);
    expect(failing({ scheme: 'stripe', secrets: [] })).toThrow(/\[marmeon:H12\] .*at least one secret/);
  });

  it('refuses a secret that is too short or not of the format, and never prints it', () => {
    expect(failing({ scheme: 'github', secrets: 'z'.repeat(15) })).toThrow(/\[marmeon:H12\]/);
    expect(failing({ scheme: 'stripe', secrets: [PLAIN, ''] })).toThrow(/\[marmeon:H12\]/);
    const notPrefixed = Buffer.from('a'.repeat(32)).toString('base64');
    for (const secret of [notPrefixed, prefixed('a'.repeat(23)), ['whsec', '!!!!'].join('_'), PLAIN]) {
      let message = '';
      try {
        new Webhooks().define('x', { scheme: 'standard', secrets: secret });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/\[marmeon:H12\]/);
      expect(message).not.toContain(secret);
    }
  });

  it('refuses a tolerance beyond 30 minutes, a negative or an unusable one', () => {
    expect(() => new Webhooks().define('x', { scheme: 'github', secrets: PLAIN, tolerance: { minutes: 30 } })).not.toThrow();
    expect(failing({ scheme: 'stripe', secrets: PLAIN, tolerance: { minutes: 30, seconds: 1 } })).toThrow(/\[marmeon:H12\]/);
    expect(failing({ scheme: 'stripe', secrets: PLAIN, tolerance: -1 })).toThrow(/\[marmeon:H12\]/);
    expect(failing({ scheme: 'stripe', secrets: PLAIN, tolerance: Number.NaN })).toThrow(/\[marmeon:H12\]/);
  });

  it('refuses a scheme it does not know', () => {
    expect(failing({ scheme: 'hmac' as never, secrets: PLAIN })).toThrow(/\[marmeon:H12\]/);
  });

  it('keeps the secrets out of what the object shows when it is printed or serialized', () => {
    const known = new Webhooks().define('x', { scheme: 'stripe', secrets: PLAIN });
    expect(JSON.stringify(known)).not.toContain(PLAIN);
    expect(inspect(known, { depth: 5 })).not.toContain(PLAIN);
  });
});

describe('verifyWebhook() as middleware', () => {
  it('carries the mark the CSRF check reads, and only a webhook middleware does', () => {
    expect(isWebhookMiddleware(verifyWebhook('standard'))).toBe(true);
    expect(isWebhookMiddleware(class {} as never)).toBe(false);
    // A subclass may override handle(): it is not the verifying middleware, so it never counts.
    expect(isWebhookMiddleware(class extends (verifyWebhook('standard') as new () => object) {} as never)).toBe(false);
    // Nor does a class that only carries the old marker.
    expect(isWebhookMiddleware(Object.assign(class {}, { [Symbol.for('marmeon.middleware.webhook')]: true }) as never)).toBe(false);
    expect(isWebhookMiddleware({ handle: () => new Response() } as never)).toBe(false);
  });

  it('names an undefined definition at the start with H12 and the way to define it', () => {
    const Class = verifyWebhook('payments') as unknown as Record<symbol, (container: unknown, route: string) => void>;
    const check = Class[Symbol.for('marmeon.middleware.startCheck')]!;
    expect(() => check.call(Class, { make: () => new Webhooks() }, 'POST /hooks')).toThrow(
      /\[marmeon:H12\] Webhook \[payments\] is not defined, but POST \/hooks uses verifyWebhook\('payments'\)\. .*define\('payments'/,
    );
    expect(() => check.call(Class, { make: () => new Webhooks().define('payments', { scheme: 'stripe', secrets: PLAIN }) }, 'POST /hooks')).not.toThrow();
  });

  it('declares itself as protection for marmeon check, as signed() does', () => {
    expect((verifyWebhook('standard') as unknown as { ensures: string[] }).ensures).toEqual(['authenticated']);
  });
});

describe('signWebhook', () => {
  it('makes what the middleware accepts, for each format', async () => {
    const timestamp = new Date(clock.now());
    expect((await send('standard', BODY, signWebhook('standard', STANDARD, BODY, { id: 'msg_9', timestamp }))).status).toBe(200);
    expect((await send('stripe', BODY, signWebhook('stripe', PLAIN, BODY, { timestamp }))).status).toBe(200);
    expect((await send('github', BODY, signWebhook('github', PLAIN, BODY, { id: 'delivery-1' }))).status).toBe(200);
  });

  it('makes the headers a sender would send', () => {
    const timestamp = new Date(seconds() * 1000);
    expect(signWebhook('standard', STANDARD, BODY, { id: 'msg_1', timestamp })).toEqual(standard(STANDARD, BODY, 'msg_1', seconds()));
    expect(signWebhook('stripe', PLAIN, BODY, { timestamp })).toEqual(stripe(PLAIN, BODY, seconds()));
    expect(signWebhook('github', PLAIN, BODY, { id: 'delivery-1' })).toEqual(github(PLAIN, BODY));
  });
});
