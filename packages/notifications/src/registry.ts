import type { AnyRecipientResolverClass, NotificationClass } from './notification.ts';
import { withCode } from '@marmeon/core/internal';

/** Notifications are set up wrongly — a class without a name, a name used twice, two resolvers for one kind … — said at startup. */
export class NotificationSetupError extends Error {
  override name = 'NotificationSetupError';
}

/** A notification could not be sent or delivered — its data does not match its schema, it is not registered, a channel is unknown. */
export class NotificationError extends Error {
  override name = 'NotificationError';
}

/** `auth.new-sign-in` — lower case, digits, and `.`, `-`, `_`, `:` between parts (like a job's name). */
const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

/**
 * Which notification class has which name — from the modules' `notifications: [...]`. A worker finds a notification's
 * class here, so one that is not registered cannot be sent; a name used twice fails the start.
 */
export class NotificationRegistry {
  readonly #classes = new Map<string, { readonly notification: NotificationClass; readonly source: string }>();

  add(notifications: readonly NotificationClass[], source: string): this {
    for (const notification of notifications) {
      const name = checkNotificationClass(notification, source);
      const existing = this.#classes.get(name);
      if (existing && existing.notification !== notification) {
        throw new NotificationSetupError(
          withCode(
            'Q6',
            `Two notifications are named "${name}": ${existing.notification.name} (${existing.source}) and ${notification.name} (${source}). A notification's name is how a worker and the inbox find its class — give each its own static notification.`,
          ),
        );
      }
      this.#classes.set(name, { notification, source });
    }
    return this;
  }

  get(name: string): NotificationClass | undefined {
    return this.#classes.get(name)?.notification;
  }

  /** Whether exactly this class is registered under its name. */
  has(notification: NotificationClass): boolean {
    return this.#classes.get(notification.notification)?.notification === notification;
  }

  all(): NotificationClass[] {
    return [...this.#classes.values()].map((entry) => entry.notification);
  }
}

/** The notification's name, after checking the class has what a notification needs. */
export function checkNotificationClass(notification: NotificationClass, source: string): string {
  const label = typeof notification === 'function' && notification.name ? notification.name : String(notification);
  if (typeof notification !== 'function') throw new NotificationSetupError(withCode('Q6', `${source} lists ${label} as a notification, but it is not a class.`));
  if (typeof notification.notification !== 'string' || !NAME.test(notification.notification)) {
    throw new NotificationSetupError(
      withCode(
        'Q6',
        `${label} (${source}) needs a stable name: static notification = 'module.what-happened' (lower case; letters, digits and . - _ : between parts) — never the class name, which changes with refactoring.` +
          (typeof notification.notification === 'string' ? ` "${notification.notification}" is not one.` : ''),
      ),
    );
  }
  for (const key of ['schema', 'database'] as const) {
    const schema = notification[key];
    if ((key === 'schema' || schema !== undefined) && typeof schema?.['~standard']?.validate !== 'function') {
      throw new NotificationSetupError(
        withCode(
          'Q6',
          key === 'schema'
            ? `${label} (${notification.notification}, ${source}) needs static schema — a Standard Schema of its data, e.g. v.object({ orderId: v.string() }).`
            : `${label} (${notification.notification}, ${source}): static database must be a Standard Schema of what toDatabase() returns.`,
        ),
      );
    }
  }
  if (typeof notification.prototype?.via !== 'function') throw new NotificationSetupError(withCode('Q6', `${label} (${notification.notification}, ${source}) needs a via(recipient, data) method that returns its channels.`));
  const options = notification.queue as Record<string, unknown> | undefined;
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null) throw new NotificationSetupError(withCode('Q6', `${label}: static queue must be an object — { queue, connection, delay, tries, backoff }.`));
    for (const key of Object.keys(options)) {
      if (!['queue', 'connection', 'delay', 'tries', 'backoff'].includes(key)) {
        throw new NotificationSetupError(withCode('Q6', `${label} (static queue): unknown setting "${key}" — it takes queue, connection, delay, tries and backoff.`));
      }
    }
    const { tries, backoff } = options;
    if (tries !== undefined && (!Number.isInteger(tries) || (tries as number) < 1)) throw new NotificationSetupError(withCode('Q6', `${label} (static queue): tries must be a whole number ≥ 1, not ${String(tries)}.`));
    const delays = backoff === undefined ? [] : typeof backoff === 'number' ? [backoff] : backoff;
    if (!Array.isArray(delays) || delays.some((delay) => !(typeof delay === 'number' && delay >= 0))) {
      throw new NotificationSetupError(withCode('Q6', `${label} (static queue): backoff must be seconds ≥ 0 — a number or a list like [10, 60, 300].`));
    }
  }
  return notification.notification;
}

/**
 * Which resolver finds the recipients of which kind — from the modules' `recipients: { user: UserRecipients }`. One
 * resolver per kind: a second fails the start.
 */
export class RecipientRegistry {
  readonly #resolvers = new Map<string, { readonly resolver: AnyRecipientResolverClass; readonly source: string }>();

  add(resolvers: Readonly<Record<string, AnyRecipientResolverClass | undefined>>, source: string): this {
    for (const [type, resolver] of Object.entries(resolvers)) {
      if (resolver === undefined) continue;
      if (!NAME.test(type)) throw new NotificationSetupError(withCode('Q6', `${source} names a kind of recipient "${type}" — use a name like user or team (lower case).`));
      if (typeof resolver !== 'function' || typeof resolver.prototype?.find !== 'function') {
        throw new NotificationSetupError(withCode('Q6', `${source}: the resolver of "${type}" recipients must be a class with find(id) — the recipient's record, or undefined when it is gone.`));
      }
      const existing = this.#resolvers.get(type);
      if (existing && existing.resolver !== resolver) {
        throw new NotificationSetupError(withCode('Q6', `Two resolvers find "${type}" recipients: ${existing.resolver.name} (${existing.source}) and ${resolver.name} (${source}) — one kind, one resolver.`));
      }
      this.#resolvers.set(type, { resolver, source });
    }
    return this;
  }

  get(type: string): AnyRecipientResolverClass | undefined {
    return this.#resolvers.get(type)?.resolver;
  }

  types(): string[] {
    return [...this.#resolvers.keys()];
  }
}
