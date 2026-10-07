import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import * as v from 'valibot';
import { Gate } from '@marmeon/auth';
import { ProfileDirectory, ProfilePolicy, SIGN_INS_CHANNEL } from '#modules/user-profile';

/** The time ranges of the range picker, in the order the island offers them. */
export const SIGN_IN_RANGES = ['7d', '30d', 'all'] as const;

const DAY = 86_400_000;

/**
 * The island's query (E55): its own, typed — `useIsland<ShowRecentSignInsController>().reload({ query: { range: '7d' } })`
 * in the view, `<Island route="dashboard.sign-ins" query={{ limit: 3 }}>` on the page. Invalid values fall back.
 */
export const RecentSignInsRequest = defineRequest({
  query: v.object({
    range: v.optional(v.picklist(SIGN_IN_RANGES), '30d'),
    limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(20)), '5'),
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
      // The island's own projection (E61): each entry with `can.update` — "Edit profile" next to your own name only.
      entries: this.#gate.withAbilities(
        rows.map((row) => ({ id: row.id, name: row.name, at: row.last_login_at })),
        ProfilePolicy,
        ['update'],
      ),
      // The server's clock for "5 minutes ago".
      now: new Date(),
    })
      // Live (W6.10): someone signs in — the island reloads on every open dashboard (and /people), no polling.
      .live(SIGN_INS_CHANNEL);
  }
}
