import * as fetch from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { describe, expect, it } from 'vitest';
import type { JobContext } from '@marmeon/queue';
import { compose, MailDeliveryError } from '../mailer.ts';
import { SendQueuedMail, toQueued } from '../queued.ts';
import type { MailMessage } from '../message.ts';
import { ResendTransport } from './resend.ts';

// Built at run time: a key-shaped literal in a test file blocks the push.
const KEY = ['re', 'test', 'key', '0123456789'].join('_');
const ENDPOINT = 'https://api.resend.com/emails';
const NOW = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  from: { address: 'team@app.test', name: 'The Team' },
  to: [{ address: 'ada@example.com', name: 'Ada Lovelace' }],
  cc: [],
  bcc: [],
  subject: 'Welcome',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
  headers: {},
  ...overrides,
});

const setup = () => {
  const http = new HttpClientFake();
  const transport = new ResendTransport({ apiKey: KEY, http: () => http, fetch, clock: { now: () => NOW } });
  return { http, transport };
};

const failure = async (promise: Promise<unknown>): Promise<MailDeliveryError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MailDeliveryError);
  return error as MailDeliveryError;
};

describe('ResendTransport', () => {
  it('posts the mail to the fixed address with the bearer key and returns Resend\'s id', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const receipt = await transport.send(
      message({
        cc: [{ address: 'cc@example.com' }],
        bcc: [{ address: 'bcc@example.com' }],
        replyTo: { address: 'help@app.test', name: 'Help' },
        headers: { 'List-Unsubscribe': '<https://app.test/u/1>' },
      }),
    );
    expect(receipt).toEqual({ messageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    expect(http.requests).toHaveLength(1);
    const request = http.requests[0]!;
    expect(request.url).toBe(ENDPOINT);
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(request.headers.get('accept')).toBe('application/json');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.clone().json()).toEqual({
      from: '"The Team" <team@app.test>',
      to: ['"Ada Lovelace" <ada@example.com>'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      reply_to: '"Help" <help@app.test>',
      subject: 'Welcome',
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: { 'List-Unsubscribe': '<https://app.test/u/1>' },
    });
  });

  it('puts every recipient into its own array entry, a hostile name quoted', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    await transport.send(message({ to: [{ address: 'ada@example.com', name: 'Evil, x@attacker.example' }, { address: 'bob@example.com' }] }));
    const body = (await http.requests[0]!.clone().json()) as { to: string[] };
    expect(body.to).toEqual(['"Evil, x@attacker.example" <ada@example.com>', 'bob@example.com']);
  });

  it('quotes a hostile display name in To, Cc and Bcc, and in the sender', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    await transport.send(
      message({
        from: { address: 'team@app.test', name: 'Evil, x@attacker.example' },
        cc: [{ address: 'cc@example.com', name: 'Evil, x@attacker.example' }],
        bcc: [{ address: 'bcc@example.com', name: 'A "B" \\ C' }, { address: 'bcc2@example.com' }],
      }),
    );
    expect(await http.requests[0]!.clone().json()).toEqual({
      from: '"Evil, x@attacker.example" <team@app.test>',
      to: ['"Ada Lovelace" <ada@example.com>'],
      cc: ['"Evil, x@attacker.example" <cc@example.com>'],
      bcc: ['"A \\"B\\" \\\\ C" <bcc@example.com>', 'bcc2@example.com'],
      subject: 'Welcome',
      html: '<p>Hello</p>',
      text: 'Hello',
    });
  });

  it('asks the client for a 15 second limit and no redirect, and leaves its size limit out of the way', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, Response.json({ id: 'id-1' }));
    const seen: Record<string, unknown>[] = [];
    const client = { fetch: (url: string, options: Record<string, unknown>) => (seen.push(options), http.fetch(url, options as never)) };
    const transport = new ResendTransport({ apiKey: KEY, http: () => client as never, fetch, clock: { now: () => NOW } });
    await transport.send(message());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', timeout: 15, maxResponseBytes: Number.MAX_SAFE_INTEGER, redirect: 'error' });
  });

  it('sends an attachment as base64, with its content type only when it has one', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    await transport.send(
      message({
        attachments: [
          { filename: 'a.txt', content: 'héllo' },
          { filename: 'b.bin', content: new Uint8Array([0, 1, 255]), contentType: 'image/png' },
        ],
      }),
    );
    const body = (await http.requests[0]!.clone().json()) as { attachments: unknown };
    expect(body.attachments).toEqual([
      { filename: 'a.txt', content: Buffer.from('héllo').toString('base64') },
      { filename: 'b.bin', content: 'AAH/', content_type: 'image/png' },
    ]);
  });

  it('sends the idempotency key as Idempotency-Key, and no such header without one', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    await transport.send(message(), { idempotencyKey: 'marmeon-mail-job-1' });
    expect(http.requests[0]!.headers.get('idempotency-key')).toBe('marmeon-mail-job-1');
    await transport.send(message(), {});
    await transport.send(message());
    expect(http.requests[1]!.headers.has('idempotency-key')).toBe(false);
    expect(http.requests[2]!.headers.has('idempotency-key')).toBe(false);
    expect([...http.requests[1]!.headers.keys()].sort()).toEqual(['accept', 'authorization', 'content-type']);
  });

  it('refuses an idempotency key Resend cannot take before any request, without naming it', async () => {
    for (const key of ['', 'a\r\nBcc: x@attacker.example', 'schlüssel', 'k'.repeat(257), 'with space']) {
      const { http, transport } = setup();
      const error = await failure(transport.send(message(), { idempotencyKey: key }));
      expect(error.reason, JSON.stringify(key)).toBe('refused');
      expect(error.message).not.toContain('attacker');
      http.assertNothingSent();
    }
  });

  it('refuses an idempotency key that is no string, as a JS caller can pass it', async () => {
    for (const key of [null, 1, false, {}]) {
      const { http, transport } = setup();
      const error = await failure(transport.send(message(), { idempotencyKey: key as never }));
      expect(error.reason, String(key)).toBe('refused');
      http.assertNothingSent();
    }
  });

  it('sends a key of 256 characters and one of punctuation as given', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    await transport.send(message(), { idempotencyKey: 'k'.repeat(256) });
    await transport.send(message(), { idempotencyKey: 'a~!' });
    expect(http.requests.map((request) => request.headers.get('idempotency-key'))).toEqual(['k'.repeat(256), 'a~!']);
  });

  it('hands the signal to the request: an aborted one is a retryable failure', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    const error = await failure(transport.send(message(), { signal: AbortSignal.abort() }));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toContain('aborted');
  });

  it('a 401 is unauthorized and permanent, and the key is nowhere in the error', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ statusCode: 401, name: 'validation_error', message: `API key is invalid: ${KEY}` }, { status: 401 }));
    const error = await failure(transport.send(message()));
    expect(error.reason).toBe('unauthorized');
    expect(error.permanent).toBe(true);
    expect(error.status).toBe(401);
    expect(error.providerCode).toBe('validation_error');
    expect(error.message).toContain('MAIL_RESEND_API_KEY');
    for (const text of [error.message, String(error), error.stack ?? '', JSON.stringify(error)]) expect(text).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it('a 422 is rejected with the error name, and the provider\'s text stays out of the message', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ statusCode: 422, name: 'invalid_to_address', message: 'Invalid `to` field: ada@example.com' }, { status: 422 }));
    const error = await failure(transport.send(message()));
    expect(error.reason).toBe('rejected');
    expect(error.permanent).toBe(true);
    expect(error.providerCode).toBe('invalid_to_address');
    expect(error.message).toBe('The mail was not delivered: resend answered 422 (invalid_to_address).');
    expect(error.message).not.toContain('ada@example.com');
  });

  it('keeps only a plain lower-case name as the provider code', async () => {
    for (const name of ['Validation Error', 'x'.repeat(100), 'a-b', 42, null, '']) {
      const { http, transport } = setup();
      http.respond(ENDPOINT, Response.json({ name }, { status: 422 }));
      expect((await failure(transport.send(message()))).providerCode, String(name)).toBeUndefined();
    }
  });

  it('a 429 is throttled and carries Retry-After', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '12' } }));
    const error = await failure(transport.send(message()));
    expect(error.reason).toBe('throttled');
    expect(error.permanent).toBe(false);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.providerCode).toBe('rate_limit_exceeded');
  });

  it('a 503 is unavailable and honours Retry-After as a date, a 500 does not', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, new Response('down', { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:30 GMT' } }));
    const unavailable = await failure(transport.send(message()));
    expect(unavailable.reason).toBe('unavailable');
    expect(unavailable.retryAfterSeconds).toBe(30);
    http.respond(ENDPOINT, new Response('down', { status: 500, headers: { 'retry-after': '30' } }));
    const broken = await failure(transport.send(message()));
    expect(broken.reason).toBe('unavailable');
    expect(broken.retryAfterSeconds).toBeUndefined();
  });

  it('a 409 for a request that is still in flight is unavailable and retryable', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ statusCode: 409, name: 'concurrent_idempotent_requests' }, { status: 409 }));
    const error = await failure(transport.send(message(), { idempotencyKey: 'key-1' }));
    expect(error.reason).toBe('unavailable');
    expect(error.permanent).toBe(false);
    expect(error.providerCode).toBe('concurrent_idempotent_requests');
  });

  it('a 409 for the same key with another mail is rejected: no retry can change it', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ statusCode: 409, name: 'invalid_idempotent_request' }, { status: 409, headers: { 'retry-after': '5' } }));
    const error = await failure(transport.send(message(), { idempotencyKey: 'key-1' }));
    expect(error.reason).toBe('rejected');
    expect(error.permanent).toBe(true);
    expect(error.providerCode).toBe('invalid_idempotent_request');
  });

  it('maps the other statuses: 408/425 unavailable, 400 and 404 rejected', async () => {
    const expected: [number, string][] = [[408, 'unavailable'], [425, 'unavailable'], [400, 'rejected'], [404, 'rejected']];
    for (const [status, reason] of expected) {
      const { http, transport } = setup();
      http.respond(ENDPOINT, new Response('', { status }));
      expect((await failure(transport.send(message()))).reason, String(status)).toBe(reason);
    }
  });

  it('a 401 or 403 is unauthorized only with the provider\'s own error code: a proxy\'s answer is unavailable and retried', async () => {
    for (const status of [401, 403]) {
      const coded = setup();
      coded.http.respond(ENDPOINT, Response.json({ name: 'validation_error' }, { status }));
      expect((await failure(coded.transport.send(message()))).reason, `${status} with a code`).toBe('unauthorized');
      for (const answer of [new Response('<html>Forbidden</html>', { status }), new Response('', { status }), Response.json({ message: 'blocked' }, { status })]) {
        const plain = setup();
        plain.http.respond(ENDPOINT, answer);
        const error = await failure(plain.transport.send(message()));
        expect(error.reason, `${status} without a code`).toBe('unavailable');
        expect(error.permanent).toBe(false);
      }
    }
  });

  // The real client throws `too-large` before the status is known when the answer declares more than `maxResponseBytes`.
  const strictClient = (http: HttpClientFake) => ({
    fetch: async (url: string, options: { maxResponseBytes?: number }) => {
      const response = await http.fetch(url, options as never);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > (options.maxResponseBytes ?? 5 * 1024 * 1024)) throw new fetch.FetchError('too-large', 'The response is larger than maxResponseBytes.');
      return response;
    },
  });
  const withClient = (http: HttpClientFake) => new ResendTransport({ apiKey: KEY, http: () => strictClient(http) as never, fetch, clock: { now: () => NOW } });

  it('keeps the status of an answer that declares 70 KiB: an accepted mail is not a retry', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, new Response('x'.repeat(100), { status: 200, headers: { 'content-length': '71680' } }));
    expect(await withClient(http).send(message())).toEqual({ messageId: undefined });
  });

  it('reads a body of more than 64 KiB as no body, and keeps the status', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, new Response('x'.repeat(70 * 1024), { status: 200 }));
    expect(await withClient(http).send(message())).toEqual({ messageId: undefined });
  });

  it('keeps the reason and Retry-After of a throttled answer with a large body', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, new Response('x'.repeat(100), { status: 429, headers: { 'content-length': '71680', 'retry-after': '12' } }));
    const error = await failure(withClient(http).send(message()));
    expect(error.reason).toBe('throttled');
    expect(error.retryAfterSeconds).toBe(12);
  });

  it('keeps a 403 with a large body unavailable when it has no provider code', async () => {
    const http = new HttpClientFake().respond(ENDPOINT, new Response('x'.repeat(100), { status: 403, headers: { 'content-length': '71680' } }));
    expect((await failure(withClient(http).send(message()))).reason).toBe('unavailable');
  });

  it('sends nothing when the host resolves to a private address, and the failure is retryable', async () => {
    const { http, transport } = setup();
    http.dns('api.resend.com', ['10.0.0.5']);
    const error = await failure(transport.send(message()));
    // the address policy answers for the DNS of this moment, so the next try checks again
    expect(error.reason).toBe('unavailable');
    expect(error.permanent).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain('refused by the HTTP client');
    expect(error.message).not.toContain('10.0.0.5');
    http.assertNothingSent();
  });

  it('does not follow a redirect to another host: one request, and the key goes nowhere else', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, new Response(null, { status: 307, headers: { location: 'https://evil.example/collect' } }));
    http.respond('https://evil.example/collect', Response.json({ id: 'x' }));
    const error = await failure(transport.send(message()));
    expect(error.reason).toBe('rejected');
    http.assertSentCount(1);
    expect(http.requests.map((request) => new URL(request.url).host)).toEqual(['api.resend.com']);
  });

  it('a request that times out is unavailable, with no cause', async () => {
    const { http, transport } = setup();
    http.failNext('timeout');
    const error = await failure(transport.send(message()));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toContain('timed out');
    expect(error.cause).toBeUndefined();
  });

  it('an error that is no FetchError of the loaded module is unavailable, and its text stays out', async () => {
    const broken = new ResendTransport({
      apiKey: KEY,
      http: () => ({ fetch: () => Promise.reject(new Error(`socket to ${KEY} failed`)) }) as never,
      fetch,
      clock: { now: () => NOW },
    });
    const error = await failure(broken.send(message()));
    expect(error.reason).toBe('unavailable');
    expect(String(error)).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it('a 200 whose body is not JSON resolves with no message id and never throws: the mail is with Resend', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, new Response('not json', { status: 200 }));
    expect(await transport.send(message())).toEqual({ messageId: undefined });
    http.respond(ENDPOINT, Response.json({ id: 'has space' }));
    expect(await transport.send(message())).toEqual({ messageId: undefined });
    http.respond(ENDPOINT, Response.json([1, 2]));
    expect(await transport.send(message())).toEqual({ messageId: undefined });
  });

  it('refuses an attachment whose filename or content type is not a single line, before any request', async () => {
    const hostile: Partial<MailMessage>[] = [
      { attachments: [{ filename: 'a.txt', content: 'x', contentType: 'text/plain\r\nBcc: x@attacker.example' }] },
      { attachments: [{ filename: 'a\n.txt', content: 'x' }] },
      { attachments: [{ filename: 'a.txt\r', content: 'x' }] },
      { attachments: [{ filename: null as never, content: 'x' }] },
      { attachments: [{ filename: 'a.txt', content: 'x', contentType: 5 as never }] },
    ];
    for (const overrides of hostile) {
      const { http, transport } = setup();
      const error = await failure(transport.send(message(overrides)));
      expect(error.reason).toBe('refused');
      expect(error.message).not.toContain('attacker');
      http.assertNothingSent();
    }
  });

  it('refuses a subject with a line break, or no string, before any request', async () => {
    for (const subject of ['Hi\r\nBcc: x@attacker.example', 'Hi\n', 5 as never, null as never]) {
      const { http, transport } = setup();
      const error = await failure(transport.send(message({ subject })));
      expect(error.reason).toBe('refused');
      expect(error.message).not.toContain('attacker');
      http.assertNothingSent();
    }
  });

  it('refuses a Bcc header of the envelope before any request', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    const error = await failure(transport.send(message({ headers: { Bcc: 'x@attacker.example' } })));
    expect(error.reason).toBe('refused');
    expect(error.message).toContain('"Bcc"');
    expect(error.message).toContain('resend driver');
    http.assertNothingSent();
  });
});

