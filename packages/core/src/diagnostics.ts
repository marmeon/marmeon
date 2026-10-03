/**
 * The framework's observation points (E118): `node:diagnostics_channel` TracingChannels named
 * `tracing:bespoke:<operation>:{start,end,asyncStart,asyncEnd,error}` plus two plain channels, `bespoke:log` and
 * `bespoke:exception`. The error page, the devtools recorder, the debug bar and `@bespokecore/otel` subscribe to them;
 * apps keep using events (job events, scheduler events) for their own reactions.
 *
 * ```ts
 * import { channels } from '@bespokecore/core/diagnostics';
 *
 * const off = channels.subscribe(app, 'db.query', {
 *   end: (query) => console.log(query.sql, query.durationMs, query.requestId ?? query.jobId),
 * });
 * // … in the provider's shutdown(): off();
 * ```
 *
 * - **Without a subscriber nothing is built**: every place that publishes asks `hasSubscribers` first.
 * - **Every message names its app** — two apps in one process (tests, a worker beside a server) never see each other's:
 *   `channels.subscribe(app, …)` passes only `app`'s messages on.
 * - **The channels are the only process-wide part** (they are Node's): a subscription belongs to whoever made it and ends
 *   with `off()` — a provider's `shutdown()`.
 * - **Raw values**: queries carry their parameters, log entries their context, exceptions the error itself. Whatever
 *   records or shows them redacts them first (E125); `QueryMessage.secret` says when a statement touches secret columns.
 */
import { channel as plainChannel, tracingChannel, type TracingChannel } from 'node:diagnostics_channel';
import type { Application } from './application.ts';
import { currentJob, currentRequest, currentTask } from './request-context.ts';

/** What every message carries. */
export interface MessageBase {
  /** The application the message is about — `channels.subscribe(app, …)` passes on only its own. */
  readonly app: Application;
  /** When it started (epoch ms, sub-millisecond: `performance.timeOrigin + performance.now()`). */
  readonly startedAt: number;
  /** The request it happened in (its `x-request-id`), if any. */
  readonly requestId?: string;
  /** The queued job it happened in (the job's id, stable over retries), if any. */
  readonly jobId?: string;
  /** The scheduled task it happened in, if any. */
  readonly task?: string;
}

/** What a traced operation knows once it ended — set before the `end` (and `error`) handlers run. */
export interface Ended {
  /** How long it took (ms). */
  durationMs?: number;
  /** Why it failed (set by Node's TracingChannel before `error`). */
  error?: unknown;
}

/** `tracing:bespoke:http.request` — one request through the kernel, from the request id to the response's headers. */
export interface HttpRequestMessage extends MessageBase, Ended {
  readonly requestId: string;
  readonly method: string;
  /** The path as requested (no query string). */
  readonly path: string;
  /** `island` or `layer`: a region's request (`x-bespoke-region`). */
  readonly region?: string;
  /** Resolved in-process for another request — an island while its page renders, a layer's base for its deep link (E49, E53). */
  readonly inProcess: boolean;
  /** The matched route's name (`users.show`) — unnamed routes and unknown paths have none. */
  route?: string;
  /** The matched route's pattern (`/users/:user`) — OpenTelemetry's `http.route`. */
  routePath?: string;
  /** The action's class name (`ShowUserController`); none for a closure. */
  controller?: string;
  /** The response's status. */
  status?: number;
}

/** `tracing:bespoke:db.query` — one statement, published once it finished (Kysely reports queries afterwards). */
export interface DbQueryMessage extends MessageBase, Ended {
  /** The connection's name (`default`). */
  readonly connection: string;
  readonly sql: string;
  /** As bound — raw. Redact before recording or showing (E125); with `secret`, all of them. */
  readonly parameters: readonly unknown[];
  /** The statement touches a table with secret columns (`.secret()` in its migration) — its parameters may hold secrets. */
  readonly secret: boolean;
  durationMs: number;
}

