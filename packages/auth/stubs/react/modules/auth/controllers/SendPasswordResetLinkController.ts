import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { trans, Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import * as v from 'valibot';
import { SendPasswordResetLinkJob } from '../jobs/SendPasswordResetLinkJob.ts';

export const SendPasswordResetLinkRequest = defineRequest({
  schema: v.object({
    email: v.pipe(v.string(trans('auth.validation.email_required')), v.trim(), v.toLowerCase(), v.maxLength(255), v.email(trans('auth.validation.email_invalid'))),
  }),
});

export class SendPasswordResetLinkController extends Controller {
  static request = SendPasswordResetLinkRequest;

  readonly #queue: Queue;
  readonly #translator: Translator;

  constructor(queue: Queue, translator: Translator) {
    super();
    this.#queue = queue;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof SendPasswordResetLinkRequest>) {
    // Known or unknown address, the request does the same — queue one job — so the answer is the same in content and
    // in time. The job looks the account up, makes the token and queues the mail.
    await this.#queue.dispatch(SendPasswordResetLinkJob, { email: ctx.body.email, locale: this.#translator.locale }, { queue: 'mail' });
    return this.back('/forgot-password').flash('toast', { kind: 'success', message: this.#translator.get('auth.forgot.sent') });
  }
}
