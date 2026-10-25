import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Clock, durationToSeconds, type Duration, type Resolver } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { HttpContext, MiddlewareClass, Next } from '@marmeon/router';
import { requestBytes } from '@marmeon/router/internal';

/**
 * How a sender signs its requests: `standard` (the Standard Webhooks headers `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`), `stripe` (`Stripe-Signature: t=…,v1=…`) or `github` (`X-Hub-Signature-256: sha256=…`). All three are
 * HMAC-SHA256. See docs/webhooks.md#the-formats.
 */
export type WebhookScheme = 'standard' | 'stripe' | 'github';

/** How a sender signs and with what: see docs/webhooks.md#defining-a-sender. */
export interface WebhookDefinition {
  readonly scheme: WebhookScheme;
  /**
   * The shared secret as the sender shows it (`whsec_…` for `standard`), from the app's config — never from a route file. Several
   * secrets are tried in turn: the new one and the one being retired while a sender rotates.
   */
  readonly secrets: string | readonly string[];
  /** How far a request's time may be from the clock, either way. Default 5 minutes, at most 30. `github` sends no time. */
  readonly tolerance?: Duration;
}

/** What `verifyWebhook()` adds to the context of a verified request. */
export interface WebhookContext {
  /**
   * The sender's id for this delivery — the same on every retry. Signed for `standard` only; for `github` it is the sender's
   * unsigned `X-GitHub-Delivery` header, which anyone replaying a recorded request can change, and `stripe` has none.
   */
  readonly id: string | undefined;
  /** When the sender signed the request; `undefined` for `github`, which sends no time. */
  readonly timestamp: Date | undefined;
  /** The body exactly as it was verified. */
  readonly body: string;
}

interface CompiledDefinition {
  readonly scheme: WebhookScheme;
  readonly keys: readonly Buffer[];
  readonly toleranceSeconds: number;
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const MAX_TOLERANCE_SECONDS = 30 * 60;
const MIN_PLAIN_SECRET_LENGTH = 16;
const MIN_STANDARD_SECRET_BYTES = 24;
/** A sender lists a handful of signatures while it rotates; more is not a sender. */
const MAX_SIGNATURES = 10;
const SCHEMES: readonly string[] = ['standard', 'stripe', 'github'];

/**
 * The webhook senders an app accepts, by name — define them in a provider's `boot()` and name them on the route with
 * `verifyWebhook()`. A singleton. See docs/webhooks.md#defining-a-sender.
 */
export class Webhooks {
  readonly #definitions = new Map<string, CompiledDefinition>();

  /** Defines the sender `name`; a definition that cannot work (no secret, a secret too short) throws at once, naming the sender but never the secret. */
  define(name: string, definition: WebhookDefinition): this {
    if (this.#definitions.has(name)) throw new TypeError(withCode('H12', `Webhook [${name}] is defined twice.`));
    this.#definitions.set(name, compile(name, definition));
    return this;
  }

  /** @internal */
  definition(name: string): CompiledDefinition | undefined {
    return this.#definitions.get(name);
  }

  /** Whether a sender is defined under `name`. */
  has(name: string): boolean {
    return this.#definitions.has(name);
  }
}

function compile(name: string, { scheme, secrets, tolerance }: WebhookDefinition): CompiledDefinition {
  const invalid = (reason: string) => new TypeError(withCode('H12', `Webhook [${name}]: ${reason}.`));
  if (!SCHEMES.includes(scheme)) throw invalid(`the scheme must be 'standard', 'stripe' or 'github'`);
  const list = typeof secrets === 'string' ? [secrets] : [...secrets];
  if (list.length === 0) throw invalid('needs at least one secret');

  const keys = list.map((secret, index) => {
    if (typeof secret !== 'string') throw invalid(`secret ${index + 1} is not a string`);
    if (scheme === 'standard') {
      const encoded = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret)?.[1];
      const key = encoded === undefined ? undefined : Buffer.from(encoded, 'base64');
      if (key === undefined || key.byteLength < MIN_STANDARD_SECRET_BYTES) {
        throw invalid(`secret ${index + 1} must be 'whsec_' and the base64 of at least ${MIN_STANDARD_SECRET_BYTES} bytes, as the sender shows it`);
      }
      return key;
    }
    if (secret.length < MIN_PLAIN_SECRET_LENGTH) throw invalid(`secret ${index + 1} must have at least ${MIN_PLAIN_SECRET_LENGTH} characters`);
    return Buffer.from(secret, 'utf8');
  });