describe('ResendTransport in the queued mail job', () => {
  const context = (attempt = 1) => {
    const calls = { released: [] as number[], failed: [] as unknown[] };
    const job = {
      id: 'job-1',
      name: 'marmeon.mail',
      attempt,
      tries: 5,
      queue: 'default',
      connection: 'database',
      signal: new AbortController().signal,
      discard: () => undefined,
      release: (delay: number) => void calls.released.push(delay),
      fail: (reason: unknown) => void calls.failed.push(reason),
      once: async () => true,
    } as unknown as JobContext;
    return { job, calls };
  };
  const payload = async () => ({
    mailable: 'PingMail',
    message: toQueued(await compose({ envelope: () => ({ to: 'ada@example.com', subject: 'Ping' }), content: () => ({ html: '<p>Ping</p>', text: 'Ping' }) }, 'team@app.test')),
  });

  it('fails the job at once after one request when Resend refuses the key', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ name: 'validation_error', message: `Bad key ${KEY}` }, { status: 401 }));
    const { job, calls } = context();
    await new SendQueuedMail(transport).handle(await payload(), job);
    http.assertSentCount(1);
    expect(calls.released).toEqual([]);
    expect(calls.failed).toHaveLength(1);
    expect((calls.failed[0] as MailDeliveryError).reason).toBe('unauthorized');
  });

  it('releases the job for the seconds of Retry-After when Resend throttles', async () => {
    const { http, transport } = setup();
    http.respond(ENDPOINT, Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '12' } }));
    const { job, calls } = context();
    await new SendQueuedMail(transport).handle(await payload(), job);
    http.assertSentCount(1);
    expect(calls).toEqual({ released: [12], failed: [] });
  });

  it('retries a mail that timed out with the identical Idempotency-Key, so Resend can deduplicate it', async () => {
    const { http, transport } = setup();
    http.failNext('timeout');
    http.respond(ENDPOINT, Response.json({ id: 'id-1' }));
    const handler = new SendQueuedMail(transport);
    const first = context(1);
    await expect(handler.handle(await payload(), first.job)).rejects.toBeInstanceOf(MailDeliveryError);
    expect(first.calls).toEqual({ released: [], failed: [] });
    await handler.handle(await payload(), context(2).job);
    http.assertSentCount(2);
    const keys = http.requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual(['marmeon-mail-job-1', 'marmeon-mail-job-1']);
  });
});

