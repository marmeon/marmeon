# @marmeon/queue

Background jobs for Marmeon apps: job classes, a database or Redis queue, workers, retries, unique jobs, chains and failed jobs.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

The `database` driver is the default and needs its `jobs` and `failed_jobs` tables, which a new app has. `QUEUE_DRIVER=redis`
needs `@marmeon/redis`, which brings the Redis client: `pnpm add -E @marmeon/redis@<version of your app>`.

## A first job

```ts title="modules/user-profile/jobs/RebuildMemberStatsJob.ts"
import { withoutOverlapping, type JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { MemberStats } from '../MemberStats.ts';

export class RebuildMemberStatsJob {
  static readonly job = 'user-profile.rebuild-member-stats';
  static readonly schema = r.object({});
  static readonly tries = 5;
  static readonly timeout = 30;
  static readonly middleware = [withoutOverlapping('member-stats', { releaseAfter: 5 })];

  readonly #stats: MemberStats;

  constructor(stats: MemberStats) {
    this.#stats = stats;
  }

  async handle(_payload: JobPayload<typeof RebuildMemberStatsJob>): Promise<void> {
    await this.#stats.rebuild();
  }
}
```

The module lists the job in `jobs: [...]`, and any code that injects the `Queue` dispatches it:
`await this.#queue.dispatch(RebuildMemberStatsJob, {})`. `marmeon dev` runs a worker; in production it is
`marmeon queue:work`.

## Documentation

- [Queues](https://marmeon.com/docs/queues)
- [Queues: what the queue promises](https://marmeon.com/docs/queues#what-the-queue-promises)
- [Queues: running workers](https://marmeon.com/docs/queues#running-workers)
- [Transactions](https://marmeon.com/docs/transactions)
- [Fakes: the queue](https://marmeon.com/docs/fakes#queue)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
