import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Broadcaster } from '@bespokecore/live';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { UserRepository } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { profileChannel } from '../live.ts';

/** REPR: what the endpoint accepts and who may call it — next to the endpoint itself. */
export const UpdateUserProfileRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(2, trans('user-profile.validation.name_min')), v.maxLength(60)),
    bio: v.pipe(v.string(), v.trim(), v.maxLength(200, trans('user-profile.validation.bio_max'))),
  }),
  // Only your own profile (ProfilePolicy). Runs after binding, before validation — others get a 403, not field errors.
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class UpdateUserProfileController extends Controller {
  static request = UpdateUserProfileRequest;

  readonly #users: UserRepository;
  readonly #translator: Translator;
  readonly #broadcast: Broadcaster;

  constructor(users: UserRepository, translator: Translator, broadcast: Broadcaster) {
    super();
    this.#users = users;
    this.#translator = translator;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof UpdateUserProfileRequest>) {
    // ctx.body is { name: string; bio: string } — validated and trimmed
    await this.#users.update(ctx.params.user.id, ctx.body);
    // Live (W6.10): the profile's other tabs reload it — not this one (x-bespoke-connection), it shows its own answer.
    await this.#broadcast.refresh(profileChannel(ctx.params.user.id), { only: ['profile'] });
    // Saved from the edit layer: it closes, and what is beneath shows the new name (and the message). Without JavaScript
    // (or the form opened as a page): to the profile.
    return this.closeLayer({ reload: ['profile'] })
      .route('user-profile.show', { user: ctx.params.user.id })
      .flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.saved') });
  }
}
