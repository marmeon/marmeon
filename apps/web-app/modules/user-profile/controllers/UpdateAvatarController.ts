import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Translator } from '@bespokecore/i18n';
import { Storage, upload } from '@bespokecore/storage';
import * as v from 'valibot';
import { UserRepository } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';

/**
 * The avatar (W6.9): the file was uploaded ahead (`<FileInput>` in the edit layer, to the private `uploads` disk) — the form
 * sends its token. The rule checks it on submit: this session, this route and field, not expired, not used; at most 2 MB;
 * PNG, JPEG or WebP **by its bytes** (an HTML file named `.png` is refused, SVG never). The same policy as the profile: the
 * upload target was handed out by this route's `authorize` too.
 */
export const UpdateAvatarRequest = defineRequest({
  schema: v.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class UpdateAvatarController extends Controller {
  static request = UpdateAvatarRequest;

  readonly #users: UserRepository;
  readonly #storage: Storage;
  readonly #translator: Translator;

  constructor(users: UserRepository, storage: Storage, translator: Translator) {
    super();
    this.#users = users;
    this.#storage = storage;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdateAvatarRequest>) {
    const { user } = ctx.params;
    const disk = this.#storage.disk('public');
    const previous = (await this.#users.find(user.id))?.avatar_path;
    // Uses the upload up (once — a second submit of the same token is a 422) and moves it: avatars/<random>.<its type>.
    const path = await ctx.body.avatar.store(disk, 'avatars');
    await this.#users.update(user.id, { avatar_path: path });
    // The picture it replaces goes (a failure here leaves a file nobody links to — nothing worse).
    if (previous) await disk.delete(previous).catch(() => false);
    return this.closeLayer({ reload: ['profile'] })
      .route('user-profile.show', { user: user.id })
      .flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.avatar_saved') });
  }
}
