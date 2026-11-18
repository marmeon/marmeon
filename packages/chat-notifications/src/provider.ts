import { Application, Clock, Logger, Redactor, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { HttpClient } from '@marmeon/fetch';
import { BUILT_IN_CHAT_DRIVERS, CHAT_LOG_WARNING, ChatConfig, parseWebhooks } from './config.ts';
import { checkWebhook } from './destination.ts';
import type { ChatDriverFactory } from './driver.ts';
import { ChatError, ChatSetupError } from './errors.ts';
import { SendQueuedChatMessage, type QueuedChatPayload } from './job.ts';
import { ChatNotifier, WebhookChatNotifier, type ChatQueue, type QueueChatOptions } from './notifier.ts';
import { ChatPoster } from './poster.ts';
import { ChatTargets } from './targets.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Chat drivers this provider brings, by name — `CHAT_DRIVER=<name>` selects one for the named destinations and a destination
     * can name one with `{ url, driver }`. A built-in name (`log`, `slack`, `discord`, `teams`) or a name two providers both bring
     * stops the start, with a `TypeError` (not an S10 error). See `docs/drivers.md#chat-drivers`.
     */
    readonly chatDrivers?: Readonly<Record<string, ChatDriverFactory>>;
  }
}

type QueueModule = typeof import('@marmeon/queue');
type NotificationsModule = typeof import('@marmeon/notifications');

/**
 * Imports an optional peer: `undefined` only when the package itself is missing (the importer's path may name it, and so may another
 * missing package's error). `load` is the import, replaceable by a test.
 */
async function importOptional<T>(load: () => Promise<T>, name: string): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    const missing = new RegExp(`Cannot find (?:package|module) '${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`);
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && missing.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

/** @marmeon/queue is an optional peer: only `chat.queue()` needs it. `load` is the import, replaceable by a test. @internal */
export function importQueue(load: () => Promise<QueueModule> = () => import('@marmeon/queue')): Promise<QueueModule | undefined> {
  return importOptional(load, '@marmeon/queue');
}

/** @marmeon/notifications is an optional peer: only the `chat` channel needs it. `load` is the import, replaceable by a test. @internal */
export function importNotifications(load: () => Promise<NotificationsModule> = () => import('@marmeon/notifications')): Promise<NotificationsModule | undefined> {
  return importOptional(load, '@marmeon/notifications');
}

/**
 * The built-in webhook shapes, for the redactor: a text that holds one has its path and query masked. A safety net: the guard accepts
 * only addresses the URL parser leaves unchanged, and these patterns match those (any case, a trailing dot, port 443); the guard's
 * normalized `href` is what is sent. Each starts on a literal and a pattern never repeats a group or a bounded run, so a long text
 * costs one pass (K15).
 * @internal
 */
