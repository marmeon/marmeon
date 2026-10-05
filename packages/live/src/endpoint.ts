import { isLiveChannel, type HttpContext } from '@bespokecore/http';
import { CONNECTION_ID } from './broadcaster.ts';
import type { LiveHub } from './hub.ts';
import type { LiveTokens } from './signer.ts';

/** A refusal as plain text — never an error page: `EventSource` reads nothing of it, and it costs no render. */
const refuse = (status: number, message: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * `GET /_bespoke/live?connection=<id>&c=<token>.<channel>&…` — a tab's stream (E89): every channel its page, islands and layers
 * follow, each with the token the page was signed with (E90). Runs in the `web` group, read-only (its path, with or without
 * `Accept: text/event-stream`: the kernel never saves the session, sets no cookie): the session is read only to know whose stream it is. One invalid token — a
 * channel rewritten, a token of another session or of one that ended (signed out) — and there is no stream (403). The hub
 * counts what is open: 429 beyond the session's streams, 503 beyond the process's or while the server closes (W9 step 4).
 */
export class LiveStreamController {
  readonly #hub: LiveHub;
  readonly #tokens: LiveTokens;
  readonly #maxChannels: number;
  readonly #scope: () => string | undefined;

  constructor(hub: LiveHub, tokens: LiveTokens, maxChannels: number, scope: () => string | undefined) {
    this.#hub = hub;
    this.#tokens = tokens;
    this.#maxChannels = maxChannels;
    this.#scope = scope;
  }

  async handle(ctx: HttpContext): Promise<Response> {
    const query = new URL(ctx.request.url).searchParams;
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
      // Signed for this session (E90) — a rewritten channel, another session's token or an ended one: no stream at all.
      if (dot < 1 || !isLiveChannel(channel) || !this.#tokens.verify(scope, channel, token)) return refuse(403, 'Not allowed to follow these channels.');
      channels.add(channel);
    }
    // The hub counts the streams of the process and of the session itself (503, 429) — atomically, in `open()`.
    return this.#hub.open({ channels: [...channels], scope, connection, lastEventId: ctx.request.headers.get('last-event-id'), signal: ctx.request.signal });
  }
}
