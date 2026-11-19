import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { afterCommit, durationToSeconds, inTransaction, TransactionFinishedError, type Container, type Duration } from '@marmeon/core';
import { describeDestination } from './destination.ts';
import { ChatDeliveryError, ChatError } from './errors.ts';
import { normalizeMessage, type ChatContent, type ChatDestination, type ChatMessage } from './message.ts';
import { checkQueued, type ChatNotifier, type QueueChatOptions } from './notifier.ts';
import { importQueue } from './provider.ts';
import { ChatTargets } from './targets.ts';

/** One message the fake took: where it went, what was sent after normalization, and how. */
export interface RecordedChatMessage {
  readonly to: ChatDestination;
  readonly content: ChatContent;
  /** `true` for `queue()`, `false` for `send()`. */
  readonly queued: boolean;
  /** The options `queue()` was called with (empty for `send()`). */
  readonly options: QueueChatOptions;
  /** Whether the call was made inside a transaction (a queued message is recorded only once that commits). */
  readonly inTransaction: boolean;
}

/**
 * What an assertion looks for: an object whose given keys must all match, or a function of the recorded message that returns
 * `true`. The keys are `to` (compared as normalized, like a destination that is sent: `{ url, driver: undefined }` equals
 * `{ url }`; a mistyped name throws `ChatError`), `title` and `text` (against the normalized content). A key whose value is
 * `undefined` is not given; any other key throws a `TypeError`.
 */
export type ChatMatch = { readonly to?: ChatDestination; readonly title?: string; readonly text?: string } | ((message: RecordedChatMessage) => boolean);

const KEYS = ['to', 'title', 'text'];

/** The keys of an object match that are given, after checking that there are no others and that `to` is a destination. */
function given(match: Exclude<ChatMatch, (...args: never[]) => unknown>): { readonly to?: ChatDestination; readonly title?: string; readonly text?: string } {
  if (typeof match !== 'object' || match === null || Array.isArray(match)) throw new TypeError('A chat match is an object { to?, title?, text? } or a function.');
  for (const key of Object.keys(match)) {
    // a key can be an address (a mistake that puts data where a name belongs): only a name that looks like one is echoed
    if (!KEYS.includes(key)) throw new TypeError(`A chat match has ${/^[A-Za-z_$][\w$]{0,39}$/.test(key) ? `no key "${key}"` : 'an unknown key'}: use to, title or text, or a function.`);
  }
  const { to, title, text } = match;
  return {
    ...(to === undefined ? {} : { to: normalizeMessage({ to, text: 'x' }).to }),
    ...(title === undefined ? {} : { title }),
    ...(text === undefined ? {} : { text }),
  };
}

const matches = (match: ChatMatch, message: RecordedChatMessage): boolean => {
  if (typeof match === 'function') return (match as (message: RecordedChatMessage) => unknown)(message) === true;
  const wanted = given(match);
  if ('to' in wanted && !isDeepStrictEqual(wanted.to, message.to)) return false;
  if ('title' in wanted && wanted.title !== message.content.title) return false;
  if ('text' in wanted && wanted.text !== message.content.text) return false;
  return true;
};

/** A message for an assertion failure: its destination (never an address) and title. */
const describe = (message: RecordedChatMessage): string =>
  `${describeDestination(message.to)}${message.content.title === undefined ? '' : ` titled ${JSON.stringify(message.content.title)}`}`;

