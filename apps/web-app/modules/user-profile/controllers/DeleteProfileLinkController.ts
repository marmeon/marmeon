import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Translator } from '@bespokecore/i18n';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const DeleteProfileLinkRequest = defineRequest({
  // The route binds `link` scoped to `user` (another user's link id is a 404); the policy decides who may remove it.
  authorize: can(ProfileLinkPolicy, 'delete', 'link'),
});

export class DeleteProfileLinkController extends Controller {
  static request = DeleteProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #translator: Translator;

  constructor(links: ProfileLinkRepository, translator: Translator) {
    super();
    this.#links = links;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DeleteProfileLinkRequest> & { params: { user: { id: number } } }) {
    await this.#links.delete(ctx.params.link.id);
    // Confirmed in its layer: it closes, and what is beneath (the profile, or the edit layer) loses the link.
    return this.closeLayer({ reload: ['profile'] })
      .route('user-profile.show', { user: ctx.params.user.id })
      .flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.link_removed') });
  }
}