  let toleranceSeconds = DEFAULT_TOLERANCE_SECONDS;
  if (tolerance !== undefined) {
    try {
      toleranceSeconds = Math.floor(durationToSeconds(tolerance));
    } catch {
      throw invalid('the tolerance is not a span of time');
    }
    if (!(toleranceSeconds >= 1 && toleranceSeconds <= MAX_TOLERANCE_SECONDS)) throw invalid('the tolerance must be between 1 second and 30 minutes');
  }
  return { scheme, keys, toleranceSeconds };
}

/** What a request claims: the bytes that were signed, besides the body — and the signatures it carries. */
interface Claim {
  readonly id: string | undefined;
  /** Whole seconds since the epoch; `undefined` for a scheme without a time. */
  readonly timestamp: number | undefined;
  /** What the signature covers before the body. */
  readonly prefix: string;
  readonly signatures: readonly Buffer[];
}

const ID = /^[!-+\--~]{1,256}$/; // visible ASCII except a comma: a repeated header arrives joined with ", "
const TIMESTAMP = /^\d{1,12}$/;
const BASE64_SIGNATURE = /^v1,([A-Za-z0-9+/]{43}=)$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;
const GITHUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const PAIR = /^[A-Za-z0-9_]+=[A-Za-z0-9]*$/;

function claimOf(scheme: WebhookScheme, headers: Headers): Claim | undefined {
  if (scheme === 'standard') {
    const id = headers.get('webhook-id');
    const timestamp = headers.get('webhook-timestamp');
    const header = headers.get('webhook-signature');
    if (id === null || timestamp === null || header === null || !ID.test(id) || !TIMESTAMP.test(timestamp)) return undefined;
    // A repeated header arrives joined with ", ": a sender writes one header, entries separated by a space.
    if (header.includes(', ')) return undefined;
    const entries = header.split(' ');
    if (entries.length > MAX_SIGNATURES) return undefined;
    const signatures = entries.flatMap((entry) => {
      const encoded = BASE64_SIGNATURE.exec(entry)?.[1];
      return encoded === undefined ? [] : [Buffer.from(encoded, 'base64')];
    });
    return { id, timestamp: Number(timestamp), prefix: `${id}.${timestamp}.`, signatures };
  }

  if (scheme === 'stripe') {
    const header = headers.get('stripe-signature');
    if (header === null) return undefined;
    const pairs = header.split(',');
    if (pairs.length > MAX_SIGNATURES + 1 || !pairs.every((pair) => PAIR.test(pair))) return undefined;
    const times = pairs.filter((pair) => pair.startsWith('t='));
    const time = times[0]?.slice(2);
    if (times.length !== 1 || time === undefined || !TIMESTAMP.test(time)) return undefined;
    const signatures = pairs.flatMap((pair) => {
      const hex = pair.startsWith('v1=') ? pair.slice(3) : '';
      return HEX_SIGNATURE.test(hex) ? [Buffer.from(hex, 'hex')] : [];
    });
    return { id: undefined, timestamp: Number(time), prefix: `${time}.`, signatures };
  }

  const hex = GITHUB_SIGNATURE.exec(headers.get('x-hub-signature-256') ?? '')?.[1];
  if (hex === undefined) return undefined;
  const delivery = headers.get('x-github-delivery');
  return { id: delivery !== null && ID.test(delivery) ? delivery : undefined, timestamp: undefined, prefix: '', signatures: [Buffer.from(hex, 'hex')] };
}

/** Whether any key signed the claim's prefix and the body into any of its signatures — every pair is compared, none stops the others. */
function signedBy(keys: readonly Buffer[], { prefix, signatures }: Claim, body: Uint8Array): boolean {
  let matched = false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(prefix).update(body).digest();
    for (const signature of signatures) {
      if (signature.byteLength === expected.byteLength && timingSafeEqual(expected, signature)) matched = true;
    }
  }
  return matched;
}

/** The classes `verifyWebhook()` made — a set, not a property, so nothing else can claim to be one and a subclass is not one. */
const MADE = new WeakSet<object>();

/** Whether `layer` is a middleware class made by `verifyWebhook()` — the CSRF check skips a route that has one. @internal */
export function isWebhookMiddleware(layer: unknown): boolean {
  return typeof layer === 'function' && MADE.has(layer);
}

