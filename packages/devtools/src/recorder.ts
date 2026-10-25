import { randomUUID } from 'node:crypto';
import { currentJob, currentRequest, currentTask, outsideTransaction, type Application, type ErrorSolutions, type Redactor } from '@marmeon/core';
import {
  channels,
  type CommandRunMessage,
  type DbQueryMessage,
  type EventDispatchMessage,
  type ExceptionMessage,
  type HttpRequestMessage,
  type LiveRefreshMessage,
  type LogMessage,
  type MailSendMessage,
  type MessageBase,
  type NotificationSendMessage,
  type QueueDispatchMessage,
  type QueueJobMessage,
  type ScheduleTaskMessage,
  type SsrRenderMessage,
} from '@marmeon/core/diagnostics';
import { ignoresPath, type ResolvedDevtoolsOptions } from './config.ts';
import { EntryIds, type AnyEntry, type EntryContents, type EntryType, type ErrorDetails, type ExceptionEntryContent, type RequestEntryContent } from './entry.ts';
import type { DevtoolsStore } from './store.ts';

/** The most entries one batch keeps — a request running 10 000 queries keeps the first ones and counts the rest. */
export const MAX_BATCH_ENTRIES = 1000;

/** How long entries outside a request, job, run or command (and late ones of a finished request) wait to be written together. */
const LINGER_MS = 100;

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/** What a request, job attempt, scheduled run or command recorded so far — written when it ends. */
interface Batch {
  readonly id: string;
  readonly requestId?: string;
  readonly jobId?: string;
  /** A request whose path is ignored: nothing of it is kept. */
  readonly ignored: boolean;
  readonly entries: AnyEntry[];
  /** Work an entry still waits for (an exception's solutions). */
  readonly pending: Promise<void>[];
  dropped: number;
  /** Requests sharing it (an island resolved in-process joins its page's). */
  open: number;
  ssr?: RequestEntryContent['ssr'];
}

export interface RecorderOptions {
  readonly app: Application;
  readonly store: DevtoolsStore;
  readonly redactor: Redactor;
  readonly options: ResolvedDevtoolsOptions;
  /** The app's solutions, for exception entries. */
  readonly solutions?: ErrorSolutions;
}

/**
 * The devtools' recorder: listens to the app's channels and keeps what a request, job attempt, scheduled run or command did
 * as one batch, written to the store when it ends — never to the app's database. Every value passes the app's `Redactor`
 * before it is written (an encrypted payload only as `[encrypted]`), cut to 64 KB per entry. A handler never throws into the
 * operation, and a failed write loses entries, not the request. One per app. See docs/devtools.md#what-they-record.
 */
export class Recorder {
  readonly #app: Application;
  readonly #store: DevtoolsStore;
  readonly #redactor: Redactor;
  readonly #options: ResolvedDevtoolsOptions;
  readonly #solutions: ErrorSolutions | undefined;
  readonly #ids = new EntryIds();
  readonly #off: (() => void)[] = [];
  /** Open batches: requests by request id, job attempts by `<jobId>:<attempt>`, scheduled runs by task. */
  readonly #requests = new Map<string, Batch>();
  readonly #jobs = new Map<string, Batch>();
  readonly #tasks = new Map<string, Batch>();
  #command: Batch | undefined;
  /** Requests that ended lately — what they still do (deferred props, work after the response) joins their batch. */
  readonly #ended = new Map<string, { readonly id: string; readonly ignored: boolean }>();
  /** Entries waiting for {@link LINGER_MS}: late ones of ended requests, and those outside any batch. */
  readonly #lingering = new Map<string, Batch>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #writing = new Set<Promise<void>>();

  constructor({ app, store, redactor, options, solutions }: RecorderOptions) {
    this.#app = app;
    this.#store = store;
    this.#redactor = redactor;
    this.#options = options;
    this.#solutions = solutions;
  }

