import { afterCommit, outsideTransaction, Redactor, token, type Application, type Logger } from '@marmeon/core';
import { channels, messageBase, trace } from '@marmeon/core/diagnostics';
import { checkedChannel } from '@marmeon/http';
import type { LiveBackend } from './backend.ts';
import type { BroadcastRecorder } from './recorder.ts';

/** What a refresh says besides its channel. */
export interface RefreshOptions {
  /**
   * The props that changed — a page following the channel reloads those of them it named (`.live(channel, { only })`), an
   * island or a layer likewise. Default: every prop each one follows.
   */
  readonly only?: readonly string[];
}

/**
 * Hints the browsers on a channel that it changed (W6.10, E89) — injected wherever something changes (a controller, a job, a
 * listener): `await this.#broadcast.refresh(\`users.${user.id}\`, { only: ['profile'] })`.
 *
 * - **A hint, never data** — `{ channel, only, seq }`: each tab reloads through the page's own route, its middleware,
 *   policies and props, as for any partial reload.
 * - **After the commit** (like a dispatched job, E85/E107): inside a transaction it goes out once it committed — a rollback
 *   sends nothing; the other tab never reloads what is not there yet.
 * - **Not to the tab that caused it**: a request's `x-marmeon-connection` (sent by every request of a tab that follows live
 *   hints) — that tab gets the hint with nothing to reload; it shows the change from its own answer.
 */
export interface Broadcaster {
  refresh(channel: string, options?: RefreshOptions): Promise<void>;
}
export const Broadcaster = token<Broadcaster>('Broadcaster');

/** A connection's id as a request names it — anything else is ignored (the hint then goes to every tab). */
export const CONNECTION_ID = /^[\w-]{8,64}$/;

export interface LiveBroadcasterDependencies {
  readonly backend: () => LiveBackend;
  /** The tab that sent the current request (`x-marmeon-connection`) — none outside a request (a job, a command). */
  readonly connection: string | undefined;
  readonly logger: Logger;
  /** Tests: what was refreshed (`app.broadcast`). */
  readonly recorder?: BroadcastRecorder | undefined;
  /** The app its hints are reported for on the `live.refresh` channel (E118). */
  readonly app?: Application | undefined;
  /** Masks a failure's text in the log — the app's, so the names its packages add (the session cookie) count; without one, the core's key list. */
  readonly redactor?: Redactor | undefined;
}

const refreshes = channels.tracing('live.refresh');

export class LiveBroadcaster implements Broadcaster {
  readonly #backend: () => LiveBackend;
  readonly #connection: string | undefined;
  readonly #logger: Logger;
  readonly #recorder: BroadcastRecorder | undefined;
  readonly #app: Application | undefined;
  readonly #redactor: Redactor;

  constructor({ backend, connection, logger, recorder, app, redactor }: LiveBroadcasterDependencies) {
    this.#backend = backend;
    this.#connection = connection !== undefined && CONNECTION_ID.test(connection) ? connection : undefined;
    this.#logger = logger;
    this.#recorder = recorder;
    this.#app = app;
    this.#redactor = redactor ?? new Redactor();
  }

  async refresh(channel: string, options: RefreshOptions = {}): Promise<void> {
    const name = checkedChannel(channel, 'broadcast.refresh()');
    const given = (options as { only?: unknown }).only;
    if (given !== undefined && (!Array.isArray(given) || !given.every((prop) => typeof prop === 'string' && prop !== ''))) {
      throw new TypeError(`broadcast.refresh(${JSON.stringify(name)}): only is a list of prop names, got ${JSON.stringify(given)}.`);
    }
    const only = given === undefined ? null : [...(given as string[])];
    const except = this.#connection;
    // After the commit (E107) — and outside of any transaction: it is no part of one.
    await afterCommit(() =>
      outsideTransaction(async () => {
        this.#recorder?.record({ channel: name, only, connection: except });
        try {
          const send = () => this.#backend().refresh(name, only, except);
          // On the `live.refresh` channel while something listens (E118) — once it goes out, after the commit.
          if (this.#app && refreshes.hasSubscribers) await trace(refreshes, { ...messageBase(this.#app), channel: name, only }, send);
          else await send();
        } catch (error) {
          // The change is committed; its hint is lost — a tab that reconnects later still compares sequences (E104).
          this.#logger.error(`A live hint on "${name}" could not be sent`, { channel: name, exception: this.#redactor.text(String(error)) });
        }
      }),
    );
  }
}
