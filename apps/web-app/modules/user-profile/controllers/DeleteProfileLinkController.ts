import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const DeleteProfileLinkRequest = defineRequest({
  schema: v.object({}),
  // The route binds `link` scoped to `user` (another user's link id is a 404); the policy decides who may remove it.
  authorize: can(ProfileLinkPolicy, 'delete', 'link'),
});

export class DeleteProfileLinkController extends Controller {
  static request = DeleteProfileLinkRequest;

  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    super();
    this.#links = links;
  }

  async handle(ctx: ContextOf<typeof DeleteProfileLinkRequest> & { params: { user: { id: number } } }) {
    await this.#links.delete(ctx.params.link.id);
    return this.redirect().route('user-profile.show', { user: ctx.params.user.id }).with('status', 'Link removed.');
  }
}
