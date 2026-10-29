import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Broadcaster } from '@marmeon/live';
import { Translator } from '@marmeon/i18n';
import { Storage, upload } from '@marmeon/storage';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { profileChannel } from '../live.ts';

/**
 * The avatar: the file was uploaded ahead (`<FileInput>` in the edit layer, to the private `uploads` disk) — the form
 * sends its token. The rule checks it on submit: this session, this route and field, not expired, not used; at most 2 MB;
 * PNG, JPEG or WebP **by its bytes** (an HTML file named `.png` is refused, SVG never). The same policy as the profile: the
 * upload target was handed out by this route's `authorize` too.
 */
export const UpdateAvatarRequest = defineRequest({
  schema: r.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class UpdateAvatarController extends Controller {
  static request = UpdateAvatarRequest;

  readonly #users: UserRepository;
  readonly #storage: Storage;
  readonly #translator: Translator;
  readonly #broadcast: Broadcaster;

  constructor(users: UserRepository, storage: Storage, translator: Translator, broadcast: Broadcaster) {
    super();
    this.#users = users;
    this.#storage = storage;
    this.#translator = translator;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof UpdateAvatarRequest> & { params: { user: Row<'users'> } }) {
    const { user } = ctx.params;
    const disk = this.#storage.disk('public');
    const previous = (await this.#users.find(user.id))?.avatar_path;
    // The size is read from the file's first bytes before store() moves it; a file whose header says nothing keeps none.
    const size = await ctx.body.avatar.dimensions();
    // Uses the upload up (once — a second submit of the same token is a 422) and moves it: avatars/<random>.<its type>.
    const path = await ctx.body.avatar.store(disk, 'avatars');
    await this.#users.update(user.id, { avatar_path: path, avatar_width: size?.width ?? null, avatar_height: size?.height ?? null });
    // Live: the profile's other tabs reload it — not this one (x-marmeon-connection), it shows its own answer.
    await this.#broadcast.refresh(profileChannel(user.public_id), { only: ['profile'] });
    // The picture it replaces goes (a failure here leaves a file nobody links to — nothing worse).
    if (previous) await disk.delete(previous).catch(() => false);
    return this.closeLayer({ reload: ['profile'] })
      .route('user-profile.show', { user: user.public_id })
      .flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.avatar_saved') });
  }
}
