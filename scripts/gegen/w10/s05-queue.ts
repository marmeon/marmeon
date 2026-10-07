import { defineGegenproben } from '../define.ts';

/**
 * W10.5 — `queue:work` takes every queue, fairly (E199). Without `--queue` the worker claims with the driver's `reserveAny`: the
 * database the oldest due job of all queues in ONE statement (an expired claim first; two `LIMIT 1` subqueries along the new index
 * `(reserved_at, available_at, id)`, `FOR UPDATE SKIP LOCKED` on Postgres), Redis the queues in turn in one Lua call. `--queue` keeps
 * its strict order and only narrows; `*` in a list is every queue the list does not name.
 *
 * The W8.10 picture is the fairness test: 20 default jobs, one mail, 20 more — the mail must run before the later default jobs. It
 * turns red when the driver's claim is strict (G1), when the worker puts `default` first (G3), when Redis does not rotate (G4) and
 * when the command keeps the old default (G2). Its mirror, the strict test, turns red when a list stops being strict (G5b) and stays
 * green under G3's patch (X1, the plan's masking probe): strict order alone cannot tell a fair worker from a strict one. The index,
 * the order of the subqueries and the lock are proven by EXPLAIN (G6b, G7, G7b, G8), the lock also by two real workers on Postgres
 * (G6), the expired-claim subquery by the driver contract (G14). Postgres/Redis cases set their URL; run them alone (not next to a suite).
 */
const PGSQL = { MARMEON_TEST_PGSQL_URL: 'postgres://marmeon:secret@localhost:55432/marmeon' };
const REDIS = { MARMEON_TEST_REDIS_URL: 'redis://127.0.0.1:56379' };
const DATABASE = 'packages/queue/src/drivers/database.ts';
const REDIS_DRIVER = 'packages/queue/src/drivers/redis.ts';
const WORKER = 'packages/queue/src/worker.ts';
const WORK = 'packages/queue/src/commands/work.ts';
const fairness = (kind: string) => ({ vitest: 'packages/queue/src/reliability.test.ts', name: `which queues a worker takes on ${kind} (E199) > without --queue` });
const explain = { vitest: 'packages/queue/src/drivers/drivers.test.ts', name: 'reserveAny claims through the index of the fair claim' };
const reserveAnyBody = '    const { rows } = await claimAnyStatement(sql, driver, { now, expired: now - this.#retryAfter * 1000, except }).execute(db);';

