import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Translators } from '@marmeon/i18n';
import { UserRepository } from '#modules/auth';

/** `ada@example.com` → `a…@example.com`: the page is opened by whoever holds the link, so it does not show the whole address. */
const mask = (email: string) => {
  const at = email.lastIndexOf('@');
  return at < 1 ? '…' : `${email[0]}…${email.slice(at)}`;
};

/**
 * The page behind the link in a digest mail's text: a button whose form posts to the same signed address. It leaves nothing itself, so
 * a scanner or a prefetch that opens every link of a mail unsubscribes nobody.
 */
export class ConfirmUnsubscribeController extends Controller {
  readonly #users: UserRepository;
  readonly #translators: Translators;

  constructor(users: UserRepository, translators: Translators) {
    super();
    this.#users = users;
    this.#translators = translators;
  }

  async handle(ctx: HttpContext<{}, { user: string }>) {
    const user = await this.#users.findByRouteKey(ctx.params.user);
    if (!user) abort(404);
    const t = this.#translators.for(user.locale);
    const url = new URL(ctx.request.url);
    return this.view('notifications/ConfirmUnsubscribe', {
      title: t.get('notifications.mail.digest.page_title'),
      body: t.get('notifications.mail.digest.page_body', { email: mask(user.email) }),
      button: t.get('notifications.mail.digest.page_button'),
      action: url.pathname + url.search,
    });
  }
}
