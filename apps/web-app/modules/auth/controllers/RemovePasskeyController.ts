import type { Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { abort, Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const RemovePasskeyRequest = defineRequest({
  // Needed for every passkey: typed now, however recently a password or a passkey confirmed sudo mode.
  schema: r.object({ password: r.string().max(4096).default('') }),
});

/** Removes a passkey of the signed-in user. The password is asked for every passkey; the last factor takes the recovery codes along, and the other devices are signed out. */
export class RemovePasskeyController extends Controller {
  static request = RemovePasskeyRequest;

  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RemovePasskeyRequest> & Authenticated & { params: { passkey: string } }) {
    const id = /^\d{1,15}$/.test(ctx.params.passkey) ? Number(ctx.params.passkey) : 0;
    const done = await this.#passkeys.remove(id, ctx.body.password === '' ? undefined : ctx.body.password);
    if (done.ok) {
      return this.json({ removed: id }).flash('toast', { kind: 'success', message: this.#translator.get('auth.passkeys.removed') });
    }
    switch (done.error.kind) {
      case 'not-found':
        return abort(404);
      case 'throttled':
        return this.json({ field: 'password', error: passwordCheckMessage(this.#translator, done.error) }, 429);
      case 'invalid-password':
        return this.json({ field: 'password', error: passwordCheckMessage(this.#translator, done.error) }, 422);
    }
  }
}
