import { abort, Controller, type HttpContext } from '@marmeon/http';
import { UserRepository } from '#modules/auth';
import { OptOutRepository } from '../OptOutRepository.ts';

/**
 * Leaving the digest mails, from the link in a mail. A mail client posts here (`List-Unsubscribe-Post`) with no cookie and no CSRF
 * token, so the link is all this uses: it names the account, and neither the session's user nor the body play a part.
 */
export class UnsubscribeController extends Controller {
  readonly #users: UserRepository;
  readonly #optOuts: OptOutRepository;

  constructor(users: UserRepository, optOuts: OptOutRepository) {
    super();
    this.#users = users;
    this.#optOuts = optOuts;
  }

  async handle(ctx: HttpContext<{}, { user: string }>) {
    const user = await this.#users.findByRouteKey(ctx.params.user);
    if (!user) abort(404);
    await this.#optOuts.add(user.id, new Date());
    return this.json({ unsubscribed: true });
  }
}
