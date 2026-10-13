import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { Gate } from '@marmeon/auth';
import { ProfileDirectory, ProfilePolicy, SIGN_INS_CHANNEL } from '#modules/user-profile';

/** The time ranges of the range picker, in the order the island offers them. */
export const SIGN_IN_RANGES = ['7d', '30d', 'all'] as const;

const DAY = 86_400_000;

/**
 * The island's query: its own, typed — `useIsland<ShowRecentSignInsController>().reload({ query: { range: '7d' } })`
 * in the view, `<Island route="dashboard.sign-ins" query={{ limit: 3 }}>` on the page. Invalid values fall back.
 */
export const RecentSignInsRequest = defineRequest({
  query: r.query({
    range: r.in(SIGN_IN_RANGES).default('30d'),
    limit: r.integer().between(1, 20).default(5),
  }),
});

/** Island "Recent sign-ins": who signed in lately — on the dashboard, and again on `/people` (one island, two pages). */
export class ShowRecentSignInsController extends Controller {
  static request = RecentSignInsRequest;

  readonly #directory: ProfileDirectory;
  readonly #gate: Gate;

  constructor(directory: ProfileDirectory, gate: Gate) {
    super();
    this.#directory = directory;
    this.#gate = gate;
  }

  async handle(ctx: ContextOf<typeof RecentSignInsRequest>) {
    const { range, limit } = ctx.query;
    const since = range === 'all' ? undefined : new Date(Date.now() - (range === '7d' ? 7 : 30) * DAY);
    const rows = await this.#directory.recentSignIns({ since, limit });
    return this.island('dashboard/RecentSignIns', {
      // The island's own projection: each entry with `can.update` — "Edit profile" next to your own name only.
      // The integer id decides the ability here and goes no further: the page is addressed by `publicId`.
      entries: (await this.#gate.withAbilities(rows.map((row) => ({ id: row.id, publicId: row.public_id, name: row.name, at: row.last_login_at })), ProfilePolicy, ['update'])).map(
        ({ id: _id, ...entry }) => entry,
      ),
      // The server's clock for "5 minutes ago".
      now: new Date(),
    })
      // Live: someone signs in — the island reloads on every open dashboard (and /people), no polling.
      .live(SIGN_INS_CHANNEL);
  }
}