  /** Subscribes to the app's channels — what `record` lists. */
  start(): this {
    const record = this.#options.record;
    const app = this.#app;
    // Batches open and close with requests, jobs, runs and commands — also when their own entries are not recorded.
    this.#off.push(
      channels.subscribe(app, 'http.request', { start: (message) => this.#requestStarted(message), end: (message) => this.#requestEnded(message) }),
      channels.subscribe(app, 'queue.job', { start: (message) => this.#jobStarted(message), end: (message) => this.#jobEnded(message) }),
      channels.subscribe(app, 'schedule.task', { start: (message) => this.#taskStarted(message), end: (message) => this.#taskEnded(message) }),
      channels.subscribe(app, 'command.run', { start: (message) => this.#commandStarted(message), end: (message) => this.#commandEnded(message) }),
    );
    if (record.has('requests')) this.#off.push(channels.subscribe(app, 'render.ssr', { end: (message) => this.#rendered(message) }));
    if (record.has('queries')) this.#off.push(channels.subscribe(app, 'db.query', { end: (message) => this.#query(message) }));
    if (record.has('jobs')) this.#off.push(channels.subscribe(app, 'queue.dispatch', { end: (message) => this.#dispatched(message) }));
    if (record.has('mails')) this.#off.push(channels.subscribe(app, 'mail.send', { end: (message) => this.#mail(message) }));
    if (record.has('notifications')) this.#off.push(channels.subscribe(app, 'notification.send', { end: (message) => this.#notification(message) }));
    if (record.has('live')) this.#off.push(channels.subscribe(app, 'live.refresh', { end: (message) => this.#live(message) }));
    if (record.has('logs')) this.#off.push(channels.subscribe(app, 'log', (message) => this.#log(message)));
    if (record.has('exceptions')) this.#off.push(channels.subscribe(app, 'exception', (message) => this.#exception(message)));
    if (record.has('events')) this.#off.push(channels.subscribe(app, 'event', (message) => this.#event(message)));
    return this;
  }

  /** Writes what waits (lingering entries) and resolves once every write so far is done. */
  async settled(): Promise<void> {
    this.#flushLingering();
    while (this.#writing.size > 0) await Promise.all(this.#writing);
  }

  /** Unsubscribes, ends what is still open and writes everything. */
  async close(): Promise<void> {
    for (const off of this.#off.splice(0)) off();
    for (const batch of [...this.#requests.values(), ...this.#jobs.values(), ...this.#tasks.values(), ...(this.#command ? [this.#command] : [])]) this.#write(batch);
    this.#requests.clear();
    this.#jobs.clear();
    this.#tasks.clear();
    this.#command = undefined;
    await this.settled();
  }

  // ---- batches ---------------------------------------------------------------------------------------------------

  #batch(fields: { requestId?: string | undefined; jobId?: string | undefined; ignored?: boolean; id?: string }): Batch {
    return {
      id: fields.id ?? randomUUID(),
      ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
      ...(fields.jobId === undefined ? {} : { jobId: fields.jobId }),
      ignored: fields.ignored ?? false,
      entries: [],
      pending: [],
      dropped: 0,
      open: 1,
    };
  }

  /** The batch an entry made now belongs to: the job attempt, the scheduled run, the request or the command it runs in. */
  #current(): Batch | undefined {
    const job = currentJob();
    if (job) {
      const batch = this.#jobs.get(`${job.jobId}:${job.attempt}`);
      if (batch) return batch;
    }
    const task = currentTask();
    if (task) {
      const batch = this.#tasks.get(task.task);
      if (batch) return batch;
    }
    const request = currentRequest();
    if (request) {
      const open = this.#requests.get(request.requestId);
      if (open) return open;
      // After its response (deferred props streaming, work after the response): its batch again, written a moment later.
      const ended = this.#ended.get(request.requestId);
      if (ended) return this.#linger(request.requestId, () => this.#batch({ id: ended.id, requestId: request.requestId, ignored: ended.ignored }));
    }
    return this.#command;
  }

  /** Where an entry outside of any batch goes — written with others after {@link LINGER_MS}. */
  #background(): Batch {
    return this.#linger('', () => this.#batch({}));
  }

  #linger(key: string, create: () => Batch): Batch {
    let batch = this.#lingering.get(key);
    if (!batch) {
      batch = create();
      this.#lingering.set(key, batch);
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flushLingering(), LINGER_MS);
      this.#timer.unref?.();
    }
    return batch;
  }

  #flushLingering(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const batch of this.#lingering.values()) this.#write(batch);
    this.#lingering.clear();
  }

  /** Writes a batch: at once when nothing is pending (a test sees it with its response), else once its entries are complete. */
  #write(batch: Batch): void {
    if (batch.ignored || batch.entries.length === 0) return;
    const write = () => outsideTransaction(() => this.#store.write(batch.entries));
    const writing: Promise<void> =
      batch.pending.length === 0
        ? write()
        : Promise.allSettled(batch.pending)
            .then(write)
            .catch(() => undefined);
    this.#writing.add(writing);
    void writing.finally(() => this.#writing.delete(writing));
  }

  /**
   * Adds an entry: its content redacted as a whole once more (by key and in text, whatever a builder forgot) and cut
   * to 64 KB. Into `batch`, or the current one, or the background.
   */
  #add<T extends EntryType>(type: T, message: MessageBase, content: EntryContents[T], tags: readonly string[], batch = this.#current() ?? this.#background()): AnyEntry | undefined {
    if (batch.ignored) return undefined;
    if (batch.entries.length >= MAX_BATCH_ENTRIES) {
      batch.dropped++;
      return undefined;
    }
    const requestId = message.requestId ?? batch.requestId;
    const jobId = message.jobId ?? batch.jobId;
    const entry = {
      id: this.#ids.next(message.startedAt),
      type,
      at: message.startedAt,
      batch: batch.id,
      ...(requestId === undefined ? {} : { requestId }),
      ...(jobId === undefined ? {} : { jobId }),
      tags: tags.filter(Boolean).map((tag) => this.#redactor.text(tag)),
      content: this.#redactor.fit(this.#redactor.value(content)) as EntryContents[T],
    } as AnyEntry;
    batch.entries.push(entry);
    return entry;
  }

  #error(error: unknown): ErrorDetails | undefined {
    if (error === undefined) return undefined;
    if (error instanceof Error) return { class: error.name || error.constructor.name, message: this.#redactor.text(error.message), ...(error.stack ? { stack: this.#redactor.text(error.stack) } : {}) };
    return { class: typeof error, message: this.#redactor.text(String(error)) };
  }

  // ---- requests --------------------------------------------------------------------------------------------------

  #requestStarted(message: HttpRequestMessage): void {
    const open = this.#requests.get(message.requestId);
    if (open) {
      open.open++;
      return;
    }
    this.#requests.set(message.requestId, this.#batch({ requestId: message.requestId, ignored: ignoresPath(this.#options.ignore.paths, message.path) }));
  }

  #requestEnded(message: HttpRequestMessage): void {
    const batch = this.#requests.get(message.requestId);
    if (!batch) return;
    if (this.#options.record.has('requests') && !(message.inProcess && ignoresPath(this.#options.ignore.paths, message.path))) {
      this.#add('request', message, this.#requestContent(message, batch), [`status:${message.status ?? 0}`, `status:${Math.floor((message.status ?? 0) / 100)}xx`, message.route ? `route:${message.route}` : '', message.method, message.reload ? 'reload' : '', ...(message.error ? ['failed'] : [])], batch);
    }
    if (--batch.open > 0) return;
    this.#requests.delete(message.requestId);
    this.#ended.set(message.requestId, { id: batch.id, ignored: batch.ignored });
    if (this.#ended.size > 500) this.#ended.delete(this.#ended.keys().next().value!);
    this.#write(batch);
  }

  #requestContent(message: HttpRequestMessage, batch: Batch): RequestEntryContent {
    const redactor = this.#redactor;
    const url = new URL(message.url, 'http://localhost');
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key).map((value) => (redactor.isSensitive(key) ? '[redacted]' : redactor.text(value)));
      query[key] = values.length === 1 ? values[0]! : values;
    }
    const page = message.page;
    const error = this.#error(message.error);
    return {
      method: message.method,
      url: redactor.url(message.url, message.routePath),
      path: redactor.path(message.path, message.routePath),
      ...(message.route === undefined ? {} : { route: message.route }),
      ...(message.routePath === undefined ? {} : { routePath: message.routePath }),
      ...(message.controller === undefined ? {} : { controller: message.controller }),
      ...(message.status === undefined ? {} : { status: message.status }),
      ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
      ...(message.location === undefined ? {} : { location: redactor.url(message.location, message.locationRoutePath) }),
      ...(message.reload === undefined ? {} : { reload: message.reload }),
      ...(message.region === undefined ? {} : { region: message.region }),
      inProcess: message.inProcess,
      headers: redactor.headers(message.headers, { referer: message.refererRoutePath }),
      query,
      ...(message.input === undefined ? {} : { input: redactor.value(message.input) }),
      ...(page
        ? {
            page: {
              kind: page.kind,
              component: page.component,
              props: { ...page.props },
              bytes: Object.values(page.props).reduce((sum, bytes) => sum + bytes, 0),
              ...(page.only ? { only: [...page.only] } : {}),
              ...(page.except ? { except: [...page.except] } : {}),
              ...(page.deferred ? { deferred: page.deferred } : {}),
              ...(page.shared ? { shared: [...page.shared] } : {}),
              ...(page.optional ? { optional: [...page.optional] } : {}),
            },
          }
        : {}),
      ...(batch.ssr && !message.inProcess ? { ssr: batch.ssr } : {}),
      ...(batch.dropped > 0 ? { dropped: batch.dropped } : {}),
      ...(error ? { error } : {}),
    };
  }

  #rendered(message: SsrRenderMessage): void {
    const request = currentRequest();
    const batch = request ? this.#requests.get(request.requestId) : undefined;
    if (!batch) return;
    batch.ssr = {
      component: message.component,
      complete: message.complete,
      ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
      ...(message.streamed === undefined ? {} : { streamed: message.streamed }),
      ...(message.error === undefined ? {} : { failed: true }),
    };
  }

  // ---- jobs ------------------------------------------------------------------------------------------------------

  #jobStarted(message: QueueJobMessage): void {
    this.#jobs.set(`${message.jobId}:${message.attempt}`, this.#batch({ requestId: message.requestId ?? message.originRequestId, jobId: message.jobId }));
  }

  #jobEnded(message: QueueJobMessage): void {
    const key = `${message.jobId}:${message.attempt}`;
    const batch = this.#jobs.get(key);
    if (!batch) return;
    this.#jobs.delete(key);
    const failed = message.error !== undefined || message.outcome === 'failed';
    const status = message.error !== undefined ? 'failed' : (message.outcome ?? 'done');
    if (this.#options.record.has('jobs')) {
      const error = this.#error(message.error);
      this.#add(
        'job',
        message,
        {
          status,
          name: message.job,
          queue: message.queue,
          connection: message.connection,
          attempt: message.attempt,
          ...(message.payload === undefined ? {} : { payload: this.#redactor.payload(message.payload, message.encrypted === true) }),
          ...(message.originRequestId === undefined ? {} : { originRequestId: message.originRequestId }),
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          ...(error ? { error } : {}),
        },
        [`job:${message.job}`, `status:${status}`, failed ? 'failed' : ''],
        batch,
      );
    }
    if (message.error !== undefined) this.#failure(message, message.error, 'job', batch);
    this.#write(batch);
  }

  #dispatched(message: QueueDispatchMessage): void {
    const error = this.#error(message.error);
    const ids = message.jobIds.length > 0 ? message.jobIds : error ? [undefined] : [];
    ids.forEach((id, index) => {
      const name = message.jobs[index] ?? message.jobs[0] ?? '?';
      this.#add(
        'job',
        { ...message, ...(id === undefined ? {} : { jobId: id }) },
        {
          status: 'queued',
          name,
          queue: message.queue,
          connection: message.connection,
          kind: message.kind,
          delaySeconds: message.delaySeconds,
          ...(message.unique === undefined ? {} : { unique: message.unique }),
          ...(message.payloads && index < message.payloads.length ? { payload: this.#redactor.payload(message.payloads[index], message.encrypted?.[index] === true) } : {}),
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          ...(error ? { error } : {}),
        },
        [`job:${name}`, 'status:queued', error ? 'failed' : ''],
      );
    });
  }

  // ---- scheduled runs and commands ---------------------------------------------------------------------------------

  #taskStarted(message: ScheduleTaskMessage): void {
    this.#tasks.set(message.task, this.#batch({}));
  }