export const WEBHOOK_PATTERNS: readonly RegExp[] = [
  /https:\/\/hooks\.slack\.com\.?(?::443)?\/services\/[^\s"'<>]+/i,
  /https:\/\/(?:(?:canary\.|ptb\.)?discord(?:app)?\.com)\.?(?::443)?\/api(?:\/v\d+)?\/webhooks\/[^\s"'<>]+/i,
  /\.environment\.api\.powerplatform\.com\.?(?::443)?\/[^\s"'<>]+/i,
];

function setup(message: string, options?: { cause?: unknown }): ChatSetupError {
  return new ChatSetupError(withCode('S10', message), options);
}

/**
 * Registers the `ChatNotifier`, which posts chat messages through the `HttpClient` of @marmeon/fetch (`CHAT_DRIVER`), and the
 * `marmeon.chat` job for `chat.queue()` when the app has @marmeon/queue. The configuration is checked at the start: a driver nobody
 * brought, a bad `CHAT_WEBHOOKS` or a driver that breaks its contract stops it. Found by `marmeon discover`. See
 * `docs/chat-notifications.md#configuration`.
 */
export class ChatServiceProvider implements ServiceProvider {
  static config = [ChatConfig];

  #custom: ReadonlyMap<string, ChatDriverFactory> | undefined;

  register(container: Container): void {
    const config = container.make(ChatConfig);
    container.singleton(ChatTargets, (c) =>
      new ChatTargets({
        driver: config.driver,
        webhooks: parseWebhooks(config.webhooks),
        custom: () => this.#factories(c),
        context: (name) => ({ name, container: c, logger: c.make(Logger).child({ channel: 'chat' }) }),
      }),
    );
    container.singleton(ChatPoster, (c) =>
      new ChatPoster({
        targets: c.make(ChatTargets),
        http: () => c.make(HttpClient),
        logger: c.make(Logger).child({ channel: 'chat' }),
        clock: c.make(Clock),
        protected: config.protected,
      }),
    );
    const available = async (): Promise<QueueModule> => {
      const module = await importQueue();
      if (!module || !container.has(module.Queue)) {
        throw new ChatError('chat.queue() needs @marmeon/queue (pnpm add -E @marmeon/queue@<version of your app>; marmeon discover) — or post now: chat.send().');
      }
      return module;
    };
    const queue: ChatQueue = Object.assign(
      async (payload: QueuedChatPayload, options: QueueChatOptions) => {
        const module = await available();
        // `JobInput` of a payload that holds `ChatJson` is too deep for the compiler; the schema checks the payload at the dispatch.
        return container.make(module.Queue).dispatch(SendQueuedChatMessage as never, payload as never, options);
      },
      { ready: async () => void (await available()) },
    );
    container.singleton(ChatNotifier, (c) => new WebhookChatNotifier(c.make(ChatTargets), c.make(ChatPoster), queue));
    container.bind(SendQueuedChatMessage, (c) => new SendQueuedChatMessage(c.make(ChatPoster), c.make(ChatTargets)));
  }

  /** The drivers other providers bring; a built-in name or a name twice stops the start with a `TypeError`. */
  #factories(container: Resolver): ReadonlyMap<string, ChatDriverFactory> {
    this.#custom ??= collectDrivers<ChatDriverFactory>(container.make(Application).providers, 'chatDrivers', BUILT_IN_CHAT_DRIVERS, 'chat driver');
    return this.#custom;
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const config = container.make(ChatConfig);
    if (!container.has(HttpClient)) {
      throw setup('Chat messages need the FetchServiceProvider of @marmeon/fetch (installed with this package: marmeon discover).');
    }
    const custom = this.#factories(container);
    const builtIn = BUILT_IN_CHAT_DRIVERS as readonly string[];
    if (!builtIn.includes(config.driver) && !custom.has(config.driver)) {
      throw setup(`CHAT_DRIVER=${config.driver} is not a chat driver. Known: ${[...BUILT_IN_CHAT_DRIVERS, ...custom.keys()].join(', ')}.`);
    }
    const webhooks = parseWebhooks(config.webhooks);
    const targets = container.make(ChatTargets);
    // The driver `CHAT_DRIVER` selects is built here, so one that breaks its contract stops the start.
    let selected: ReturnType<ChatTargets['driver']> | undefined;
    if (config.driver !== 'log') {
      try {
        selected = targets.driver(config.driver);
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        throw setup(error.message, error.cause === undefined ? undefined : { cause: error.cause });
      }
    }
    if (selected !== undefined) {
      for (const [name, url] of webhooks) {
        const checked = checkWebhook(url, selected, config.driver);
        if (!checked.ok) throw setup(`CHAT_WEBHOOKS: the destination "${name}" is refused for CHAT_DRIVER=${config.driver}: ${checked.problem}`);
      }
    }
    if (container.has(Redactor)) {
      container.make(Redactor).addKeys('webhook', 'webhooks', 'webhook_url', 'webhookUrl', 'chat_webhooks').addPatterns(...WEBHOOK_PATTERNS);
    }
    const queue = await importQueue();
    if (queue && container.has(queue.JobRegistry)) container.make(queue.JobRegistry).add([SendQueuedChatMessage], '@marmeon/chat-notifications', { framework: true });
    const notifications = await importNotifications();
    if (notifications && container.has(notifications.NotificationChannels)) {
      // loaded only now: the channel imports @marmeon/notifications, which an app without notifications does not have
      const { ChatChannel } = await import('./notifications.ts');
      // `scope.make`: the delivery's scope builds the notifier, so an override of `ChatNotifier` in that scope applies
      container.make(notifications.NotificationChannels).add('chat', (scope) => new ChatChannel(scope.make(ChatNotifier), scope.make(Logger).child({ channel: 'chat' })));
    }
    if (config.protected && config.driver === 'log') container.make(Logger).warn(CHAT_LOG_WARNING, { driver: 'log' });
  }
}
