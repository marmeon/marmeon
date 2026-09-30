import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { UserRepository, type AuthState } from '#modules/auth';
import { LoginActivityRepository } from '../LoginActivityRepository.ts';

export class ShowUserProfileController extends Controller {
  readonly #users: UserRepository;
  readonly #activity: LoginActivityRepository;

  constructor(users: UserRepository, activity: LoginActivityRepository) {
    super();
    this.#users = users;
    this.#activity = activity;
  }

  async handle(ctx: HttpContext<AuthState, { id: string }>) {
    const id = Number(ctx.params.id);
    const user = Number.isSafeInteger(id) ? await this.#users.find(id) : undefined;
    if (!user) abort(404, 'User not found.');
    const filter = ctx.query.get('q')?.trim() ?? '';

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: ctx.user.id === user.id ? user.email : null,
      isOwnProfile: ctx.user.id === user.id,
      lastLoginAt: (await this.#activity.lastLogin(user.id)) ?? null,
      filter,
      others: await this.#users.list({ search: filter, except: user.id }),
    });
  }
}