  #taskEnded(message: ScheduleTaskMessage): void {
    const batch = this.#tasks.get(message.task);
    if (!batch) return;
    this.#tasks.delete(message.task);
    if (this.#options.record.has('schedule')) {
      const error = this.#error(message.error);
      this.#add(
        'schedule',
        message,
        {
          task: message.task,
          minute: message.minute,
          reason: message.reason,
          ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
          ...(message.skipped === undefined ? {} : { skipped: message.skipped }),
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          ...(error ? { error } : {}),
        },
        [`task:${message.task}`, message.outcome ? `status:${message.outcome}` : '', message.outcome === 'failed' ? 'failed' : ''],
        batch,
      );
    }
    if (message.error !== undefined) this.#failure(message, message.error, 'schedule', batch);
    this.#write(batch);
  }

  #commandStarted(message: CommandRunMessage): void {
    this.#command = this.#options.ignore.commands.has(message.command) ? undefined : this.#batch({});
  }

  #commandEnded(message: CommandRunMessage): void {
    const batch = this.#command;
    if (!batch) return;
    this.#command = undefined;
    if (this.#options.record.has('commands')) {
      const error = this.#error(message.error);
      this.#add(
        'command',
        message,
        {
          command: message.command,
          args: message.args.map((arg) => this.#redactor.text(arg)),
          ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          ...(error ? { error } : {}),
        },
        [`command:${message.command}`, message.error !== undefined || (message.exitCode ?? 0) !== 0 ? 'failed' : ''],
        batch,
      );
    }
    if (message.error !== undefined) this.#failure(message, message.error, 'command', batch);
    this.#write(batch);
  }

  // ---- what happens inside --------------------------------------------------------------------------------------

  #query(message: DbQueryMessage): void {
    const ignore = this.#options.ignore.queries;
    if (ignore?.({ sql: message.sql, connection: message.connection })) return;
    // Outside of a request, job, run or command (a worker polling its queue, a health check): not recorded.
    const batch = this.#current();
    if (!batch) return;
    const { sql, parameters } = this.#redactor.query(message);
    const slow = message.durationMs >= this.#options.slowQueryMs;
    const error = this.#error(message.error);
    this.#add(
      'query',
      message,
      { connection: message.connection, driver: message.driver, sql, parameters, sensitive: message.secret, durationMs: message.durationMs, slow, ...(error ? { error } : {}) },
      [`connection:${message.connection}`, slow ? 'slow' : '', error ? 'failed' : ''],
      batch,
    );
  }

  #mail(message: MailSendMessage): void {
    const error = this.#error(message.error);
    const redactor = this.#redactor;
    this.#add(
      'mail',
      message,
      {
        mailable: message.mailable,
        mode: message.mode,
        ...(message.from === undefined ? {} : { from: message.from }),
        to: message.to ?? [],
        cc: message.cc ?? [],
        bcc: message.bcc ?? [],
        ...(message.subject === undefined ? {} : { subject: redactor.text(message.subject) }),
        // Links in the body: `signature=…` and token paths (`/reset-password/<token>`) masked by the redactor's text rules.
        ...(message.html === undefined ? {} : { html: redactor.text(message.html) }),
        ...(message.text === undefined ? {} : { text: redactor.text(message.text) }),
        attachments: message.attachments ?? [],
        ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
        ...(error ? { error } : {}),
      },
      [`mailable:${message.mailable}`, `mode:${message.mode}`, error ? 'failed' : ''],
    );
  }

  #notification(message: NotificationSendMessage): void {
    const error = this.#error(message.error);
    this.#add(
      'notification',
      message,
      {
        notification: message.notification,
        id: message.id,
        recipient: { type: message.recipient.type, id: message.recipient.id },
        queued: message.queued,
        ...(message.channels === undefined ? {} : { channels: message.channels }),
        ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
        ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
        ...(error ? { error } : {}),
      },
      [`notification:${message.notification}`, error ? 'failed' : ''],
    );
  }

  #live(message: LiveRefreshMessage): void {
    const error = this.#error(message.error);
    this.#add(
      'live',
      message,
      { channel: message.channel, only: message.only, ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }), ...(error ? { error } : {}) },
      [`channel:${message.channel}`],
    );
  }

  #log(message: LogMessage): void {
    if (LEVELS[message.level] < LEVELS[this.#options.logLevel]) return;
    // The database's own line per statement: the query entry says it all (and better).
    if (message.context.channel === 'db' && (message.message === 'Query' || message.message === 'Query failed')) return;
    this.#add('log', message, { level: message.level, message: this.#redactor.text(message.message), context: this.#redactor.value(message.context) as Record<string, unknown> }, [`level:${message.level}`]);
  }

  #exception(message: ExceptionMessage): void {
    this.#failure(message, message.error, 'request', undefined, { status: message.status, method: message.method, path: message.path, routePath: message.routePath });
  }

  /** An `exception` entry: the error, where it ended, and the solutions the error page would show — looked up before the batch is written. */
  #failure(message: MessageBase, error: unknown, where: ExceptionEntryContent['in'], batch?: Batch, request?: { status: number; method: string; path: string; routePath?: string | undefined }): void {
    if (!this.#options.record.has('exceptions')) return;
    const shown = this.#error(error)!;
    const solutions: ExceptionEntryContent['solutions'][number][] = [];
    const entry = this.#add(
      'exception',
      message,
      { ...shown, in: where, ...(request ? { status: request.status, method: request.method, path: this.#redactor.path(request.path, request.routePath) } : {}), solutions },
      [shown.class, request ? `status:${request.status}` : ''],
      batch,
    );
    if (!entry || !this.#solutions) return;
    const target = batch ?? this.#current() ?? this.#background();
    target.pending.push(
      this.#solutions
        .find(error, { app: this.#app })
        .then((found) => {
          const redactor = this.#redactor;
          const list = found.map((solution) => ({
            title: redactor.text(solution.title),
            text: redactor.text(solution.text),
            ...(solution.command ? { command: redactor.text(solution.command) } : {}),
            ...(solution.docs ? { docs: solution.docs } : {}),
          }));
          (entry.content as unknown as { solutions: unknown[] }).solutions.push(...list);
        })
        .catch(() => undefined),
    );
  }

  #event(message: EventDispatchMessage): void {
    if (this.#options.ignore.events.has(message.name)) return;
    this.#add('event', message, { name: message.name, class: message.event.constructor?.name ?? 'Object', payload: this.#redactor.value(message.event), listeners: [...message.listeners] }, [`event:${message.name}`]);
  }
}