/** `tracing:bespoke:queue.dispatch` — one `dispatch()`, `bulk()` or `chain()` of the `Queue`. */
export interface QueueDispatchMessage extends MessageBase, Ended {
  readonly kind: 'dispatch' | 'bulk' | 'chain';
  /** The jobs' names (`static job`), in order. */
  readonly jobs: readonly string[];
  readonly connection: string;
  readonly queue: string;
  /** Seconds before they may run. */
  readonly delay: number;
  /** A unique dispatch's key. */
  readonly unique?: string;
  /** Their ids, once queued — none when a unique job with the key was queued already. */
  jobIds: string[];
  /**
   * The trace context to carry to the worker (W3C `traceparent`) — set by a tracer in its `start` handler
   * (`@bespokecore/otel`); stored with each job and passed on in its `queue.job` message (E131).
   */
  traceparent?: string;
}

/** `tracing:bespoke:queue.job` — one attempt of a job (in a worker, the `sync` connection, or a test's `app.queue.work()`). */
export interface QueueJobMessage extends MessageBase, Ended {
  readonly job: string;
  /** This job's id. */
  readonly jobId: string;
  readonly queue: string;
  readonly connection: string;
  /** From 1. */
  readonly attempt: number;
  /** The request that dispatched it (E131), if one did. */
  readonly originRequestId?: string;
  /** The trace context it was dispatched in (E131), if a tracer gave one. */
  readonly traceparent?: string;
  /** What the job asked for: `done`, or `discarded`/`released`/`failed` through its context; unset when it threw. */
  outcome?: 'done' | 'discarded' | 'released' | 'failed';
}

/** `tracing:bespoke:schedule.task` — one run of a scheduled task. */
export interface ScheduleTaskMessage extends MessageBase, Ended {
  readonly task: string;
  /** The minute it was due (epoch ms). */
  readonly minute: number;
  readonly reason: 'due' | 'catch-up' | 'test';
  outcome?: 'ran' | 'skipped' | 'failed';
  /** Why it was skipped: `filter`, `other-server`, `overlapping`, `job-waiting`. */
  skipped?: string;
}

/** `tracing:bespoke:mail.send` — a mail sent now, queued (composed now, sent by a worker), or sent by that worker. */
export interface MailSendMessage extends MessageBase, Ended {
  /** The mailable's class name. */
  readonly mailable: string;
  /** `send`: `mailer.send()`; `queue`: `mailer.queue()`; `worker`: the queued mail handed to the transport. */
  readonly mode: 'send' | 'queue' | 'worker';
  /** The recipients' addresses, once composed. */
  to?: string[];
  subject?: string;
}

/** `tracing:bespoke:notification.send` — one notification for one recipient: queued (`send`) or delivered (`sendNow`, the worker). */
export interface NotificationSendMessage extends MessageBase, Ended {
  /** `static notification`. */
  readonly notification: string;
  /** The notification's id. */
  readonly id: string;
  readonly recipient: { readonly type: string; readonly id: string | number };
  readonly queued: boolean;
  /** The channels `via()` chose (deliveries only). */
  channels?: string[];
  outcome?: 'delivered' | 'gone' | 'delivered-before';
}

/** `tracing:bespoke:live.refresh` — a live hint going out (after its commit). */
export interface LiveRefreshMessage extends MessageBase, Ended {
  readonly channel: string;
  /** The props it names; `null`: every prop each follower follows. */
  readonly only: readonly string[] | null;
}

/** `tracing:bespoke:render.ssr` — server rendering of a page, until its shell (or, for a bot, the whole page) is ready. */
export interface SsrRenderMessage extends MessageBase, Ended {
  /** The page's view. */
  readonly component: string;
  /** Rendered completely before sending (crawlers), not streamed. */
  readonly complete: boolean;
  /** The document is streamed on (Suspense boundaries after the shell). */
  streamed?: boolean;
}

/** `bespoke:log` — a log entry as written, at any level (the logger's level does not filter it). */
export interface LogMessage extends MessageBase {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  /** The logger's bindings (`{ channel: 'http' }`) and the entry's own context — raw. */
  readonly context: Readonly<Record<string, unknown>>;
}

/** `bespoke:exception` — an error a request ended in, on its way to the `ExceptionHandler`. */
export interface ExceptionMessage extends MessageBase {
  readonly error: unknown;
  /** What the client gets: an `HttpError`'s status, 422 for invalid input, else 500. */
  readonly status: number;
  readonly method: string;
  readonly path: string;
}

