import { Controller, type HttpContext, type WebhookContext } from '@marmeon/http';

/**
 * A payment provider's event. By the time this runs `verifyWebhook('payments')` has checked the signature and the time:
 * `ctx.webhook` holds the verified body, and `ctx.input()` parses the same bytes. A sender repeats an event until it gets a `2xx`,
 * so the real work belongs behind a check of the event's id.
 */
export class ReceivePaymentEventController extends Controller {
  async handle(ctx: HttpContext<{ webhook: WebhookContext }>) {
    const { type } = await ctx.input();
    return this.json({ received: typeof type === 'string' ? type : null });
  }
}
