import type { Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { abort, Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const RenamePasskeyRequest = defineRequest({
  schema: r.object({ name: r.string().trim().required().max(100) }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/** Renames a passkey of the signed-in user; someone else's id is a 404, like one that does not exist. */
export class RenamePasskeyController extends Controller {
  static request = RenamePasskeyRequest;

  readonly #passkeys: Passkeys;

  constructor(passkeys: Passkeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle(ctx: ContextOf<typeof RenamePasskeyRequest> & { params: { passkey: string } }) {
    const id = /^\d{1,15}$/.test(ctx.params.passkey) ? Number(ctx.params.passkey) : 0;
    if (!(await this.#passkeys.rename(id, ctx.body.name))) abort(404);
    return this.json({ renamed: id });
  }
}
