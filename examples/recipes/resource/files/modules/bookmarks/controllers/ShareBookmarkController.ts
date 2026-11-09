import { UserRepository } from '#modules/auth';
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { BookmarkPolicy } from '../policies/BookmarkPolicy.ts';

export const ShareBookmarkRequest = defineRequest({
  // Only the format of the address is checked here, never whether an account has it.
  schema: r.object({ email: r.string().trim().lowercase().required().max(255).email() }),
  authorize: can(BookmarkPolicy, 'update', 'bookmark'),
});

/** Shares one of the user's bookmarks with the person who has this address, if there is one. */
export class ShareBookmarkController extends Controller {
  static request = ShareBookmarkRequest;

  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  async handle(ctx: ContextOf<typeof ShareBookmarkRequest>) {
    const user = await this.#users.findByEmail(ctx.body.email);
    // An account whose address is not confirmed counts as not found: private registration lets anybody sign up with somebody
    // else's address. The bookmark is `ctx.params.bookmark`. Write the share with `tryInsert()` and treat its `duplicate` as
    // success, so an address that already has it, or the user's own, gets the same answer.
    if (user?.email_verified_at) {
      // Share the bookmark with `user`, or queue a mail to their address.
    }
    // The same answer, found or not.
    return this.redirect().route('bookmarks.index').flash('toast', { kind: 'success', message: 'If that address has an account, the bookmark is shared.' });
  }
}
