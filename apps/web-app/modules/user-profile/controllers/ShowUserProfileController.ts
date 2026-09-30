import { paginationFrom } from '@bespokecore/database';
import { Controller, type HttpContext } from '@bespokecore/http';
import type { AuthState } from '#modules/auth';
import { ProfileDirectory, type Profile } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  readonly #directory: ProfileDirectory;

  constructor(directory: ProfileDirectory) {
    super();
    this.#directory = directory;
  }

  /** `user` is bound by the route (ProfileDirectory): a missing one never gets here — it is a 404. */
  async handle(ctx: HttpContext<AuthState, { user: Profile }>) {
    const { user } = ctx.params;
    const filter = ctx.query.get('q')?.trim() ?? '';
    const people = await this.#directory.people({ search: filter, except: user.id, ...paginationFrom(ctx.query, { perPage: 5, maxPerPage: 50 }) });
    const isOwnProfile = ctx.user.id === user.id;

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio, links: user.links },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: isOwnProfile ? user.email : null,
      isOwnProfile,
      lastLoginAt: user.activity?.last_login_at ?? null,
      filter,
      others: {
        data: people.data.map((person) => ({ id: person.id, name: person.name, lastLoginAt: person.activity?.last_login_at ?? null })),
        meta: people.meta,
      },
      // The server's clock for "5 minutes ago": SSR and hydration compute the same text. A Date here,
      // a string in the view (PageProps are serialized).
      now: new Date(),
    });
  }
}
