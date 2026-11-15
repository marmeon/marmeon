import { Controller, type HttpContext } from '@marmeon/http';
import { OfficeAuth } from './guard.ts';
import type { OfficeUser } from './OfficeUser.ts';

/**
 * Signs the editor out of another of their browsers. Behind the sudo mode: a stolen session must not end its owner's others. An id that
 * is gone and one that is somebody else's get the same answer.
 */
export class EndSessionController extends Controller {
  static readonly inject = [OfficeAuth] as const;

  readonly #auth: OfficeAuth;

  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }

  async handle(ctx: HttpContext<{ readonly user: OfficeUser }, { signIn: string }>) {
    await this.#auth.endSignIn(ctx.params.signIn);
    return this.redirect().route('office.sessions');
  }
}
