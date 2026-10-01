import { AuthConfig, PasswordBroker } from '@bespokecore/auth';
import { AfterResponse, Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Mailer } from '@bespokecore/mail';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { ResetPasswordMail } from '../mail/ResetPasswordMail.ts';

export const SendPasswordResetLinkRequest = defineRequest({
  schema: v.object({
    email: v.pipe(v.string('Enter your e-mail address.'), v.trim(), v.toLowerCase(), v.maxLength(255), v.email('Enter a valid e-mail address.')),
  }),
});

export class SendPasswordResetLinkController extends Controller {
  static request = SendPasswordResetLinkRequest;

  readonly #broker: PasswordBroker;
  readonly #mailer: Mailer;
  readonly #afterResponse: AfterResponse;
  readonly #app: AppConfig;
  readonly #auth: AuthConfig;

  constructor(broker: PasswordBroker, mailer: Mailer, afterResponse: AfterResponse, app: AppConfig, auth: AuthConfig) {
    super();
    this.#broker = broker;
    this.#mailer = mailer;
    this.#afterResponse = afterResponse;
    this.#app = app;
    this.#auth = auth;
  }

  handle(ctx: ContextOf<typeof SendPasswordResetLinkRequest>) {
    const { email } = ctx.body;
    // After the response: known or unknown address, the answer is the same — in content and in time.
    this.#afterResponse.defer(async () => {
      const reset = await this.#broker.createToken(email);
      if (!reset) return;
      // The token rides in the query (the request log shows paths only); the link page moves it into a cookie.
      const url = new URL('/reset-password', this.#app.url);
      url.searchParams.set('token', reset.token);
      url.searchParams.set('email', email);
      await this.#mailer.send(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire));
    });
    return this.back('/forgot-password').with('status', 'If an account exists for that address, we sent a link to reset its password.');
  }
}
