import type { Container, Resolver, StandardSchemaV1 } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import { NotificationChannelError, type NotificationDeliverer } from './notifications.ts';
import { NotificationError, NotificationRegistry } from './registry.ts';
import { describeFields, NotificationDataError } from './validate.ts';

/** What a queued notification carries: its id, its name, the recipient as data and the data as JSON. */
export interface QueuedNotificationPayload {
  id: string;
  notification: string;
  recipient: { type: string; id: string | number };
  data: unknown;
}

/** @internal The validation behind `SendQueuedNotification.schema`; the type tests compare its output with `QueuedNotificationPayload`. */
export const queuedNotificationSchema = v.object({
  id: v.string(),
  notification: v.string(),
  recipient: v.object({ type: v.string(), id: v.union([v.string(), v.number()]) }),
  data: v.unknown(),
});

/**
 * The framework job behind `notifications.send()`: one notification for one recipient. **Encrypted** — a
 * notification's data is the app's and may say more than IDs. A notification this worker has no name for, or whose data its
 * schema rejects, waits for a worker that does (a rolling deploy) like any job it cannot read; a recipient that is gone
 * discards the job, and a retry after a committed delivery finds its row and stops.
 */
export class SendQueuedNotification {
  static readonly job = 'marmeon.notification';
  static readonly schema: StandardSchemaV1<QueuedNotificationPayload> = queuedNotificationSchema;
  static readonly encrypted = true;
  static readonly tries = 3;
  static readonly backoff = [10, 60, 300];

  readonly #resolver: Resolver;
  readonly #deliverer: NotificationDeliverer;
  readonly #registry: NotificationRegistry;

  /** @internal The container builds the job. */
  constructor(resolver: Resolver, deliverer: NotificationDeliverer, registry: NotificationRegistry) {
    this.#resolver = resolver;
    this.#deliverer = deliverer;
    this.#registry = registry;
  }

  async handle(payload: QueuedNotificationPayload, job: JobContext): Promise<void> {
    const notification = this.#registry.get(payload.notification);
    // The worker held such a job before it got here (the provider attaches `heldReason` as the queue's hook); this is for a registry that changed in between.
    if (!notification) throw new NotificationError(`No notification "${payload.notification}" in this app — was it renamed or removed?`);
    const result = await notification.schema['~standard'].validate(payload.data);
    if (result.issues) {
      return job.fail(new NotificationDataError(`The data of ${payload.notification} does not match its static schema (fields: ${describeFields(result.issues)}).`, result.issues));
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

/**
 * @internal The queue asks this before the job runs (`@marmeon/queue/internal`'s `TARGET_UNKNOWN`; attached when the provider
 * registers the job, as the queue is optional): why this worker cannot run it, if so — no notification of that name (renamed,
 * removed, or this worker is older), or its schema rejects the data (a newer release changed it). The job is then held, not
 * failed; the reason names fields, never values: the data is encrypted. The data is validated twice (here and in `handle`),
 * and a schema that throws holds the job too.
 */
export async function heldReason(container: Container, payload: QueuedNotificationPayload): Promise<string | undefined> {
  const notification = container.make(NotificationRegistry).get(payload.notification);
  if (!notification) return `No notification "${payload.notification}" in this app — was it renamed or removed, or does a newer release send it?`;
  const result = await notification.schema['~standard'].validate(payload.data);
  return result.issues ? `The data of ${payload.notification} does not match its static schema (fields: ${describeFields(result.issues)}).` : undefined;
}
