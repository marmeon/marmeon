import { Repository } from '@marmeon/database';

/** The events that were handled, by the id the sender gave them. The unique index on `event_id` is what makes a repeat visible. */
export class WebhookEventRepository extends Repository<'webhook_events'> {
  static table = 'webhook_events' as const;
}
