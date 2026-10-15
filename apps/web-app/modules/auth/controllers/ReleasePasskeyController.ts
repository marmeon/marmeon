import type { Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { abort, Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const ReleasePasskeyRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

/** Lets a suspended passkey (a sign count that went backwards: possibly a clone) sign in again — with the password typed now. */
export class ReleasePasskeyController extends Controller {
  static request = ReleasePasskeyRequest;

  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ReleasePasskeyRequest> & Authenticated & { params: { passkey: string } }) {
    const id = /^\d{1,15}$/.test(ctx.params.passkey) ? Number(ctx.params.passkey) : 0;
    const done = await this.#passkeys.release(id, ctx.body.password);
    if (done.ok) return this.json({ released: id });
    switch (done.error.kind) {
      case 'not-found':
        return abort(404);
      case 'throttled':
        return this.json({ field: 'password', error: done.error.account ? this.#translator.get('auth.validation.throttled_account') : this.#translator.get('auth.validation.throttled', { seconds: done.error.retryAfter }) }, 429);
      case 'invalid-password':
        return this.json({ field: 'password', error: this.#translator.get('auth.validation.password_incorrect') }, 422);
    }
  }
}
