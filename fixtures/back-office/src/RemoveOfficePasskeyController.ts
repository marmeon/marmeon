import { abort, Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficePasskeys } from './guard.ts';
import type { OfficeUser } from './OfficeUser.ts';
import { passwordMessage } from './password-message.ts';

export const RemovePasskeyRequest = defineRequest({
  // Needed for every passkey: typed now, however recently the sudo window was opened.
  schema: r.object({ password: r.string().max(4096).default('') }),
});

/** Removes a passkey of the signed-in editor. The password is asked for every passkey; the last factor takes the recovery codes along. */
export class RemoveOfficePasskeyController extends Controller {
  static request = RemovePasskeyRequest;
  static readonly inject = [OfficePasskeys, Translator] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;

  constructor(passkeys: OfficePasskeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RemovePasskeyRequest> & HttpContext<{ readonly user: OfficeUser }, { passkey: string }>) {
    const id = /^\d{1,15}$/.test(ctx.params.passkey) ? Number(ctx.params.passkey) : 0;
    const done = await this.#passkeys.remove(id, ctx.body.password);
    if (done.ok) return this.json({ removed: id });
    switch (done.error.kind) {
      case 'not-found':
        return abort(404);
      case 'throttled':
        return this.json({ field: 'password', error: passwordMessage(this.#translator, done.error) }, { status: 429 });
      case 'invalid-password':
        return this.json({ field: 'password', error: passwordMessage(this.#translator, done.error) }, { status: 422 });
    }
  }
}