/** The traced operations and their messages. Packages may add their own through declaration merging. */
export interface TracingMessages {
  'http.request': HttpRequestMessage;
  'db.query': DbQueryMessage;
  'queue.dispatch': QueueDispatchMessage;
  'queue.job': QueueJobMessage;
  'schedule.task': ScheduleTaskMessage;
  'mail.send': MailSendMessage;
  'notification.send': NotificationSendMessage;
  'live.refresh': LiveRefreshMessage;
  'render.ssr': SsrRenderMessage;
}

/** The plain channels (one message, nothing traced) and their messages. */
export interface EventMessages {
  log: LogMessage;
  exception: ExceptionMessage;
}

export type TracingName = keyof TracingMessages & string;
export type EventName = keyof EventMessages & string;
export type ChannelName = TracingName | EventName;
/** The message of a channel: `ChannelMessage<'db.query'>`. */
export type ChannelMessage<N extends ChannelName> = N extends TracingName ? TracingMessages[N] : N extends EventName ? EventMessages[N] : never;

/** What a subscriber of a traced operation hears. */
export interface TracingHandlers<M> {
  /** Before the operation (for `db.query`: once it finished — Kysely reports queries afterwards). */
  start?(message: M): void;
  /** After it — succeeded, or failed with `message.error` — with `durationMs`. */
  end?(message: M): void;
  /** It failed (before `end`). */
  error?(message: M & { error: unknown }): void;
}

/** A plain channel, typed: what framework packages publish through. */
export interface EventChannel<M> {
  readonly hasSubscribers: boolean;
  publish(message: M): void;
}

const TRACING: readonly TracingName[] = [
  'http.request',
  'db.query',
  'queue.dispatch',
  'queue.job',
  'schedule.task',
  'mail.send',
  'notification.send',
  'live.refresh',
  'render.ssr',
];
const EVENTS: readonly EventName[] = ['log', 'exception'];

// Node's channels are process-wide by name; these are handles to them, created once (Node recommends top-level handles).
const tracings = new Map<string, TracingChannel<object>>(TRACING.map((name) => [name, tracingChannel<object>(`bespoke:${name}`)]));
const events = new Map<string, EventChannel<object>>(EVENTS.map((name) => [name, plainChannel(`bespoke:${name}`) as EventChannel<object>]));

/** Messages built for an app — tests prove that nothing is built without a subscriber. Kept on the app itself. */
const BUILT: unique symbol = Symbol.for('bespokecore.diagnostics.built');

/** A subscriber's error never reaches the operation it watches (Node would rethrow it as an uncaught exception). */
function guarded<M>(name: string, handler: ((message: M) => void) | undefined, app: Application): ((message: M) => void) | undefined {
  if (!handler) return undefined;
  return (message) => {
    if ((message as { app?: unknown }).app !== app) return;
    try {
      handler(message);
    } catch (error) {
      process.emitWarning(`A subscriber of bespoke:${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`, 'BespokeDiagnosticsWarning');
    }
  };
}

/** What `channels.subscribe` takes for a channel: `{ start?, end?, error? }` for a traced one, one function for a plain one. */
export type ChannelHandlers<N extends ChannelName> = N extends TracingName ? TracingHandlers<TracingMessages[N]> : (message: ChannelMessage<N>) => void;

function subscribe<N extends ChannelName>(app: Application, name: N, handlers: ChannelHandlers<N>): () => void;
function subscribe(app: Application, name: ChannelName, handlers: TracingHandlers<object> | ((message: object) => void)): () => void {
  const tracing = tracings.get(name);
  if (tracing) {
    if (typeof handlers !== 'object' || handlers === null) throw new TypeError(`channels.subscribe(app, '${name}', handlers): give { start?, end?, error? }.`);
    const subscribers: Partial<Record<'start' | 'asyncEnd' | 'error', (message: object) => void>> = {};
    const start = guarded(name, handlers.start?.bind(handlers), app);
    const end = guarded(name, handlers.end?.bind(handlers), app);
    const error = guarded(name, handlers.error?.bind(handlers) as ((message: object) => void) | undefined, app);
    if (start) subscribers.start = start;
    if (end) subscribers.asyncEnd = end;
    if (error) subscribers.error = error;
    tracing.subscribe(subscribers);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      tracing.unsubscribe(subscribers);
    };
  }
  const event = events.get(name);
  if (!event) throw new TypeError(`There is no channel "${name}". Channels: ${[...TRACING, ...EVENTS].join(', ')}.`);
  if (typeof handlers !== 'function') throw new TypeError(`channels.subscribe(app, '${name}', handler): give a function — ${name} is a plain channel.`);
  const handler = guarded(name, handlers, app)!;
  const named = plainChannel(`bespoke:${name}`);
  named.subscribe(handler as (message: unknown) => void);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    named.unsubscribe(handler as (message: unknown) => void);
  };
}