const describeMatch = (match: ChatMatch): string => {
  if (typeof match === 'function') return ' matching the function';
  const wanted = given(match);
  const parts: string[] = [];
  if ('to' in wanted) parts.push(`to ${describeDestination(wanted.to as ChatDestination)}`);
  if ('title' in wanted) parts.push(`titled ${JSON.stringify(wanted.title)}`);
  if ('text' in wanted) parts.push(`with the text ${JSON.stringify(wanted.text)}`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
};

const PARTS = ['days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;

/** The options of a `queue()` call as the notifier passes them on: the three it knows, an object delay copied by its parts. */
function recordedOptions(options: QueueChatOptions): QueueChatOptions {
  const { delay } = options;
  let copy: Duration | undefined = delay;
  if (typeof delay === 'object') {
    const parts: Record<string, number> = {};
    for (const part of PARTS) {
      const value = delay[part];
      if (value !== undefined) parts[part] = value;
    }
    copy = Object.freeze(parts);
  }
  return Object.freeze({
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(copy === undefined ? {} : { delay: copy }),
  });
}

/** `inTransaction()`, except that a call chain that started in a transaction that has finished is outside one, as the real notifier treats it (it posts). */
function inOpenTransaction(): boolean {
  try {
    return inTransaction();
  } catch (error) {
    if (error instanceof TransactionFinishedError) return false;
    throw error;
  }
}

/**
 * Records chat messages instead of posting them: `app.chat` of a test app. See `docs/fakes.md#chat`.
 * It checks every message as the real notifier does.
 * A destination `CHAT_WEBHOOKS` does not list, an address its driver refuses and a bad message fail the test.
 * `queue()` also refuses a bad delay and an app without the queue services, with the errors of the real queue.
 * Nothing is requested and no job is queued.
 * `send()` records at once.
 * `queue()` records when the transaction around it commits, and never after a rollback.
 * Assertion messages name a destination by its name or host, never by its address.
 */
export class ChatFake implements ChatNotifier {
  readonly #container: Container;
  readonly #targets: ChatTargets;
  readonly #messages: RecordedChatMessage[] = [];
  readonly #failures: Error[] = [];

  /** @internal Built by `createTestApp()`: `container` is the container of an app with the `ChatServiceProvider` (and the queue services for `queue()`). */
  constructor(container: Container) {
    this.#container = container;
    this.#targets = container.make(ChatTargets);
  }

  async send(message: ChatMessage): Promise<void> {
    const { to, content } = normalizeMessage(message);
    this.#targets.validate(to, content);
    const problem = this.#targets.problem(to);
    if (problem !== undefined) throw new ChatDeliveryError('refused', `The chat message to ${describeDestination(to)} was refused: ${problem}`);
    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;
    this.#messages.push(Object.freeze({ to, content, queued: false, options: Object.freeze({}), inTransaction: inOpenTransaction() }));
  }

  async queue(message: ChatMessage, options: QueueChatOptions = {}): Promise<void> {
    const { to, content } = await checkQueued(this.#targets, message, async () => {
      const module = await importQueue();
      if (!module || !this.#container.has(module.Queue)) {
        throw new ChatError('chat.queue() needs @marmeon/queue (marmeon add queue; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/queue@<version of your app>) — or post now: chat.send().');
      }
    });
    const module = (await importQueue())!;
    if (options.delay !== undefined) {
      // a delay that is no span of time at all is a `TypeError` of `durationToSeconds`, as in the real queue
      if (durationToSeconds(options.delay) < 0) throw new module.QueueError(`A delay must be seconds ≥ 0 (or a duration), not ${JSON.stringify(options.delay)}.`);
    }
    const recorded: RecordedChatMessage = Object.freeze({ to, content, queued: true, options: recordedOptions(options), inTransaction: inOpenTransaction() });
    await afterCommit(() => {
      this.#messages.push(recorded);
    });
  }

  check(to: ChatDestination): string | undefined {
    let normalized: ChatDestination;
    try {
      normalized = normalizeMessage({ to, text: 'x' }).to;
    } catch (error) {
      if (error instanceof ChatError) return error.message;
      throw error;
    }
    return this.#targets.problem(normalized);
  }

  /** The messages `send()` posted, in order. */
  get sent(): readonly RecordedChatMessage[] {
    return this.#messages.filter((message) => !message.queued);
  }

  /** The messages `queue()` took (and whose transaction committed), in order. */
  get queued(): readonly RecordedChatMessage[] {
    return this.#messages.filter((message) => message.queued);
  }

  /**
   * Makes the next `times` calls of `send()` (default one) throw `error` — by default a `ChatDeliveryError` (`unavailable`). The
   * message is checked first and not recorded. `queue()` is not affected: the failure of a queued message belongs to its job.
   */
  failNext(error: Error = new ChatDeliveryError('unavailable', 'The fake chat notifier failed this send.'), times = 1): this {
    if (!Number.isSafeInteger(times) || times < 1) throw new TypeError(`failNext() takes a positive whole number of times, not ${String(times)}.`);
    for (let count = 0; count < times; count += 1) this.#failures.push(error);
    return this;
  }

  assertSent(match?: ChatMatch): this {
    return this.#assertSome('sent', this.sent, match);
  }

  assertSentCount(count: number): this {
    return this.#assertCount('sent', this.sent, count);
  }

  assertNothingSent(): this {
    return this.#assertCount('sent', this.sent, 0);
  }

  assertQueued(match?: ChatMatch): this {
    return this.#assertSome('queued', this.queued, match);
  }

  assertQueuedCount(count: number): this {
    return this.#assertCount('queued', this.queued, count);
  }

  assertNothingQueued(): this {
    return this.#assertCount('queued', this.queued, 0);
  }

  #assertSome(kind: 'sent' | 'queued', messages: readonly RecordedChatMessage[], match: ChatMatch | undefined): this {
    if (match !== undefined && typeof match !== 'function') given(match);
    if (!messages.some((message) => match === undefined || matches(match, message))) {
      throw new AssertionError({ message: `Expected a chat message${match === undefined ? '' : describeMatch(match)} to be ${kind}. ${this.#summary(kind, messages)}` });
    }
    return this;
  }

  #assertCount(kind: 'sent' | 'queued', messages: readonly RecordedChatMessage[], count: number): this {
    if (messages.length !== count) {
      throw new AssertionError({ message: `Expected ${count} chat ${count === 1 ? 'message' : 'messages'} to be ${kind}, ${messages.length} ${messages.length === 1 ? 'was' : 'were'}. ${this.#summary(kind, messages)}` });
    }
    return this;
  }

  #summary(kind: 'sent' | 'queued', messages: readonly RecordedChatMessage[]): string {
    return `${kind === 'sent' ? 'Sent' : 'Queued'}: ${messages.length === 0 ? 'none' : messages.map(describe).join('; ')}.`;
  }
}
