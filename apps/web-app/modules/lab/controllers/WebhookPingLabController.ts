import { Logger } from '@marmeon/core';
import { FetchError, HttpClient } from '@marmeon/fetch';
import { defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { LabConfig } from '../config.ts';
import { LabGate } from './ValidationLabController.ts';
import { LabController } from './ShowLabPageController.ts';

/** What every failed ping says, whatever the reason. */
const PING_FAILED = 'The address could not be pinged.';

/** A form that takes an address an editor typed and calls it: the one place the lab sends a request to a stranger. */
export class ShowWebhookPingLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/WebhookPing', {});
  }
}

export const WebhookPingLabRequest = defineRequest({
  // The rule checks the form of the address. What decides whether it may be reached is the client, when it sends.
  schema: r.object({ url: r.string().trim().url() }),
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

export class PingWebhookLabController extends LabController {
  static request = WebhookPingLabRequest;
  readonly #http: HttpClient;
  readonly #logger: Logger;

  constructor(config: LabConfig, http: HttpClient, logger: Logger) {
    super(config);
    this.#http = http;
    this.#logger = logger.child({ channel: 'lab' });
  }

  async handle(ctx: ContextOf<typeof WebhookPingLabRequest>) {
    this.enabled();
    try {
      const response = await this.#http.fetch(ctx.body.url, { method: 'POST', json: { ping: true }, timeout: 5 });
      void response.body?.cancel();
      return this.redirect('/lab/webhook-ping').flash('toast', { kind: 'success', message: `The address answered ${response.status}.` });
    } catch (error) {
      // The form is open to everyone, so one answer for every failure: the reason (refused, network, …) would tell a stranger what this
      // server's resolver and network can reach. The reason goes to the log.
      if (error instanceof FetchError) {
        this.#logger.warn('A ping failed.', { reason: error.reason });
        throw new ValidationError({ url: [PING_FAILED] }, ctx.body);
      }
      throw error;
    }
  }
}