/** The framework's channels. */
export const channels = {
  /**
   * Listens to one channel, for one app's messages only. Returns `off` — call it when the subscriber stops (a provider's
   * `shutdown()`). A handler that throws is reported as a process warning; the operation goes on.
   *
   * ```ts
   * channels.subscribe(app, 'http.request', { end: (request) => … });   // traced: start / end / error
   * channels.subscribe(app, 'log', (entry) => …);                       // plain: one handler
   * ```
   */
  subscribe,

  /**
   * The TracingChannel of a traced operation — where framework packages publish (`if (channel.hasSubscribers) …`), and
   * what a tracer binds its context store to (`channel.start.bindStore(…)`). A raw subscriber gets every app's messages:
   * compare `message.app` itself.
   */
  tracing<N extends TracingName>(name: N): TracingChannel<TracingMessages[N]> {
    const tracing = tracings.get(name);
    if (!tracing) throw new TypeError(`There is no traced channel "${name}". Traced: ${TRACING.join(', ')}.`);
    return tracing as unknown as TracingChannel<TracingMessages[N]>;
  },

  /** A plain channel (`log`, `exception`), typed. */
  event<N extends EventName>(name: N): EventChannel<EventMessages[N]> {
    const event = events.get(name);
    if (!event) throw new TypeError(`There is no plain channel "${name}". Plain: ${EVENTS.join(', ')}.`);
    return event as EventChannel<EventMessages[N]>;
  },

  /** How many messages were built for `app` so far — 0 while nobody subscribes. */
  built(app: Application): number {
    return (app as unknown as { [BUILT]?: number })[BUILT] ?? 0;
  },
};

/**
 * The fields every message starts with — `app`, `startedAt` and where it happens (request, job, task). Call it only
 * behind a `hasSubscribers` check: it counts as a message built.
 */
export function messageBase(app: Application): MessageBase {
  const counted = app as unknown as { [BUILT]?: number };
  counted[BUILT] = (counted[BUILT] ?? 0) + 1;
  const request = currentRequest();
  const job = currentJob();
  const task = currentTask();
  return {
    app,
    startedAt: performance.timeOrigin + performance.now(),
    ...(request ? { requestId: request.requestId } : {}),
    ...(job ? { jobId: job.jobId } : {}),
    ...(task ? { task: task.task } : {}),
  };
}

/**
 * Runs `fn` traced on `channel`: start → end → (error) → asyncStart → asyncEnd, with `durationMs` set before the
 * operation counts as ended, and `fn` inside the start channel's bound stores (a tracer's context). `finish` fills in what
 * the result says (a status, an outcome) before the `end` handlers run.
 */
export function trace<M extends MessageBase & Ended, T>(channel: TracingChannel<M>, message: M, fn: () => Promise<T>, finish?: (message: M, result: T) => void): Promise<T> {
  const started = performance.now();
  return channel.tracePromise(async () => {
    try {
      const result = await fn();
      finish?.(message, result);
      return result;
    } finally {
      message.durationMs = performance.now() - started;
    }
  }, message);
}

/**
 * Publishes an operation that already ended (a query: Kysely reports it afterwards) as a traced one would have been:
 * start → end → (error) → asyncStart → asyncEnd.
 */
export function publishEnded<M extends MessageBase & Ended>(channel: TracingChannel<M>, message: M): void {
  channel.start.publish(message);
  channel.end.publish(message);
  if (message.error !== undefined) channel.error.publish(message);
  channel.asyncStart.publish(message);
  channel.asyncEnd.publish(message);
}
