import { Controller, defer, optional, type HttpContext } from '@marmeon/http';
import { Gate, type Authenticated } from '@marmeon/auth';
import { Storage } from '@marmeon/storage';
import { ProfileLinkPolicy } from '../policies/ProfileLinkPolicy.ts';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileActivity } from '../ProfileActivity.ts';
import { ProfileDirectory, type Profile } from '../ProfileDirectory.ts';
import { profileChannel } from '../live.ts';

export class ShowUserProfileController extends Controller {
  /**
   * What a link may show of the profile at once (an instant visit) — the name it already lists: `<Link instant={{ name }}>`.
   * The view's placeholder gets exactly this; the profile itself renders only with the server's answer.
   */
  declare readonly instant: { name: string };

  readonly #directory: ProfileDirectory;
  readonly #activity: ProfileActivity;
  readonly #gate: Gate;
  readonly #storage: Storage;

  constructor(directory: ProfileDirectory, activity: ProfileActivity, gate: Gate, storage: Storage) {
    super();
    this.#directory = directory;
    this.#activity = activity;
    this.#gate = gate;
    this.#storage = storage;
  }

  /** `user` is bound by the route (ProfileDirectory): a missing one never gets here — it is a 404. */
  async handle(ctx: HttpContext<Authenticated, { user: Profile }>) {
    // This route serves every confirmed account for any user, so only what the page shows leaves the server: an explicit
    // list, never the row. The rest (a pending e-mail, locale, verification times) stays here, and so do the e-mail
    // (owner only) and the last sign-in (shown as lastLoginAt).
    // The avatar as its public URL (the public disk serves it: raster images only, `nosniff`) — never the storage key.
    const { email, activity: login, links, avatar_path, ...user } = ctx.params.user;
    const { public_id, name, bio, created_at } = user;
    const avatar = avatar_path ? this.#storage.disk('public').url(avatar_path) : null;
    const isOwnProfile = ctx.user.id === user.id;

    return this.view('user-profile/Show', {
      // Each link with what the viewer may do with it: `link.can.delete`, one ProfileLinkPolicy call per link.
      // Inside the prop on purpose: a reload of `profile` (a link added) brings the new link's abilities with it.
      // A function: a partial reload for other props (the activity poll) never asks the policy.
      // Without the integer `id` and the links' `user_id`: the page is addressed by `public_id`, the policies decide here.
      profile: async () => ({
        public_id,
        name,
        bio,
        created_at,
        avatar,
        links: (await this.#gate.withAbilities(links, ProfileLinkPolicy, ['delete'])).map(({ user_id: _owner, ...link }) => link),
      }),
      // Only the owner may see their e-mail (ProfilePolicy) — the controller decides what leaves the server.
      email: (await this.#gate.allows(ProfilePolicy, 'viewEmail', user)) ? email : null,
      // Who this is, not what they may do: "this is your profile" (no policy behind it).
      isOwnProfile,
      // What the page may offer — explicit, typed against the policy, only booleans. The UI's hint: the server
      // checks again on every action (UpdateUserProfileRequest, the edit layer's Gate call).
      abilities: this.#gate.abilities(user, ProfilePolicy, ['update']),
      lastLoginAt: login?.last_login_at ?? null,
      // Loaded after the page: the page renders without it, the browser asks for it next — `<Deferred data="activity">`.
      activity: defer(() => this.#activity.recent(user.id)),
      // Never in a full response, only when the page asks — `reload({ only: ['stats'] })` behind "Show statistics".
      // Asking for it by name passes the same middleware and the same controller: it can only be what this page may show.
      stats: optional(() => this.#directory.stats(user.id)),
      // The server's clock for "5 minutes ago": SSR and hydration compute the same text. A Date here,
      // a string in the view (PageProps are serialized).
      now: new Date(),
    })
      // Live: a link added or removed, the name or the picture changed — in another tab, by anyone allowed to: this page
      // reloads its profile (and the activity), no polling. Signed for this session: whoever may see the page may hear its hints.
      .live(profileChannel(user.public_id), { only: ['profile', 'activity'] });
  }
}
