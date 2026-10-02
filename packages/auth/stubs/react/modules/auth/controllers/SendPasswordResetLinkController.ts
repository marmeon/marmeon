import { AuthConfig, PasswordBroker } from '@bespokecore/auth';
import { AfterResponse, Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import { Mailer } from '@bespokecore/mail';
import { Router } from '@bespokecore/router';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { ResetPasswordMail } from '../mail/ResetPasswordMail.ts';

export const SendPasswordResetLinkRequest = defineRequest({
  schema: v.object({
    email: v.pipe(v.string(trans('auth.validation.email_required')), v.trim(), v.toLowerCase(), v.maxLength(255), v.email(trans('auth.validation.email_invalid'))),
  }),
});

export class SendPasswordResetLinkController extends Controller {
  static request = SendPasswordResetLinkRequest;

  readonly #broker: PasswordBroker;
  readonly #mailer: Mailer;
  readonly #afterResponse: AfterResponse;
  readonly #app: AppConfig;
  readonly #auth: AuthConfig;
  readonly #router: Router;
  readonly #translator: Translator;

  constructor(broker: PasswordBroker, mailer: Mailer, afterResponse: AfterResponse, app: AppConfig, auth: AuthConfig, router: Router, translator: Translator) {
    super();
    this.#broker = broker;
    this.#mailer = mailer;
    this.#afterResponse = afterResponse;
    this.#app = app;
    this.#auth = auth;
    this.#router = router;
    this.#translator = translator;
  }

  handle(ctx: ContextOf<typeof SendPasswordResetLinkRequest>) {
    const { email } = ctx.body;
    // After the response: known or unknown address, the answer is the same — in content and in time.
    this.#afterResponse.defer(async () => {
      const reset = await this.#broker.createToken(email);
      if (!reset) return;
      // The token rides in the query (the request log shows paths only); the link page moves it into a cookie.
      const url = new URL(this.#router.url('auth.password.reset', {}, { token: reset.token, email }), this.#app.url);
      // In the account's language (whoever asked for the link, and in whatever language): the recipient's.
      await this.#mailer.send(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire, this.#translator.forLocale(reset.user.locale)));
    });
    return this.back('/forgot-password').flash('toast', { kind: 'success', message: this.#translator.get('auth.forgot.sent') });
  }
}
