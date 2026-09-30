import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import * as v from 'valibot';
import { UserRepository, type AuthState } from '#modules/auth';

/** REPR: what the endpoint accepts and who may call it — next to the endpoint itself. */
export const UpdateUserProfileRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(2, 'The name needs at least 2 characters.'), v.maxLength(60)),
    bio: v.pipe(v.string(), v.trim(), v.maxLength(200, 'The bio may have at most 200 characters.')),
  }),
  // Only your own profile. Runs before validation — others get a 403, not field errors.
  authorize: (ctx: HttpContext<AuthState, { id: string }>) => ctx.user.id === ctx.params.id,
});

export class UpdateUserProfileController extends Controller {
  static request = UpdateUserProfileRequest;

  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle(ctx: ContextOf<typeof UpdateUserProfileRequest>) {
    // ctx.body is { name: string; bio: string } — validated and trimmed
    this.#users.update(ctx.params.id, ctx.body);
    return this.redirect().route('user-profile.show', { id: ctx.params.id }).with('status', 'Profile saved.');
  }
}
