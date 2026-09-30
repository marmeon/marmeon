import { abort, Controller, type HttpContext } from '@bespokecore/http';
import type { AuthState } from '#modules/auth';
import { ProfileDirectory } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  readonly #directory: ProfileDirectory;

  constructor(directory: ProfileDirectory) {
    super();
    this.#directory = directory;
  }

  async handle(ctx: HttpContext<AuthState, { id: string }>) {
    const id = Number(ctx.params.id);
    const user = Number.isSafeInteger(id) ? await this.#directory.profile(id) : undefined;
    if (!user) abort(404, 'User not found.');
    const filter = ctx.query.get('q')?.trim() ?? '';
    const people = await this.#directory.people({ search: filter, except: user.id });

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: ctx.user.id === user.id ? user.email : null,
      isOwnProfile: ctx.user.id === user.id,
      lastLoginAt: user.activity?.last_login_at ?? null,
      filter,
      others: people.map((person) => ({ id: person.id, name: person.name, lastLoginAt: person.activity?.last_login_at ?? null })),
      // The server's clock for "5 minutes ago": SSR and hydration compute the same text. A Date here,
      // a string in the view (PageProps are serialized).
      now: new Date(),
    });
  }
}
