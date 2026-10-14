import { can, Gate, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { Storage } from '@marmeon/storage';
import type { User } from '#modules/auth';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileDirectory } from '../ProfileDirectory.ts';

/** The layer's own authorization, whatever page it opens over: only your own profile. */
export const EditUserProfileRequest = defineRequest({ authorize: can(ProfilePolicy, 'update', 'user') });

/**
 * Editing a profile — a layer: opened from a page, it shows over that page (a modal), with a history entry of its own
 * (Back closes it). A deep link or a reload of `/users/:user/edit` shows its base, the profile, under it.
 */
export class EditUserProfileController extends Controller {
  static request = EditUserProfileRequest;

  readonly #session: Session;
  readonly #gate: Gate;
  readonly #directory: ProfileDirectory;
  readonly #storage: Storage;

  constructor(session: Session, gate: Gate, directory: ProfileDirectory, storage: Storage) {
    super();
    this.#session = session;
    this.#gate = gate;
    this.#directory = directory;
    this.#storage = storage;
  }

  async handle(ctx: ContextOf<typeof EditUserProfileRequest> & Authenticated & { params: { user: User } }) {
    const { user } = ctx.params;

    return this.view('user-profile/Edit', {
      // The layer's own projection: each link with `can.delete` — a region asks its own policies.
      profile: {
        public_id: user.public_id,
        name: user.name,
        bio: user.bio,
        // The picture as it is now — the upload's own preview (blob:) shows over it while a new one is chosen.
        avatar: user.avatar_path ? this.#storage.disk('public').url(user.avatar_path) : null,
        links: (await this.#gate.withAbilities(await this.#directory.links(user.id), ProfileLinkPolicy, ['delete'])).map(({ user_id: _owner, ...link }) => link),
      },
      // A failed submit without JavaScript comes back here: refill the fields from old().
      old: this.#session.old() as { name?: string; bio?: string },
    }).layer({ base: 'user-profile.show', params: { user: user.public_id } });
  }
}
