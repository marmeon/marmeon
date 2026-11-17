import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Broadcaster } from '@marmeon/live';
import { profileChannel } from '../live.ts';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const FeatureProfileLinkRequest = defineRequest({
  // The profile's owner; the route looks the link up within that user, so another user's link id is a 404.
  authorize: can(ProfilePolicy, 'update', 'user'),
});

/** Features the link on the profile; the one featured before is unfeatured. */
export class FeatureProfileLinkController extends Controller {
  static request = FeatureProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #translator: Translator;
  readonly #broadcast: Broadcaster;

  constructor(links: ProfileLinkRepository, translator: Translator, broadcast: Broadcaster) {
    super();
    this.#links = links;
    this.#translator = translator;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof FeatureProfileLinkRequest, { user: Row<'users'>; link: Row<'profile_links'> }>) {
    const done = await this.#links.feature(ctx.params.link);
    const back = this.redirect().route('user-profile.links.index', { user: ctx.params.user.public_id });
    if (done.ok) {
      // Live: the profile's other tabs reload it — the order of the links changed.
      await this.#broadcast.refresh(profileChannel(ctx.params.user.public_id), { only: ['profile'] });
      return back.flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.link_featured') });
    }
    // `duplicate`: another link was featured at the same moment. `missing`: the link was removed after the route found it.
    const key = done.error.kind === 'duplicate' ? 'user-profile.status.link_feature_raced' : 'user-profile.status.link_gone';
    return back.flash('toast', { kind: 'error', message: this.#translator.get(key) });
  }
}