/** Same symbol as the server's start check (`Symbol.for`, no export): a class's method under this key runs once when the server starts. */
const START_CHECK = Symbol.for('marmeon.middleware.startCheck');

const REFUSED = () => Response.json({ error: 'webhook_signature_invalid' }, { status: 401 });

/**
 * Middleware that lets only a request signed by the named sender through: `Route.middleware(verifyWebhook('payments')).post('/webhooks/payments', …)`.
 * The sender is defined in a provider's `boot()` — `app.container.make(Webhooks).define('payments', { scheme, secrets })`; one the app
 * never defines stops the start. A missing, malformed or wrong signature, or a time outside the tolerance, answers `401`
 * and the route never runs. The route needs no `csrfExcept`: the signature is its protection. `ctx.webhook` holds the sender's id, the
 * time and the body that was verified; `ctx.input()` parses the same bytes. See docs/webhooks.md#putting-it-on-a-route.
 */
export function verifyWebhook(name: string): MiddlewareClass<{}, { webhook: WebhookContext }> {
  const VerifyWebhook = class {
    /** Read by `marmeon check`: only the holder of the sender's secret gets past. See docs/middleware.md#declaring-what-a-middleware-ensures. */
    static readonly ensures = ['authenticated'] as const;

    /** Asked once when the server starts: the sender must be defined by then. */
    static [START_CHECK](container: Resolver, route: string): void {
      if (container.make(Webhooks).has(name)) return;
      throw new Error(
        withCode('H12', `Webhook [${name}] is not defined, but ${route} uses verifyWebhook('${name}'). Define it in a provider's boot(): app.container.make(Webhooks).define('${name}', { scheme: 'standard', secrets: … }).`),
      );
    }

    readonly #webhooks: Webhooks;
    readonly #clock: Clock;

    constructor(webhooks: Webhooks, clock: Clock) {
      this.#webhooks = webhooks;
      this.#clock = clock;
    }

    async handle(ctx: HttpContext, next: Next<{ webhook: WebhookContext }>): Promise<Response> {
      const definition = this.#webhooks.definition(name);
      if (!definition) throw new Error(withCode('H12', `Webhook [${name}] is not defined. Define it with Webhooks.define('${name}', …).`));

      // The headers and the time first: a request that cannot be right is refused before its body is read.
      const claim = claimOf(definition.scheme, ctx.request.headers);
      if (claim === undefined || claim.signatures.length === 0) return REFUSED();
      if (claim.timestamp !== undefined && Math.abs(Math.floor(this.#clock.now() / 1000) - claim.timestamp) > definition.toleranceSeconds) return REFUSED();

      // The bytes that are checked are the bytes `ctx.input()` parses: the router reads the body once.
      const bytes = await requestBytes(ctx.request);
      if (!signedBy(definition.keys, claim, bytes)) return REFUSED();

      return next({ webhook: { id: claim.id, timestamp: claim.timestamp === undefined ? undefined : new Date(claim.timestamp * 1000), body: new TextDecoder().decode(bytes) } });
    }
  };
  MADE.add(VerifyWebhook);
  // Readable in `route:list` and stack traces.
  Object.defineProperty(VerifyWebhook, 'name', { value: `verifyWebhook:${name}` });
  return VerifyWebhook;
}

/**
 * The headers a sender would send for `body`, signed with `secret` (as the sender shows it) — for tests of a webhook route
 * (`signedWebhook` of `@marmeon/testing`). `timestamp` is now and `id` random unless given; `github` sends no time.
 *
 * @internal
 */
export function signWebhook(scheme: WebhookScheme, secret: string, body: string, { id = randomUUID(), timestamp = new Date() }: { id?: string; timestamp?: Date } = {}): Record<string, string> {
  const seconds = Math.floor(timestamp.getTime() / 1000);
  const sign = (key: Buffer, content: string) => createHmac('sha256', key).update(content);
  if (scheme === 'standard') {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return {
      'webhook-id': id,
      'webhook-timestamp': String(seconds),
      'webhook-signature': `v1,${sign(key, `${id}.${seconds}.${body}`).digest('base64')}`,
    };
  }
  const key = Buffer.from(secret, 'utf8');
  if (scheme === 'stripe') return { 'stripe-signature': `t=${seconds},v1=${sign(key, `${seconds}.${body}`).digest('hex')}` };
  return { 'x-hub-signature-256': `sha256=${sign(key, body).digest('hex')}`, 'x-github-delivery': id };
}
