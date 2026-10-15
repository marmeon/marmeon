import { Auth, type Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { abort, Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const RemovePasskeyRequest = defineRequest({
  // Needed for every passkey: typed now, however recently a password or a passkey confirmed sudo mode.
  schema: r.object({ password: r.string().max(4096).default('') }),
});

/** Removes a passkey of the signed-in user. The password is asked for every passkey; the last factor takes the recovery codes along. */
export class RemovePasskeyController extends Controller {
  static request = RemovePasskeyRequest;

  readonly #auth: Auth;
  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(auth: Auth, passkeys: Passkeys, translator: Translator) {
    super();
    this.#auth = auth;
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RemovePasskeyRequest> & Authenticated & { params: { passkey: string } }) {
    const id = /^\d{1,15}$/.test(ctx.params.passkey) ? Number(ctx.params.passkey) : 0;
    const done = await this.#passkeys.remove(id, ctx.body.password === '' ? undefined : ctx.body.password);
    if (done.ok) {
      // The password was just typed: whatever a stolen passkey started on other devices ends with this, as when a password changes.
      await this.#auth.logoutOtherDevices(ctx.body.password);
      return this.json({ removed: id }).flash('toast', { kind: 'success', message: this.#translator.get('auth.passkeys.removed') });
    }
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
