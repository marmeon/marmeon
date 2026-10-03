import type { Resolver } from '@bespokecore/core';
import type { JobContext } from '@bespokecore/queue';
import * as v from 'valibot';
import { NotificationChannelError, type NotificationDeliverer } from './notifications.ts';
import { NotificationError, type NotificationRegistry } from './registry.ts';
import { describeIssues, NotificationDataError } from './validate.ts';

/** What a queued notification carries: its id, its name, the recipient as data and the data as JSON. */
export type QueuedNotificationPayload = v.InferOutput<typeof SendQueuedNotification.schema>;

/**
 * The framework job behind `notifications.send()` (E92): one notification for one recipient. **Encrypted** (E105) — a
 * notification's data is the app's and may say more than IDs.
 *
 * In the worker, in the job's scope: the class by its name, the data checked again — one that no longer matches its
 * schema after a deploy fails at once (no retries that cannot succeed) —, then the delivery (`NotificationDeliverer`). A
 * recipient that is gone discards the job; a channel the app does not have fails it. Three attempts by default
 * (`static queue.tries` of the notification); a retry after a committed delivery finds its row and stops.
 */
export class SendQueuedNotification {
  static readonly job = 'bespoke.notification';
  static readonly schema = v.object({
    id: v.string(),
    notification: v.string(),
    recipient: v.object({ type: v.string(), id: v.union([v.string(), v.number()]) }),
    data: v.unknown(),
  });
  static readonly encrypted = true;
  static readonly tries = 3;
  static readonly backoff = [10, 60, 300];

  readonly #resolver: Resolver;
  readonly #deliverer: NotificationDeliverer;
  readonly #registry: NotificationRegistry;

  constructor(resolver: Resolver, deliverer: NotificationDeliverer, registry: NotificationRegistry) {
    this.#resolver = resolver;
    this.#deliverer = deliverer;
    this.#registry = registry;
  }

  async handle(payload: QueuedNotificationPayload, job: JobContext): Promise<void> {
    const notification = this.#registry.get(payload.notification);
    // Renamed or removed by a deploy — or this worker runs an older version (a rolling deploy): retried by its tries.
    if (!notification) throw new NotificationError(`No notification "${payload.notification}" in this app — was it renamed or removed?`);
    const result = await notification.schema['~standard'].validate(payload.data);
    // A deploy changed the schema: it never will match — failed at once, like a job's payload (E84).
    if (result.issues) {
      return job.fail(new NotificationDataError(`The data of ${payload.notification} no longer matches its static schema: ${describeIssues(result.issues)}`, result.issues));
    }
    try {
      const outcome = await this.#deliverer.deliver(this.#resolver, { id: payload.id, notification, recipient: payload.recipient, data: result.value });
      if (outcome === 'gone') job.discard(`the ${payload.recipient.type} ${payload.recipient.id} of ${payload.notification} no longer exists`);
    } catch (error) {
      // A channel the app does not have will not appear by trying again.
      if (error instanceof NotificationChannelError) return job.fail(error);
      throw error;
    }
  }
}