export default defineGegenproben({
  step: 'W10.5',
  cases: [
    // --- Fair without --queue: the database's claim, the worker, Redis, the command --------------------------------------------------
    {
      id: 'G1',
      title: "the database's reserveAny goes queue by queue, alphabetically (default first): the mail behind a full default queue runs last",
      patch: [
        {
          file: DATABASE,
          find: reserveAnyBody,
          replace: `    for (const queue of await this.queues()) if (!except.includes(queue)) { const job = await this.reserve([queue]); if (job) return job; }\n    return undefined;\n${reserveAnyBody}`,
        },
      ],
      run: fairness('sqlite'),
      expect: /the mail ran as job 41 of 41: expected 40 to be 20/,
    },
    {
      id: 'G2',
      title: 'queue:work without --queue takes the connection\'s queue again (the old default): the reports job is left',
      patch: [{ file: WORK, find: '    let queues: string[] | undefined;', replace: "    let queues: string[] | undefined = ['default'];" }],
      run: { vitest: 'packages/queue/src/commands/commands.test.ts', name: 'queue:work without --queue (or with --queue=*) takes every queue' },
      expect: /a worker without --queue left jobs: expected \[ \+?0, 1 \] to deeply equal \[ \+?0, \+?0 \]/,
    },
    {
      id: 'G3',
      title: 'the worker without a list takes default first, then the rest (the variant E199 rejected): the mail waits for the full default queue',
      patch: [{ file: WORKER, find: '      const any = this.#any([]);\n      return { next: () => any() };', replace: "      const any = this.#any(['default']);\n      return { next: async () => (await driver.reserve(['default'])) ?? any() };" }],
      run: fairness('sqlite'),
      expect: /the mail ran as job 41 of 41: expected 40 to be 20/,
    },
    {
      id: 'G4',
      title: 'Redis without rotation (always from the first queue): the mail behind a full default queue runs last',
      patch: [{ file: REDIS_DRIVER, find: '    const after = last === undefined ? 0 : queues.findIndex((queue) => queue > last);', replace: '    const after = last === undefined ? 0 : 0;' }],
      run: { ...fairness('redis'), env: REDIS },
      expect: /the mail ran as job 41 of 41: expected 40 to be 1/,
    },
    {
      id: 'G9',
      title: 'Redis keeps its list of queues after a round without a job: a queue that appears later is not taken (for a second)',
      patch: [{ file: REDIS_DRIVER, find: '    this.#known = undefined;\n    return undefined;', replace: '    return undefined;' }],
      run: { vitest: 'packages/queue/src/drivers/drivers.test.ts', name: 'the redis queue driver > reserveAny: takes a queue that appears after the worker started', env: REDIS },
      expect: /a queue pushed to after the first claim: expected undefined to be 'new queue'/,
    },
    // --- --queue stays strict and only narrows ------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: '--queue no longer narrows (every list taken as *): --queue=mail runs the default job too',
      patch: [{ file: WORK, find: "      if (queues.length === 1 && queues[0] === '*') queues = undefined;", replace: '      queues = undefined;' }],
      run: { vitest: 'packages/queue/src/commands/commands.test.ts', name: 'queue:work without --queue (or with --queue=*) takes every queue' },
      expect: /only the named queue ran: expected \[ \+?0, \+?0 \] to deeply equal \[ \+?0, 1 \]/,
    },
    {
      id: 'G5b',
      title: 'a list is claimed fairly instead of strictly: --queue=default,mail runs the mail among the default jobs',
      patch: [{ file: WORKER, find: '      steps.push(() => driver.reserve(queues));', replace: '      steps.push(() => driver.reserveAny!(list.filter((queue) => !queues.includes(queue))));' }],
      run: { vitest: 'packages/queue/src/reliability.test.ts', name: 'which queues a worker takes on sqlite (E199) > with --queue=default,mail the order stays strict' },
      expect: /the mail ran as job 21 of 41: expected 20 to be 40/,
      masks: 'G3',
    },
    {
      id: 'X1',
      title: "masking probe: G3's patch (no list = default first, then the rest) leaves the strict test green — strict order alone cannot tell; the fairness test (G3) must",
      patch: [{ file: WORKER, find: '      const any = this.#any([]);\n      return { next: () => any() };', replace: "      const any = this.#any(['default']);\n      return { next: async () => (await driver.reserve(['default'])) ?? any() };" }],
      run: { vitest: 'packages/queue/src/reliability.test.ts', name: 'which queues a worker takes on sqlite (E199) > with --queue=default,mail the order stays strict' },
      expectGreen: true,
    },
    // --- One statement per idle round; no look at "other" queues -------------------------------------------------------------------------
    {
      id: 'G10',
      title: "the database's reserveAny asks per queue (the old --queue=*): an idle round costs 1 + N statements",
      patch: [
        {
          file: DATABASE,
          find: reserveAnyBody,
          replace: `    for (const queue of await this.queues()) if (!except.includes(queue)) { const job = await this.reserve([queue]); if (job) return job; }\n    if (now > 0) return undefined;\n${reserveAnyBody}`,
        },
      ],
      run: { vitest: 'packages/queue/src/drivers/drivers.test.ts', name: 'reserveAny asks the database once per round' },
      expect: /statements of an idle round of reserveAny: expected 4 to be 1/,
    },
    {
      id: 'G11',
      title: 'the worker ignores reserveAny and goes round queues() itself: an idle round asks for the list and reserves',
      patch: [{ file: WORKER, find: '    if (driver.reserveAny) return () => driver.reserveAny!(except);', replace: '    if (driver.reserveAny && except.length < 0) return () => driver.reserveAny!(except);' }],
      run: { vitest: 'packages/queue/src/queue.test.ts', name: 'without queues takes every queue in one claim per round' },
      expect: /driver calls of an idle round without queues: expected \[ 'queues', 'reserve' \] to deeply equal \[ 'reserveAny' \]/,
    },
    {
      id: 'G12',
      title: 'a worker without a list looks at "the other queues" while idle: queues() and counts() every look',
      patch: [{ file: WORKER, find: "    if (every === false || list.length === 0 || list.includes('*')) return { look: async () => {} };", replace: "    if (every === false || list.includes('*')) return { look: async () => {} };" }],
      run: { vitest: 'packages/queue/src/queue.test.ts', name: 'without queues takes every queue in one claim per round' },
      expect: /driver calls of an idle worker without queues: expected \[ 'reserveAny', 'queues', 'counts' \] to deeply equal \[ 'reserveAny' \]/,
    },
    // --- The statement: lock, index, order (EXPLAIN) ---------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'Postgres without FOR UPDATE SKIP LOCKED in the fair claim: two real workers run some of 200 jobs twice',
      patch: [{ file: DATABASE, find: "  const lock = driver === 'pgsql' ? sql`for update skip locked` : sql``;", replace: '  const lock = sql``;' }],
      run: { vitest: 'packages/queue/src/worker-processes.test.ts', name: 'queue:work processes on pgsql > runs each of 200 jobs exactly once', env: PGSQL, timeout: 5 * 60_000 },
      expect: /jobs that ran more than once: \d/,
    },
    {
      id: 'G6b',
      title: 'the same patch: EXPLAIN on Postgres shows no LockRows in the subqueries',
      patch: [{ file: DATABASE, find: "  const lock = driver === 'pgsql' ? sql`for update skip locked` : sql``;", replace: '  const lock = sql``;' }],
      run: { ...explain, name: 'the database queue driver on pgsql, in a transaction (E85) > reserveAny claims through the index', env: PGSQL },
      expect: /both subqueries lock their row: .*expected \+?0 to be 2/,
    },
    {
      id: 'G7',
      title: 'the migration without the index (reserved_at, available_at, id): SQLite scans the table and sorts',
      patch: [{ file: 'packages/queue/stubs/migrations/create_jobs_table.ts', find: "      table.index(['reserved_at', 'available_at', 'id']);\n", replace: '' }],
      run: { ...explain, name: 'the database queue driver on sqlite, in a transaction (E85) > reserveAny claims through the index' },
      expect: /both subqueries walk jobs_reserved_at_available_at_id_index: .*expected \+?0 to be 2/,
    },
    {
      id: 'G7b',
      title: 'the due subquery orders by available_at, id only: Postgres does not see reserved_at IS NULL as an equality and sorts',
      patch: [
        {
          file: DATABASE,
          find: '${others}\n          order by reserved_at, available_at, id limit 1 ${lock})\n      )',
          replace: '${others}\n          order by available_at, id limit 1 ${lock})\n      )',
        },
      ],
      run: { ...explain, name: 'the database queue driver on pgsql, in a transaction (E85) > reserveAny claims through the index', env: PGSQL },
      expect: /both subqueries walk jobs_reserved_at_available_at_id_index: .*expected 1 to be 2|no sort and no full scan: .*Sort/,
    },
    {
      id: 'G8',
      title: "the plan's sketch — one WHERE with OR over both ranges — instead of the two subqueries: SQLite sorts every due job",
      patch: [
        {
          file: DATABASE,
          find: '      where id = coalesce(\n        (select id from jobs where reserved_at <= cast(${expired} as bigint) ${others}\n          order by reserved_at, available_at, id limit 1 ${lock}),\n        (select id from jobs where reserved_at is null and available_at <= cast(${now} as bigint) ${others}\n          order by reserved_at, available_at, id limit 1 ${lock})\n      )',
          replace:
            '      where id = (select id from jobs where available_at <= cast(${now} as bigint) and (reserved_at is null or reserved_at <= cast(${expired} as bigint)) ${others}\n          order by available_at, id limit 1 ${lock})',
        },
      ],
      run: { ...explain, name: 'the database queue driver on sqlite, in a transaction (E85) > reserveAny claims through the index' },
      expect: /both subqueries walk jobs_reserved_at_available_at_id_index: .*expected 1 to be 2|no sort and no full scan: .*TEMP B-TREE/,
    },
    {
      id: 'G14',
      title: 'the fair claim without its first subquery (expired claims): the job of a worker that died is never taken again',
      patch: [
        {
          file: DATABASE,
          find: '        (select id from jobs where reserved_at <= cast(${expired} as bigint) ${others}\n          order by reserved_at, available_at, id limit 1 ${lock}),',
          replace: '        (select null),',
        },
      ],
      run: { vitest: 'packages/queue/src/drivers/drivers.test.ts', name: 'the sqlite queue driver > reserveAny: keeps a delayed job back and takes an expired claim' },
      expect: /expected 'later#1 fresh#1' to be 'lost#2 later#1 fresh#1'/,
    },
    // --- Who starts a worker ------------------------------------------------------------------------------------------------------------------
    {
      id: 'G13',
      title: "make:docker's compose file starts the worker with --queue=mail,default again",
      patch: [{ file: 'packages/cli/src/docker.ts', find: `    "    command: ['queue:work']",`, replace: `    "    command: ['queue:work', '--queue=mail,default']",` }],
      run: { vitest: 'packages/cli/src/make-docker.test.ts', name: 'writes a multi-stage Dockerfile for a pnpm app' },
      expect: /expected '# Written by `marmeon make:docker` — …' to contain 'command: \[\\?'queue:work\\?'\]'/,
    },
  ],
});
