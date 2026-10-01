import { Controller, defer, optional, type HttpContext } from '@bespokecore/http';
import { Gate, type Authenticated } from '@bespokecore/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileActivity } from '../ProfileActivity.ts';
import { ProfileDirectory, type Profile } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  readonly #directory: ProfileDirectory;
  readonly #activity: ProfileActivity;
  readonly #gate: Gate;

  constructor(directory: ProfileDirectory, activity: ProfileActivity, gate: Gate) {
    super();
    this.#directory = directory;
    this.#activity = activity;
    this.#gate = gate;
  }

  /** `user` is bound by the route (ProfileDirectory): a missing one never gets here — it is a 404. */
  async handle(ctx: HttpContext<Authenticated, { user: Profile }>) {
    // The selected row goes to the view as it is — the migration's column types reach the view.
    // Held back on purpose: the e-mail (owner only) and the last sign-in (shown as lastLoginAt).
    const { email, activity: login, ...user } = ctx.params.user;
    const isOwnProfile = ctx.user.id === user.id;

    return this.view('user-profile/Show', {
      profile: user,
      // Only the owner may see their e-mail (ProfilePolicy) — the controller decides what leaves the server.
      email: (await this.#gate.allows(ProfilePolicy, 'viewEmail', user)) ? email : null,
      isOwnProfile,
      // What the page may offer — explicit, from the policies (E28). The server checks again on every action.
      can: { update: await this.#gate.allows(ProfilePolicy, 'update', user) },
      lastLoginAt: login?.last_login_at ?? null,
      // Loaded after the page (E7): the page renders without it, the browser asks for it next — `<Deferred data="activity">`.
      activity: defer(() => this.#activity.recent(user.id)),
      // Never in a full response, only when the page asks — `reload({ only: ['stats'] })` behind "Show statistics".
      // Asking for it by name passes the same middleware and the same controller: it can only be what this page may show.
      stats: optional(() => this.#directory.stats(user.id)),
      // The server's clock for "5 minutes ago": SSR and hydration compute the same text. A Date here,
      // a string in the view (PageProps are serialized).
      now: new Date(),
    });
  }
}
