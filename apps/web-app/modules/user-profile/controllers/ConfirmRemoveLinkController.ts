import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';

export const ConfirmRemoveLinkRequest = defineRequest({
  // Its own authorization: only for your own links — whatever it opens over.
  authorize: can(ProfileLinkPolicy, 'delete', 'link'),
});

/**
 * "Remove this link?" — a layer over whatever is on screen: the profile (depth 1), or the edit layer (depth 2). A deep
 * link stacks it on its base, the edit layer — and that one on the profile.
 */
export class ConfirmRemoveLinkController extends Controller {
  static request = ConfirmRemoveLinkRequest;

  handle(ctx: ContextOf<typeof ConfirmRemoveLinkRequest> & { params: { user: { id: number }; link: Row<'profile_links'> } }) {
    const { link, user } = ctx.params;
    return this.view('user-profile/RemoveLink', { link: { id: link.id, label: link.label, url: link.url }, userId: user.id }).layer({
      base: 'user-profile.edit',
      params: { user: user.id },
    });
  }
}
