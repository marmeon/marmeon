import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Broadcaster } from '@marmeon/live';
import { Translator } from '@marmeon/i18n';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { profileChannel } from '../live.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const DeleteProfileLinkRequest = defineRequest({
  // The route binds `link` scoped to `user` (another user's link id is a 404); the policy decides who may remove it.
  authorize: can(ProfileLinkPolicy, 'delete', 'link'),
});

export class DeleteProfileLinkController extends Controller {
  static request = DeleteProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #translator: Translator;
  readonly #broadcast: Broadcaster;

  constructor(links: ProfileLinkRepository, translator: Translator, broadcast: Broadcaster) {
    super();
    this.#links = links;
    this.#translator = translator;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof DeleteProfileLinkRequest> & { params: { user: Row<'users'>; link: Row<'profile_links'> } }) {
    await this.#links.delete(ctx.params.link.id);
    // Live: the profile's other tabs reload it — not this one (x-marmeon-connection), it shows its own answer.
    await this.#broadcast.refresh(profileChannel(ctx.params.user.public_id), { only: ['profile'] });
    // Confirmed in its layer: it closes, and what is beneath (the profile, or the edit layer) loses the link.
    return this.closeLayer({ reload: ['profile'] })
      .route('user-profile.show', { user: ctx.params.user.public_id })
      .flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.link_removed') });
  }
}
