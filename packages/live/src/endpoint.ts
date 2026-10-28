import type { HttpContext, LiveAudience, LiveAuthorizer } from '@marmeon/http';
import { isLiveChannel, LIVE_VERSION } from '@marmeon/http/internal';
import type { Logger, Redactor } from '@marmeon/core';
import { CONNECTION_ID } from './broadcaster.ts';
import { END_FRAME, STREAM_HEADERS, type LiveHub } from './hub.ts';
import { monotonicNow } from './monotonic.ts';
import type { LiveTokens } from './signer.ts';

/** A refusal as plain text — never an error page: `EventSource` reads nothing of it, and it costs no render. */
const refuse = (status: number, message: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** The answer to a stream of another protocol version: nothing, so the browser stops its own reconnecting (the tab still asks again later). */
const unversioned = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

/** When a failed sign-in check was last logged. Per process, not per controller: the controller is built per request, and every reconnecting tab would log. */
let lastCheckLog = 0;

/** The same for a failed channel authorization, on a mark of its own. */
let lastAuthorizeLog = 0;

/** The answer to a check that could not be made: no stream — the client tries again later, as for any 503. */
function unavailable(): Response {
  const response = refuse(503, 'Try again later.');
  response.headers.set('retry-after', '5');
  return response;
}

/** The answer to a stream whose sign-in is over: only `end` — the client stops and does not reconnect. */
const ended = () => new Response(END_FRAME, { status: 200, headers: STREAM_HEADERS });

/**
 * `GET /_marmeon/live?v=1&connection=<id>&c=<token>.<channel>&…` — a tab's stream: every channel its page, islands and layers
 * follow, each with the token the page was signed with. A request whose `v` is not exactly one `1` gets `204` before anything
 * else is read: no token is looked at, no stream opens, and the browser stops reconnecting by itself (the tab asks again every 30 s until its next visit reloads it). Runs in the `web` group, read-only (on its path the kernel never
 * saves the session or sets a cookie): the session is read only to know whose stream it is. One invalid token — a channel
 * rewritten, a token of another session or of one that ended — and there is no stream (403). The hub counts what is open:
 * 429 beyond the session's streams, 503 beyond the process's or while the server closes. With a {@link LiveAudience} bound
 * (`@marmeon/auth`) the sign-in is checked as well: one that ended gets `end` only, never a stream. With {@link LiveAuthorizer}s
 * listed by the modules, every channel is asked at this connection: the ones not every authorizer allows are left out, none left is a 403.
 */
export class LiveStreamController {
  readonly #hub: LiveHub;
  readonly #tokens: LiveTokens;
  readonly #maxChannels: number;
  readonly #scope: () => string | undefined;
  readonly #audience: LiveAudience | undefined;
  readonly #logger: Logger | undefined;
  readonly #redactor: Redactor;
  readonly #authorizers: () => readonly LiveAuthorizer[];

  constructor(hub: LiveHub, tokens: LiveTokens, maxChannels: number, scope: () => string | undefined, audience: LiveAudience | undefined, logger: Logger | undefined, redactor: Redactor, authorizers: () => readonly LiveAuthorizer[] = () => []) {
    this.#hub = hub;
    this.#tokens = tokens;
    this.#maxChannels = maxChannels;
    this.#scope = scope;
    this.#audience = audience;
    this.#logger = logger;
    this.#redactor = redactor;
    this.#authorizers = authorizers;
  }

  async handle(ctx: HttpContext): Promise<Response> {
    const query = new URL(ctx.request.url).searchParams;
    const versions = query.getAll('v');
    if (versions.length !== 1 || versions[0] !== LIVE_VERSION) return unversioned();
    const connection = query.get('connection') ?? '';
    if (!CONNECTION_ID.test(connection)) return refuse(400, 'A live stream names its connection: ?connection=<id>.');
    const given = query.getAll('c');
    if (given.length === 0 || given.length > this.#maxChannels) return refuse(400, `A live stream follows 1 to ${this.#maxChannels} channels (?c=<token>.<channel>).`);
    const scope = this.#scope();
    if (scope === undefined) return refuse(401, 'A live stream belongs to a session.');
    const channels = new Set<string>();
    for (const pair of given) {
      const dot = pair.indexOf('.');
      const token = pair.slice(0, dot);
      const channel = pair.slice(dot + 1);
      // Signed for this session — a rewritten channel, another session's token or an ended one: no stream at all.
      if (dot < 1 || !isLiveChannel(channel) || !this.#tokens.verify(scope, channel, token)) return refuse(403, 'Not allowed to follow these channels.');
      channels.add(channel);
    }
    // After the tokens, so a forged request learns nothing of the sign-in; before the hub, so an ended one holds no place in it.
    // Before the sign-in is asked: an end that arrives after this moment is one the answer may not know of (the hub checks).
    const checkedAt = monotonicNow();
    let accounts: string[] | undefined;
    if (this.#audience) {
      try {
        const who = await this.#audience.check();
        if (who.kind === 'ended') return ended();
        if (who.kind === 'account') accounts = this.#tokens.accountScopes(who.scope);
      } catch (error) {
        // The sign-in cannot be told (the database is down): no stream — the client tries again later, as for any 503.
        // Logged at most once a minute: every reconnecting tab would otherwise repeat it.
        if (Date.now() - lastCheckLog >= 60_000) {
          lastCheckLog = Date.now();
          this.#logger?.error('A live stream could not check its sign-in; refused with 503', { exception: this.#redactor.text(String(error)) });
        }
        return unavailable();
      }
    }
    // After the tokens and the sign-in; fail-closed: only `true` keeps a channel, a throw is no stream. In order, one at a time.
    let followed = [...channels];
    let asked = false;
    {
      try {
        // Built here, not with the controller: a class that cannot be built is a 503 of this check, and a forged request never builds one.
        const authorizers = this.#authorizers();
        asked = authorizers.length > 0;
        const allowed: string[] = [];
        for (const channel of followed) {
          let keep = true;
          // Every authorizer, in order; the first to say anything but `true` ends the question.
          for (const authorizer of authorizers) if (keep && (await authorizer.allows(channel, ctx)) !== true) keep = false;
          if (keep) allowed.push(channel);
        }
        followed = allowed;
      } catch (error) {
        if (Date.now() - lastAuthorizeLog >= 60_000) {
          lastAuthorizeLog = Date.now();
          this.#logger?.error('A live stream could not authorize its channels; refused with 503', { exception: this.#redactor.text(String(error)) });
        }
        return unavailable();
      }
      if (asked && followed.length === 0) return refuse(403, 'Not allowed to follow these channels.');
    }
    // The hub counts the streams of the process and of the session itself (503, 429) — atomically, in `open()`.
    return this.#hub.open({ channels: followed, scope, accounts, checkedAt, connection, lastEventId: ctx.request.headers.get('last-event-id'), signal: ctx.request.signal });
  }
}
