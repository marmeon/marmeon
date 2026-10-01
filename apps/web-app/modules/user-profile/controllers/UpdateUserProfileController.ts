import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';
import { UserRepository } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';

/** REPR: what the endpoint accepts and who may call it — next to the endpoint itself. */
export const UpdateUserProfileRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(2, 'The name needs at least 2 characters.'), v.maxLength(60)),
    bio: v.pipe(v.string(), v.trim(), v.maxLength(200, 'The bio may have at most 200 characters.')),
  }),
  // Only your own profile (ProfilePolicy). Runs after binding, before validation — others get a 403, not field errors.
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class UpdateUserProfileController extends Controller {
  static request = UpdateUserProfileRequest;

  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  async handle(ctx: ContextOf<typeof UpdateUserProfileRequest>) {
    // ctx.body is { name: string; bio: string } — validated and trimmed
    await this.#users.update(ctx.params.user.id, ctx.body);
    return this.redirect().route('user-profile.show', { user: ctx.params.user.id }).with('status', 'Profile saved.');
  }
}
