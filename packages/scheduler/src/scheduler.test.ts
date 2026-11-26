import { join } from 'node:path';
import { Cache, CacheServiceProvider } from '@marmeon/cache';
import { CACHE_MIGRATION, MemoryStore, StoreCache } from '@marmeon/cache/internal';
import { CliServiceProvider, DevProcesses, type CommandInput } from 'marmeon';
import { CommandRegistry } from 'marmeon/internal';
import { Clock, createApplication, currentLogContext, defineModule, ErrorReports, EventRegistry, inTransaction, listen, Logger, providerJobs, Redactor, type Application, type ErrorReport, type ErrorReporter, type ListenerBinding, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import { EventFake, TestClock } from '@marmeon/core/testing';
import { channels, type ScheduleTaskMessage } from '@marmeon/core/diagnostics';
import { Connections, DatabaseServiceProvider, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Queue, QueueConnections, QueueServiceProvider, withoutOverlapping, type JobClass, type JobPayload } from '@marmeon/queue';
import { QUEUE_MIGRATION } from '@marmeon/queue/internal';
import * as v from 'valibot';
import { readdirSync, readFileSync } from 'node:fs';
import { Output } from 'marmeon';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { ScheduleError } from './cron.ts';
import { collectTasks } from './schedule.ts';
import { defineSchedule, ScheduledTaskEvent, ScheduledTaskFailed, ScheduledTaskFinished, ScheduledTaskSkipped, ScheduledTaskStarting, Scheduler, SchedulerServiceProvider, type TaskResult } from './index.ts';
import { ScheduleTester } from './testing.ts';
import { MINUTE } from './time.ts';
import { ScheduleWorker } from './worker.ts';
import { ScheduleWorkCommand } from './commands/schedule.ts';
import { ScheduleConfig } from './config.ts';
import { warnJobNames } from './job-names.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

/** Log entries, for assertions — and silence. */
class Recorder implements Logger {
  readonly entries: { level: string; message: string; context: Record<string, unknown> }[];
  readonly #context: Record<string, unknown>;
  constructor(entries: Recorder['entries'] = [], context: Record<string, unknown> = {}) {
    this.entries = entries;
    this.#context = context;
  }
  debug(message: string, context = {}) {
    this.entries.push({ level: 'debug', message, context: { ...this.#context, ...context } });
  }
  info(message: string, context = {}) {
    this.entries.push({ level: 'info', message, context: { ...this.#context, ...context } });
  }
  warn(message: string, context = {}) {
    this.entries.push({ level: 'warn', message, context: { ...this.#context, ...context } });
  }
  error(message: string, context = {}) {
    this.entries.push({ level: 'error', message, context: { ...this.#context, ...context } });
  }
  child(context: Record<string, unknown>): Logger {
    return new Recorder(this.entries, { ...this.#context, ...context });
  }
}

/** What the tasks of this file did — a test-only recorder, injected. */
class Runs {
  readonly entries: { task: string; at: number; unit?: string; inTransaction?: boolean }[] = [];
  count(task: string): number {
    return this.entries.filter((entry) => entry.task === task).length;
  }
}

/** Something scoped: one per run, never shared between runs. */
class UnitOfWork {
  readonly id = crypto.randomUUID();
}

class CountRun {
  readonly #runs: Runs;
  readonly #unit: UnitOfWork;
  readonly #clock: Clock;
  constructor(runs: Runs, unit: UnitOfWork, clock: Clock) {
    this.#runs = runs;
    this.#unit = unit;
    this.#clock = clock;
  }
  handle() {
    // The run's log context names its task.
    this.#runs.entries.push({ task: String(currentLogContext().task), at: this.#clock.now(), unit: this.#unit.id, inTransaction: inTransaction() });
  }
}

class Gate {
  #open: () => void = () => {};
  promise = new Promise<void>((resolve) => (this.#open = resolve));
  running = 0;
  most = 0;
  open() {
    this.#open();
  }
}

/** Takes until the gate opens — a task that runs for minutes. */
class SlowTask {
  readonly #gate: Gate;
  readonly #runs: Runs;
  constructor(gate: Gate, runs: Runs) {
    this.#gate = gate;
    this.#runs = runs;
  }
  async handle() {
    this.#gate.running++;
    this.#gate.most = Math.max(this.#gate.most, this.#gate.running);
    this.#runs.entries.push({ task: 'slow', at: 0 });
    await this.#gate.promise;
    this.#gate.running--;
  }
}

const reported: ErrorReport[] = [];
class Collecting implements ErrorReporter {
  report(report: ErrorReport): void {
    reported.push(report);
  }
}
class ReportingProvider {
  static errorReporters = [Collecting];
}

class FailingTask {
  handle() {
    throw new Error('the report service is down');
  }
}

class PruneCommand {
  static command = 'fixture:prune';
  static description = 'Prunes';
  static options = { hours: { type: 'string' } } as const;
  readonly #runs: Runs;
  constructor(runs: Runs) {
    this.#runs = runs;
  }
  handle({ options, output }: CommandInput) {
    this.#runs.entries.push({ task: `prune ${String(options.hours)}`, at: 0 });
    output.success(`Pruned 3 rows older than ${String(options.hours)}h`);
    return options.hours === 'fail' ? 2 : 0;
  }
}

class StatsJob {
  static readonly job = 'fixture.stats';
  static readonly schema = v.object({ scope: v.string() });
  handle(_payload: JobPayload<typeof StatsJob>) {}
}

/** What a package brings: a job the app's schedule can queue, registered by the package's provider. */
class PkgJob {
  static readonly job = 'pkg.sync';
  static readonly schema = v.object({ scope: v.string() });
  handle(_payload: JobPayload<typeof PkgJob>) {}
}

/** Inherits the name of `PkgJob`: the app's schedule queues it, the provider registers its parent. */
class PkgChildJob extends PkgJob {}

/** Another class under the name of `PkgJob`. */
class PkgOtherJob {
  static readonly job = 'pkg.sync';
  static readonly schema = v.object({ scope: v.string() });
  handle(_payload: JobPayload<typeof PkgOtherJob>) {}
}

/** A provider that brings jobs — the one place the test names the key under which a provider lists them. */
function providerOfJobs(...jobs: JobClass[]): ServiceProviderClass {
  return class {
    static [providerJobs] = jobs;
  };
}

/** The check `schedule:work` starts, kept: a test awaits its promise, or lets it never settle. */
const check = vi.hoisted(() => ({ kept: [] as Promise<void>[], neverSettle: false }));
vi.mock('./job-names.ts', async (original) => {
  const real = await original<typeof import('./job-names.ts')>();
  return {
    ...real,
    warnJobNames: (...args: Parameters<typeof real.warnJobNames>) => {
      const promise = check.neverSettle ? new Promise<void>(() => {}) : real.warnJobNames(...args);
      check.kept.push(promise);
      return promise;
    },
  };
});

const START = Date.parse('2026-10-05T10:00:00Z');

interface Booted {
  readonly app: Application;
  readonly scheduler: Scheduler;
  readonly schedule: ScheduleTester;
  readonly clock: TestClock;
  readonly runs: Runs;
  readonly gate: Gate;
  readonly log: Recorder;
}

async function boot(
  schedule: ModuleDefinition['schedule'],
  options: {
    env?: Record<string, string>;
    providers?: ServiceProviderClass[];
    cache?: Cache;
    modules?: ModuleDefinition[];
    listeners?: ListenerBinding[];
    eventFake?: EventFake;
  } = {},
): Promise<Booted> {
  const clock = new TestClock();
  clock.freeze(START);
  const runs = new Runs();
  const gate = new Gate();
  const log = new Recorder();
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [CliServiceProvider, CacheServiceProvider, ...(options.providers ?? []), SchedulerServiceProvider],
    modules: [defineModule({ name: 'fixture', schedule, commands: [PruneCommand] }), ...(options.modules ?? [])],
    listeners: options.listeners ?? [],
  }, {
    env: { NODE_ENV: 'test', CACHE_DRIVER: 'memory', ...options.env },
    override: (c) => {
      c.instance(Clock, clock);
      c.instance(Logger, log);
      c.instance(Runs, runs);
      c.instance(Gate, gate);
      c.scoped(UnitOfWork);
      if (options.cache) c.instance(Cache, options.cache);
      // What createTestApp does for `app.events`.
      if (options.eventFake) c.instance(EventFake, options.eventFake);
    },
  });
  const scheduler = app.container.make(Scheduler);
  return { app, scheduler, schedule: new ScheduleTester(scheduler, clock), clock, runs, gate, log };
}

const at = (iso: string) => Date.parse(iso);

describe('the schedule', () => {
  it('knows what is due when — in the time zone of each task', async () => {
    const { schedule, app } = await boot(
      defineSchedule((s) => {
        s.call(CountRun).everyMinute().name('every-minute');
        s.call(CountRun).daily().at('03:10').timeZone('Europe/Berlin').name('berlin-night');
        s.command('fixture:prune', ['--hours=168']).weekly();
        s.call(CountRun).hourly().environments('production').name('production-only');
      }),
    );
    expect(schedule.tasks).toEqual(['every-minute', 'berlin-night', 'fixture:prune --hours=168', 'production-only']);
    expect(schedule.due('2026-10-05T01:10:00Z')).toEqual(['every-minute', 'berlin-night']); // 03:10 in Berlin (CEST)
    expect(schedule.due('2026-11-05T02:10:00Z')).toEqual(['every-minute', 'berlin-night']); // 03:10 in Berlin (CET)
    expect(schedule.due('2026-10-04T00:00:00Z')).toEqual(['every-minute', 'fixture:prune --hours=168']); // Sunday midnight UTC
    // Not in this environment (NODE_ENV=test: APP_ENV testing): never due.
    expect(schedule.due('2026-10-05T11:00:00Z')).toEqual(['every-minute']);
    await app.shutdown();
  });

  it('runs each task in a scope of its own, outside the transaction of whoever ticks', async () => {
    const { scheduler, runs, app, clock } = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')), {
      providers: [DatabaseServiceProvider],
      env: { DB_MANAGED: 'false', DB_DATABASE: ':memory:' },
    });
    const connections = app.container.make(Connections);
    await connections.transaction(async () => {
      expect(inTransaction()).toBe(true);
      const ticked = await scheduler.tick(clock.now());
      await Promise.all(ticked.map((run) => run.done));
      const again = await scheduler.tick(clock.travel({ minutes: 1 }));
      await Promise.all(again.map((run) => run.done));
    });
    expect(runs.entries.map((entry) => entry.inTransaction)).toEqual([false, false]);
    const [first, second] = runs.entries;
    expect(first!.unit).not.toBe(second!.unit);
    await app.shutdown();
  });

  it('runs commands with their arguments, their output in the log with { task }; a failure ends only that run', async () => {
    const { schedule, runs, log, app } = await boot(
      defineSchedule((s) => {
        s.command('fixture:prune', ['--hours=168']).everyMinute();
        s.command(PruneCommand, ['--hours=fail']).everyMinute();
        s.call(FailingTask).everyMinute();
        s.call(CountRun).everyMinute().name('count');
      }),
    );
    const results = await schedule.run();
    expect(results.map((result) => [result.task, result.outcome])).toEqual([
      ['fixture:prune --hours=168', 'ran'],
      ['fixture:prune --hours=fail', 'failed'],
      ['FailingTask', 'failed'],
      ['count', 'ran'],
    ]);
    expect(runs.entries.map((entry) => entry.task).sort()).toEqual(['count', 'prune 168', 'prune fail']);
    expect(log.entries).toContainEqual({ level: 'info', message: '✓ Pruned 3 rows older than 168h'.slice(2), context: { channel: 'schedule', task: 'fixture:prune --hours=168' } });
    expect(log.entries).toContainEqual(expect.objectContaining({ level: 'error', message: 'Failed: FailingTask', context: expect.objectContaining({ exception: 'Error: the report service is down' }) }));
    expect(String((results[1] as TaskResult).error)).toContain('exited with code 2');
    await app.shutdown();
  });

  it('asks when() and skip() each time, with the run\'s scope; schedule:test ignores them', async () => {
    let open = false;
    const { schedule, runs, app } = await boot(
      defineSchedule((s) => {
        s.call(CountRun).everyMinute().name('count').when((scope) => scope.make(Runs) instanceof Runs && open).skip(() => false);
      }),
    );
    expect((await schedule.run())[0]).toMatchObject({ outcome: 'skipped', skipped: 'filter' });
    open = true;
    expect((await schedule.run(START + MINUTE))[0]).toMatchObject({ outcome: 'ran' });
    open = false;
    expect(await schedule.runTask('count')).toMatchObject({ outcome: 'ran', reason: 'test' });
    expect(runs.count('count')).toBe(2);
    await app.shutdown();
  });
});

describe('missed runs (catchUp)', () => {
  const tasks = defineSchedule((s) => {
    s.call(CountRun).everyMinute().name('count');
    s.call(CountRun).hourlyAt(5).name('at-five');
    s.call(CountRun).hourlyAt(7).catchUp('skip').name('at-seven');
  });

  it('a scheduler that was down for ten minutes runs a missed task once when it is back — not once per missed minute', async () => {
    const { schedule, app } = await boot(tasks);
    const first = await schedule.run('2026-10-05T10:00:00Z');
    expect(first.map((result) => result.task)).toEqual(['count']);
    const back = await schedule.run('2026-10-05T10:10:00Z');
    expect(back.map((result) => [result.task, result.reason])).toEqual([
      ['count', 'due'],
      ['at-five', 'catch-up'],
    ]);
    // The catch-up stands for the last missed time (its onOneServer lock is that minute's).
    expect(back[1]!.dueAt).toBe(at('2026-10-05T10:05:00Z'));
    // And only once: the next tick has nothing to catch up.
    expect((await schedule.run('2026-10-05T10:11:00Z')).map((result) => result.task)).toEqual(['count']);
    await app.shutdown();
  });

  it('the loop of schedule:work, paused for ten minutes, ticks on with one catch-up', async () => {
    const { scheduler, clock, runs, app, log } = await boot(tasks);
    clock.freeze(at('2026-10-05T09:59:30Z'));
    const worker = new ScheduleWorker(scheduler, clock, log, app.container.make(Redactor));
    const stop = new AbortController();
    let sleeps = 0;
    const ticks: number[] = [];
    await worker.run({
      signal: stop.signal,
      // Time passes as the loop sleeps; on the third sleep the machine is suspended for ten minutes.
      sleep: async (ms) => {
        sleeps++;
        clock.travel({ milliseconds: ms + (sleeps === 3 ? 10 * MINUTE : 0) });
        await Promise.resolve();
      },
      onTick: (minute) => {
        ticks.push(minute);
        if (ticks.length === 5) stop.abort();
      },
    });
    expect(await worker.drain(1)).toBe(true);
    expect(ticks.map((minute) => new Date(minute).toISOString().slice(11, 16))).toEqual(['10:00', '10:01', '10:12', '10:13', '10:14']);
    expect(runs.count('count')).toBe(5); // 10:00, 10:01, 10:12, 10:13, 10:14 — not one per missed minute
    expect(log.entries.filter((entry) => entry.message === 'Running at-five — missed while the scheduler was down')).toHaveLength(1);
    expect(log.entries.some((entry) => entry.message.startsWith('Running at-seven'))).toBe(false);
    await app.shutdown();
  });

  it('a timer that fires 1 ms early on the first pass does not tick the minute the loop started in', async () => {
    const { scheduler, clock, app, log } = await boot(tasks);
    clock.freeze(at('2026-10-05T09:59:30Z'));
    const worker = new ScheduleWorker(scheduler, clock, log, app.container.make(Redactor));
    const stop = new AbortController();
    let sleeps = 0;
    const ticks: number[] = [];
    await worker.run({
      signal: stop.signal,
      sleep: async (ms) => {
        sleeps++;
        clock.travel({ milliseconds: sleeps === 1 ? ms - 1 : ms });
        await Promise.resolve();
      },
      onTick: (minute) => {
        ticks.push(minute);
        if (ticks.length === 2) stop.abort();
      },
    });
    await worker.drain(1);
    expect(ticks.map((minute) => new Date(minute).toISOString().slice(11, 16))).toEqual(['10:00', '10:01']);
    await app.shutdown();
  });

  it('drain cancels its timer once the runs ended: no timer outlives the wait', async () => {
    const { scheduler, clock, gate, app, log } = await boot(defineSchedule((s) => void s.call(SlowTask).everyMinute().name('slow')));
    clock.freeze(at('2026-10-05T09:59:30Z'));
    const worker = new ScheduleWorker(scheduler, clock, log, app.container.make(Redactor));
    const stop = new AbortController();
    await worker.run({
      signal: stop.signal,
      sleep: async (ms) => {
        clock.travel({ milliseconds: ms });
        await Promise.resolve();
      },
      onTick: () => stop.abort(),
    });
    expect(worker.running).toBe(1);
    const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const before = timers();
    const drained = worker.drain(3600);
    expect(timers()).toBe(before + 1);
    gate.open();
    expect(await drained).toBe(true);
    expect(timers()).toBe(before);
    await app.shutdown();
  });

  it('nothing to catch up on the first tick ever', async () => {
    const { schedule, app } = await boot(tasks);
    expect((await schedule.run('2026-10-05T10:10:00Z')).map((result) => result.task)).toEqual(['count']);
    await app.shutdown();
  });
});

describe('withoutOverlapping', () => {
  it('a task that runs three minutes, due every minute, never runs twice at once — the ticks go on meanwhile', async () => {
    const { scheduler, clock, gate, runs, app } = await boot(defineSchedule((s) => void s.call(SlowTask).everyMinute().withoutOverlapping()));
    const started = await scheduler.tick(clock.now());
    const results: TaskResult[] = [];
    for (let minute = 1; minute <= 3; minute++) {
      for (const run of await scheduler.tick(clock.travel({ minutes: 1 }))) results.push(await run.done);
    }
    expect(results.map((result) => result.skipped)).toEqual(['overlapping', 'overlapping', 'overlapping']);
    gate.open();
    expect((await started[0]!.done).outcome).toBe('ran');
    for (const run of await scheduler.tick(clock.travel({ minutes: 1 }))) expect((await run.done).outcome).toBe('ran');
    expect(gate.most).toBe(1);
    expect(runs.count('slow')).toBe(2);
    await app.shutdown();
  });

  it('holds the lock for the span given as a Duration, 24 hours by default', async () => {
    const store = new MemoryStore();
    const cache = new StoreCache({ store, locks: store });
    const lock = vi.spyOn(cache, 'lock');
    const { scheduler, clock, gate, app } = await boot(
      defineSchedule((s) => {
        s.call(SlowTask).everyMinute().name('half-hour').withoutOverlapping({ expiresAfter: { minutes: 30 } });
        s.call(CountRun).everyMinute().name('default').withoutOverlapping();
      }),
      { cache },
    );
    expect(scheduler.tasks.map((task) => task.definition.overlapSeconds)).toEqual([1800, 86_400]);
    const runs = await scheduler.tick(clock.now());
    gate.open();
    await Promise.all(runs.map((run) => run.done));
    expect(lock.mock.calls.filter(([name]) => name.startsWith('schedule:overlap:')).map(([name, ttl]) => [name, ttl])).toEqual([
      ['schedule:overlap:half-hour', 1800],
      ['schedule:overlap:default', 86_400],
    ]);
    await app.shutdown();
  });

  it('refuses a bare number, an unknown option and a span of zero, saying what to write', () => {
    const define = (overlapping: (task: { withoutOverlapping(...args: never[]): unknown }) => unknown) =>
      collectTasks(defineSchedule((s) => void overlapping(s.call(CountRun).hourly() as never)), 'fixture');
    expect(() => define((task) => task.withoutOverlapping(30 as never))).toThrow(new TypeError('withoutOverlapping(30) takes an options object — withoutOverlapping({ expiresAfter: { minutes: 30 } }).'));
    expect(() => define((task) => task.withoutOverlapping({ expiresAfterMinutes: 30 } as never))).toThrow('the only option is expiresAfter');
    expect(() => define((task) => task.withoutOverlapping({ expiresAfter: 0 } as never))).toThrow('the lock needs a span above zero');
    expect(() => define((task) => task.withoutOverlapping({ expiresAfter: '30' } as never))).toThrow(/^withoutOverlapping\(\{ expiresAfter \}\): /);
    expect(() => define((task) => task.withoutOverlapping({ expiresAfter: { weeks: 1 } } as never))).toThrow(TypeError);
  });

  it('takes one line of text as a description', () => {
    const describe = (text: unknown) => collectTasks(defineSchedule((s) => void s.call(CountRun).hourly().description(text as string)), 'fixture');
    expect(describe('Rebuilds the report')[0]!.description).toBe('Rebuilds the report');
    for (const text of [42, 'two\nlines', 'bell\u0007']) expect(() => describe(text)).toThrow('description() takes one line of text.');
  });

  it('frees the lock of runs a stopping scheduler leaves behind', async () => {
    const { scheduler, clock, gate, app } = await boot(defineSchedule((s) => void s.call(SlowTask).everyMinute().withoutOverlapping()));
    await scheduler.tick(clock.now());
    await scheduler.releaseHeld();
    const [next] = await scheduler.tick(clock.travel({ minutes: 1 }));
    gate.open();
    expect((await next!.done).outcome).toBe('ran');
    await app.shutdown();
  });
});

describe('onOneServer', () => {
  it('two schedulers sharing a cache: the task runs once per minute', async () => {
    const shared = new MemoryStore();
    const tasks = defineSchedule((s) => void s.call(CountRun).everyMinute().name('count').onOneServer());
    const one = await boot(tasks, { cache: new StoreCache({ store: shared, locks: shared }) });
    const two = await boot(tasks, { cache: new StoreCache({ store: shared, locks: shared }), env: {} });
    for (let minute = 0; minute < 3; minute++) {
      const time = START + minute * MINUTE;
      const runs = [...(await one.scheduler.tick(time)), ...(await two.scheduler.tick(time))];
      const results = await Promise.all(runs.map((run) => run.done));
      expect(results.map((result) => result.outcome).sort()).toEqual(['ran', 'skipped']);
    }
    expect(one.runs.count('count') + two.runs.count('count')).toBe(3);
    await one.app.shutdown();
    await two.app.shutdown();
  });

  it('with a file or memory cache the scheduler starts — and says where its locks hold', async () => {
    const { scheduler, app } = await boot(defineSchedule((s) => void s.command('fixture:prune').daily().at('03:10').onOneServer()));
    await expect(scheduler.checkProcess()).resolves.toBeUndefined();
    expect(scheduler.lockWarning()).toBe(
      'onOneServer() locks in CACHE_DRIVER=memory: locks only hold in this process — a second schedule:work, even on this machine, runs the tasks again. ' +
        'Use CACHE_DRIVER=file for one machine, database (marmeon make:cache-table) or redis for more. Tasks: fixture:prune',
    );
    await app.shutdown();
    const file = await boot(
      defineSchedule((s) => {
        s.command('fixture:prune').daily().onOneServer();
        s.call(SlowTask).everyMinute().name('slow').withoutOverlapping();
        s.call(CountRun).everyMinute().name('count');
      }),
      { env: { CACHE_DRIVER: 'file', CACHE_PATH: tempDir('marmeon-schedule-') } },
    );
    await expect(file.scheduler.checkProcess()).resolves.toBeUndefined();
    expect(file.scheduler.lockWarning()).toBe(
      'onOneServer()/withoutOverlapping() lock in CACHE_DRIVER=file: locks only hold on this machine. With more than one scheduler instance (more servers), ' +
        'use CACHE_DRIVER=database (marmeon make:cache-table) or redis. Tasks: fixture:prune, slow',
    );
    await file.app.shutdown();
    // Nothing to warn about: no task locks, or a cache all servers share.
    const plain = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')));
    expect(plain.scheduler.lockWarning()).toBeUndefined();
    await plain.app.shutdown();
    const shared = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count').onOneServer()), {
      providers: [DatabaseServiceProvider],
      env: { CACHE_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:' },
    });
    expect(shared.scheduler.lockWarning()).toBeUndefined();
    await shared.app.shutdown();
  });

  it('schedule:list shows the same warning', async () => {
    const { app } = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count').withoutOverlapping()));
    const lines: string[] = [];
    const output = { line: (text = '') => lines.push(text), info: (text: string) => lines.push(text), success: (text: string) => lines.push(text), warn: (text: string) => lines.push(`WARN ${text}`), error: (text: string) => lines.push(`ERROR ${text}`), table: () => {} };
    const List = app.container.make(CommandRegistry).get('schedule:list')!;
    expect(await (app.container.make(List) as { handle(input: unknown): number }).handle({ args: [], options: {}, output, root: app.root })).toBe(0);
    expect(lines).toEqual(['WARN withoutOverlapping() locks in CACHE_DRIVER=memory: locks only hold in this process — a second schedule:work, even on this machine, runs the tasks again. Use CACHE_DRIVER=file for one machine, database (marmeon make:cache-table) or redis for more. Tasks: count']);
    await app.shutdown();
  });
});

describe('events', () => {
  /** Every scheduler event, in order — through the app's EventDispatcher, as a listener of the base class. */
  async function withEvents(schedule: ModuleDefinition['schedule'], options: Parameters<typeof boot>[1] = {}) {
    const events: ScheduledTaskEvent[] = [];
    const booted = await boot(schedule, { ...options, listeners: [listen(ScheduledTaskEvent, (event) => void events.push(event))] });
    return { ...booted, events };
  }
  it('refuses an event built with the old minute field', () => {
    expect(() => new ScheduledTaskStarting({ task: 'count', minute: START, reason: 'due' } as never)).toThrow(/dueAt is the time the task was due/);
  });

  const names = (events: readonly ScheduledTaskEvent[]) => events.map((event) => `${event.constructor.name} ${event.task}`);

  it('a run that ends: Starting, then Finished with how long it took', async () => {
    const { schedule, events, app } = await withEvents(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')));
    await schedule.runTask('count');
    expect(names(events)).toEqual(['ScheduledTaskStarting count', 'ScheduledTaskFinished count']);
    expect(events[0]).toMatchObject({ task: 'count', dueAt: START, reason: 'test' });
    expect((events[1] as ScheduledTaskFinished).ms).toBeGreaterThanOrEqual(0);
    await app.shutdown();
  });

  it('a run that fails: exactly one Failed, with the error', async () => {
    const { scheduler, events, app, clock } = await withEvents(defineSchedule((s) => void s.call(FailingTask).everyMinute().name('failing')));
    const runs = await scheduler.tick(clock.now());
    const [result] = await Promise.all(runs.map((run) => run.done));
    expect(result).toMatchObject({ task: 'failing', outcome: 'failed' });
    expect(names(events)).toEqual(['ScheduledTaskStarting failing', 'ScheduledTaskFailed failing']);
    expect(((events[1] as ScheduledTaskFailed).error as Error).message).toBe('the report service is down');
    await app.shutdown();
  });

  it('a listener that throws changes nothing about the run — logged as a warning', async () => {
    const thrown: unknown[] = [];
    class Alert {
      handle(event: ScheduledTaskFailed) {
        thrown.push(event.error);
        throw new Error('the pager is down');
      }
    }
    const { scheduler, app, clock, log } = await boot(defineSchedule((s) => void s.call(FailingTask).everyMinute().name('failing')), {
      listeners: [listen(ScheduledTaskFailed, Alert)],
    });
    const [result] = await Promise.all((await scheduler.tick(clock.now())).map((run) => run.done));
    expect(result).toMatchObject({ task: 'failing', outcome: 'failed' });
    expect((thrown[0] as Error).message).toBe('the report service is down');
    expect(log.entries.some((entry) => entry.level === 'warn' && entry.message === 'A listener of ScheduledTaskFailed failed: the pager is down')).toBe(true);
    await app.shutdown();
  });

  it('reports a task that throws to the error reporters, by its name; one that works is not reported', async () => {
    reported.length = 0;
    const { scheduler, app, clock, log } = await boot(
      defineSchedule((s) => {
        s.call(FailingTask).everyMinute().name('failing');
        s.call(CountRun).everyMinute().name('count');
      }),
      { providers: [ReportingProvider] },
    );
    await Promise.all((await scheduler.tick(clock.now())).map((run) => run.done));
    await app.container.make(ErrorReports).flush();
    expect(reported).toMatchObject([{ source: 'schedule', error: { message: 'the report service is down' }, context: { task: 'failing' } }]);
    // The log line is the one it was before.
    expect(log.entries).toContainEqual(expect.objectContaining({ level: 'error', message: 'Failed: failing', context: expect.objectContaining({ channel: 'schedule', exception: 'Error: the report service is down' }) }));
    await app.shutdown();
  });

  it("logs a failed run, a failing listener and a failed tick masked by the app's Redactor — the session cookie an error quotes stays out", async () => {
    const leaky = 'Cookie: a=1; marmeon_session=s3ss10nvalue';
    class LeakyTask {
      handle() {
        throw new Error(`the store refused ${leaky}`);
      }
    }
    class LeakyAlert {
      handle() {
        throw new Error(`the pager refused ${leaky}`);
      }
    }
    const { scheduler, app, clock, log } = await boot(defineSchedule((s) => void s.call(LeakyTask).everyMinute().name('leaky')), {
      listeners: [listen(ScheduledTaskFailed, LeakyAlert)],
    });
    // What the session package does at boot: the session cookie's name joins the app's Redactor.
    app.container.make(Redactor).addKeys('marmeon_session');
    await Promise.all((await scheduler.tick(clock.now())).map((run) => run.done));
    // The loop of schedule:work, with the app's Redactor: a tick that fails (the cache is down) is logged and the loop goes on.
    const stop = new AbortController();
    const failing = { tick: () => Promise.reject(new Error(`the cache refused ${leaky}`)) } as unknown as Scheduler;
    let sleeps = 0;
    await new ScheduleWorker(failing, clock, log, app.container.make(Redactor)).run({
      signal: stop.signal,
      // One tick (it fails), then the loop is stopped while it sleeps.
      sleep: async (ms) => {
        if (++sleeps > 1) stop.abort();
        clock.travel({ milliseconds: ms });
        await Promise.resolve();
      },
    });
    const logged = JSON.stringify(log.entries);
    expect(logged, `the session id reached the log: ${logged}`).not.toContain('s3ss10nvalue');
    expect(log.entries).toContainEqual(expect.objectContaining({ message: 'Failed: leaky', context: expect.objectContaining({ exception: 'Error: the store refused Cookie: [redacted]; marmeon_session=[redacted]' }) }));
    expect(log.entries.map((entry) => entry.message)).toContain('A listener of ScheduledTaskFailed failed: the pager refused Cookie: [redacted]; marmeon_session=[redacted]');
    expect(log.entries).toContainEqual(expect.objectContaining({ message: 'The scheduler could not tick', context: expect.objectContaining({ exception: 'Error: the cache refused Cookie: [redacted]; marmeon_session=[redacted]' }) }));
    await app.shutdown();
  });

  describe('the output of schedule:run and schedule:test', () => {
    async function print(schedule: ModuleDefinition['schedule'], command: 'schedule:run' | 'schedule:test' | 'schedule:list', args: string[] = []) {
      const { app, scheduler } = await boot(schedule);
      app.container.make(Redactor).addKeys('marmeon_session');
      const out: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((text) => (out.push(String(text)), true));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => (out.push(String(text)), true));
      try {
        const Command = app.container.make(CommandRegistry).get(command)!;
        const code = await (app.container.make(Command) as { handle(input: unknown): Promise<number> }).handle({ args, options: {}, output: new Output(), root: app.root });
        return { code, text: out.join(''), warning: scheduler.lockWarning() };
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        await app.shutdown();
      }
    }
    const throwing = (message: string, name = 'leaky') =>
      defineSchedule((s) => {
        s.call(
          class {
            handle() {
              throw new Error(message);
            }
          },
        )
          .everyMinute()
          .name(name);
      });

    it.each(['schedule:run', 'schedule:test'] as const)('%s masks a secret in the error', async (command) => {
      const { code, text } = await print(throwing('the store refused Cookie: a=1; marmeon_session=s3ss10nvalue'), command, command === 'schedule:test' ? ['leaky'] : []);
      expect(code).toBe(1);
      expect(text, text).not.toContain('s3ss10nvalue');
      expect(text).toContain('[redacted]');
    });

    it.each(['schedule:run', 'schedule:test'] as const)('%s escapes control characters in the error: one line', async (command) => {
      const { text } = await print(throwing('boom\nFORGED\u001b]52;c;eA==\u0007'), command, command === 'schedule:test' ? ['leaky'] : []);
      expect(text.trimEnd().split('\n')).toHaveLength(1);
      expect(text).toContain('boom\\nFORGED\\u001b]52;c;eA==\\u0007');
      expect(text).not.toContain('\u001b]52');
    });

    it('masks and escapes a task name — in the result line, the task list and the lock warning', async () => {
      const schedule = defineSchedule((s) => {
        s.command('fixture:prune', ['--token=t0kenvalue']).everyMinute().onOneServer();
        s.call(CountRun).everyMinute().name('esc\nape');
      });
      const run = await print(schedule, 'schedule:run');
      expect(run.text, run.text).not.toContain('t0kenvalue');
      expect(run.text).toContain('esc\\nape: ran');
      // One line per task, plus the lock warning.
      expect(run.text.trimEnd().split('\n')).toHaveLength(3);
      expect(run.warning).not.toContain('t0kenvalue');
      const asked = await print(schedule, 'schedule:test', ['fixture:prune', '--token=t0kenvalue']);
      expect(asked.text).not.toContain('t0kenvalue');
      expect(asked.text).toContain('--token=[redacted]');
      // The "Which task?" list and the unknown-name message list every name.
      await expect(print(schedule, 'schedule:test')).rejects.toThrow(/--token=\[redacted\]/);
      await expect(print(schedule, 'schedule:test')).rejects.not.toThrow('t0kenvalue');
      await expect(print(schedule, 'schedule:test', ['nope'])).rejects.toThrow(/--token=\[redacted\]/);
      await expect(print(schedule, 'schedule:test', ['nope'])).rejects.not.toThrow('t0kenvalue');
    });

    describe('the lock warning and the process check in the output of the schedule commands', () => {
      const locking = defineSchedule((s) => void s.call(CountRun).everyMinute().name('lock\nname').onOneServer());

      it.each(['schedule:run', 'schedule:list'] as const)('%s prints the lock warning on one line, a control character in a task name escaped', async (command) => {
        const { text } = await print(locking, command);
        const warning = text.split('\n').filter((line) => line.includes('Tasks:'));
        expect(warning).toHaveLength(1);
        expect(warning[0]).toContain('Tasks: lock\\nname');
        // The table row of schedule:list is one line as well.
        if (command === 'schedule:list') expect(text.split('\n').filter((line) => line.includes('lock\\nname') && line.includes('* * * * *'))).toHaveLength(1);
      });

      it('schedule:run says a command the app does not have masked: the name may hold an argument', async () => {
        const { code, text } = await print(defineSchedule((s) => void s.command('nosuch --token=t0kenvalue').everyMinute()), 'schedule:run');
        expect(code).toBe(1);
        expect(text).toContain('--token=[redacted]');
        expect(text).not.toContain('t0kenvalue');
      });
    });
  });

  it('a run that does not happen: Skipped with why — filter, overlapping', async () => {
    const { scheduler, events, app, clock, gate } = await withEvents(
      defineSchedule((s) => {
        s.call(CountRun).everyMinute().name('never').when(() => false);
        s.call(SlowTask).everyMinute().name('slow').withoutOverlapping();
      }),
    );
    const first = await scheduler.tick(clock.now());
    const second = await scheduler.tick(clock.travel({ minutes: 1 }));
    await Promise.all(second.map((run) => run.done));
    gate.open();
    await Promise.all(first.map((run) => run.done));
    expect(events.filter((event) => event instanceof ScheduledTaskSkipped).map((event) => [event.task, (event as ScheduledTaskSkipped).skipped])).toEqual([
      ['never', 'filter'],
      ['never', 'filter'],
      ['slow', 'overlapping'],
    ]);
    await app.shutdown();
  });

  it('are in a test app\'s app.events like every event — through the dispatcher, not around it', async () => {
    const fake = new EventFake(new EventRegistry(), []);
    const { schedule, app } = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')), { eventFake: fake });
    await schedule.runTask('count');
    fake.assertDispatched(ScheduledTaskStarting, (event) => event.task === 'count');
    fake.assertDispatched(ScheduledTaskFinished);
    fake.assertNotDispatched(ScheduledTaskFailed);
    await app.shutdown();
  });
});

describe('the schedule.task channel', () => {
  it('traces each run for its app — with the outcome and the error', async () => {
    const one = await boot(defineSchedule((s) => {
      s.call(CountRun).everyMinute().name('count');
      s.call(FailingTask).everyMinute().name('failing');
    }));
    const other = await boot(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')));
    const ended: ScheduleTaskMessage[] = [];
    const off = channels.subscribe(one.app, 'schedule.task', { end: (message) => void ended.push(message) });
    try {
      await Promise.all((await one.scheduler.tick(one.clock.now())).map((run) => run.done));
      await Promise.all((await other.scheduler.tick(other.clock.now())).map((run) => run.done));
    } finally {
      off();
    }
    expect(ended.map((message) => [message.task, message.outcome, message.reason, message.dueAt]).sort()).toEqual([
      ['count', 'ran', 'due', START],
      ['failing', 'failed', 'due', START],
    ]);
    expect((ended.find((message) => message.task === 'failing')!.error as Error).message).toBe('the report service is down');
    expect(ended.every((message) => message.app === one.app && typeof message.durationMs === 'number')).toBe(true);
    await one.app.shutdown();
    await other.app.shutdown();
  });
});

describe('s.job()', () => {
  async function withQueue(schedule: ModuleDefinition['schedule'], extra: { providers?: ServiceProviderClass[]; modules?: ModuleDefinition[]; env?: Record<string, string> } = {}) {
    const dir = tempDir('marmeon-schedule-queue-');
    const booted = await boot(schedule, {
      providers: [EncryptionServiceProvider, DatabaseServiceProvider, QueueServiceProvider, ...(extra.providers ?? [])],
      env: { APP_KEY: generateKey(), DB_MANAGED: 'false', DB_DATABASE: join(dir, 'app.sqlite'), QUEUE_DRIVER: 'database', CACHE_DRIVER: 'database', ...extra.env },
      modules: extra.modules ?? [defineModule({ name: 'jobs', jobs: [StatsJob] })],
    });
    for (const file of [QUEUE_MIGRATION, CACHE_MIGRATION]) await runMigration(booted.app.container.make(Connections), ((await import(file.href)) as { default: Migration }).default);
    return booted;
  }

  it('workers stopped, due every minute: one waiting job, not one per minute — a new one once a worker took it', async () => {
    const { scheduler, clock, app } = await withQueue(defineSchedule((s) => void s.job(StatsJob, { scope: 'all' }).everyMinute()));
    const queue = app.container.make(Queue);
    const outcomes: string[] = [];
    for (let minute = 0; minute < 10; minute++) {
      for (const run of await scheduler.tick(clock.now() + minute * MINUTE)) outcomes.push((await run.done).skipped ?? 'queued');
    }
    expect(outcomes).toEqual(['queued', ...Array<string>(9).fill('job-waiting')]);
    expect(await queue.size()).toBe(1);
    // A worker starts it (unique until processing): the next tick queues the next one.
    await app.container.make(QueueConnections).worker('database', 1).run({ queues: ['default'], stopWhenEmpty: true, sleep: 0 });
    expect(await queue.size()).toBe(0);
    for (const run of await scheduler.tick(clock.now() + 10 * MINUTE)) expect((await run.done).outcome).toBe('ran');
    expect(await queue.size()).toBe(1);
    await app.shutdown();
  });

  it('names a job no module registers when the scheduler starts', async () => {
    const { scheduler, app } = await boot(defineSchedule((s) => void s.job(StatsJob, { scope: 'x' }).hourly()), {
      providers: [EncryptionServiceProvider, DatabaseServiceProvider, QueueServiceProvider],
      env: { APP_KEY: generateKey(), DB_MANAGED: 'false', DB_DATABASE: ':memory:' },
    });
    await expect(scheduler.checkProcess()).rejects.toThrow('The schedule of module fixture queues StatsJob ("fixture.stats"), which is no module\'s job — add it to jobs: [...] of its module, or no worker can run it.');
    await app.shutdown();
  });

  describe('a job name that belongs to another class', () => {
    const MARK = 'but this app registers that job name for';
    const warned = (text: string) => text.split('\n').filter((line) => line.includes(MARK));
    const full = (task: string, mine: string, job: string, other: string) =>
      `The task "${task}" queues ${mine} ("${job}"), ${MARK} ${other}. The queue of @marmeon/queue refuses ${mine}, so the task's runs fail. Schedule the class the app registers, or a job class of your own (not a subclass of it) with another job name (not under marmeon.), listed in a module's jobs.`;
    const TWO_COPIES = ' Two classes with one name also come from an app that loads two copies of one package: load one.';

    /** The decisive case: the provider registers `PkgJob`; the app schedules a subclass that inherits its name and another class under it. */
    const mismatched = () =>
      defineSchedule((s) => {
        s.job(PkgChildJob, { scope: 'child' }).everyMinute().name('child');
        s.job(PkgOtherJob, { scope: 'other' }).everyMinute().name('other');
        s.call(CountRun).everyMinute().name('count');
      });
    const withPackage = (schedule: ModuleDefinition['schedule'], extra: Parameters<typeof withQueue>[1] = {}) => withQueue(schedule, { modules: [], providers: [providerOfJobs(PkgJob)], ...extra });

    /** What the function says for `tasks` in `app`: the lines it hands to its `warn`. */
    async function said(app: Application, tasks: readonly unknown[]) {
      const lines: string[] = [];
      await warnJobNames(tasks as never, app, (text) => void lines.push(text));
      return lines;
    }
    /** A job task as the scheduler holds it. */
    const jobTask = (name: string, target: unknown, environments?: string[]) => ({ name, definition: { kind: 'job', target, environments } });

    /** `schedule:work` as the process runs it: stopped by SIGTERM after its start line — or at once, before the check ends. Waits for `lines` warnings. */
    async function work(app: Application, options: { lines?: number; early?: boolean; scheduler?: Scheduler; logger?: Logger; stopTimeout?: string } = {}) {
      const out: string[] = [];
      const wanted = options.lines ?? 0;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      let seen!: () => void;
      const lines = new Promise<void>((resolve) => (seen = resolve));
      if (wanted === 0) seen();
      const record = (text: unknown) => {
        out.push(String(text));
        if (String(text).includes('Running the schedule every minute')) {
          if (options.early) process.emit('SIGTERM');
          started();
        }
        if (warned(out.join('')).length >= wanted) seen();
        return true;
      };
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(record);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(record);
      // The command arms a timer that ends the process after the stop timeout; a test never lets it count down.
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const command = new ScheduleWorkCommand(options.scheduler ?? app.container.make(Scheduler), app.container.make(Clock), options.logger ?? app.container.make(Logger), app.container.make(Redactor), app);
      const done = (command as unknown as { handle(input: unknown): Promise<number> }).handle({ args: [], options: { 'stop-timeout': options.stopTimeout ?? '0' }, output: new Output(), root: app.root });
      try {
        await running;
        process.emit('SIGTERM');
        const code = await done;
        await lines;
        return { code, text: out.join('') };
      } finally {
        // A red run must not leave the loop sleeping.
        process.emit('SIGTERM');
        vi.useRealTimers();
        stdout.mockRestore();
        stderr.mockRestore();
      }
    }

    /** `schedule:run` or `schedule:test`: output and exit code. */
    async function once(app: Application, command: 'schedule:run' | 'schedule:test', args: string[] = []) {
      const out: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((text) => (out.push(String(text)), true));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text) => (out.push(String(text)), true));
      try {
        const Command = app.container.make(CommandRegistry).get(command)!;
        const code = await (app.container.make(Command) as { handle(input: unknown): Promise<number> }).handle({ args, options: {}, output: new Output(), root: app.root });
        return { code, text: out.join('') };
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    }

    it('schedule:work prints one line per task at its start, exits 0 and keeps no other line from the scheduler', { timeout: 20_000 }, async () => {
      const { app, log } = await withPackage(mismatched());
      const { code, text } = await work(app, { lines: 2 });
      expect(code).toBe(0);
      expect(text).toContain('Running the schedule every minute: 3 tasks (child, other, count)');
      expect(warned(text)).toHaveLength(2);
      expect(text).toContain(full('child', 'PkgChildJob', 'pkg.sync', 'PkgJob'));
      expect(text).toContain(full('other', 'PkgOtherJob', 'pkg.sync', 'PkgJob'));
      expect(log.entries.some((entry) => entry.message === 'Scheduler stopped')).toBe(true);
      expect(log.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
      await app.shutdown();
    });

    it('schedule:work accepts the longest --stop-timeout, 2073600 seconds', { timeout: 20_000 }, async () => {
      const { app } = await withQueue(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count')));
      expect((await work(app, { stopTimeout: '2073600' })).code).toBe(0);
      await app.shutdown();
    });

    it('a name a module registers for another class warns too — the shape an app has on 1.2.2', { timeout: 20_000 }, async () => {
      class StatsChild extends StatsJob {}
      const { app } = await withQueue(defineSchedule((s) => void s.job(StatsChild, { scope: 'x' }).everyMinute().name('stats-child')));
      const { code, text } = await work(app, { lines: 1 });
      expect(code).toBe(0);
      expect(warned(text)).toEqual([expect.stringContaining(full('stats-child', 'StatsChild', 'fixture.stats', 'StatsJob'))]);
      await app.shutdown();
    });

    it('a clean schedule gets no line: a module job and a provider job', async () => {
      const { app } = await withPackage(
        defineSchedule((s) => {
          s.job(PkgJob, { scope: 'all' }).everyMinute().name('pkg');
          s.job(StatsJob, { scope: 'all' }).everyMinute().name('stats');
        }),
        { modules: [defineModule({ name: 'jobs', jobs: [StatsJob] })] },
      );
      expect(await said(app, app.container.make(Scheduler).tasks)).toEqual([]);
      await app.shutdown();
    });

    it('SIGTERM while the check still runs: the command exits 0 and the line still comes', { timeout: 20_000 }, async () => {
      const { app } = await withPackage(mismatched());
      const { code, text } = await work(app, { lines: 2, early: true });
      expect(code).toBe(0);
      expect(warned(text)).toHaveLength(2);
      await app.shutdown();
    });

    it("an app's own scheduler object with a job task: tasks is read once, the command stops at once and exits 0", { timeout: 20_000 }, async () => {
      const { app } = await withPackage(defineSchedule(() => {}));
      let reads = 0;
      const own = {
        checkProcess: async () => {},
        lockWarning: () => undefined,
        get tasks() {
          return reads++ === 0 ? [jobTask('child', PkgChildJob)] : undefined;
        },
        tick: async () => [],
        releaseHeld: async () => {},
      } as unknown as Scheduler;
      const { code, text } = await work(app, { scheduler: own, lines: 1, early: true });
      expect(code).toBe(0);
      expect(reads).toBe(1);
      expect(warned(text)).toHaveLength(1);
      await app.shutdown();
    });

    it('reads that throw, or an output that throws, never reach the start: the next task still gets its line', async () => {
      const { app } = await withPackage(defineSchedule(() => {}));
      const throws = () => {
        throw new Error('no');
      };
      await expect(warnJobNames({ filter: throws } as never, app, () => {})).resolves.toBeUndefined();
      await expect(warnJobNames([jobTask('a', PkgChildJob)] as never, { container: { make: throws, has: throws } } as never, () => {})).resolves.toBeUndefined();
      const broken = { name: 'broken', definition: { kind: 'job', target: PkgChildJob, get environments(): never { throw new Error('no environments'); } } };
      expect(await said(app, [broken, jobTask('child', PkgChildJob)])).toEqual([full('child', 'PkgChildJob', 'pkg.sync', 'PkgJob')]);
      let calls = 0;
      await expect(
        warnJobNames([jobTask('child', PkgChildJob), jobTask('other', PkgOtherJob)] as never, app, () => {
          calls++;
          throw new Error('the output is closed');
        }),
      ).resolves.toBeUndefined();
      expect(calls).toBe(2);
      await app.shutdown();
    });

    it('a registry without has, an app without the queue, and a job the app does not know: no line, no throw', async () => {
      const { app } = await withPackage(defineSchedule(() => {}));
      const registry = { get: () => PkgJob };
      const fake = { has: () => true, make: (token: unknown) => (token === ScheduleConfig ? { environment: 'test' } : registry) };
      await expect(warnJobNames([jobTask('child', PkgChildJob)] as never, { container: fake } as never, () => assert.fail('no line'))).resolves.toBeUndefined();
      const bare = await boot(defineSchedule((s) => void s.job(PkgChildJob, { scope: 'x' }).everyMinute().name('child')));
      expect(await said(bare.app, bare.scheduler.tasks)).toEqual([]);
      await bare.app.shutdown();
      expect(await said(app, [jobTask('unknown', StatsJob)])).toEqual([]);
      await app.shutdown();
    });

    it('a logger whose warn rejects sees no call from the new line, and nothing is left unhandled', { timeout: 20_000 }, async () => {
      const { app, log } = await withPackage(mismatched());
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      const calls: string[] = [];
      const rejecting: Logger = {
        debug: () => {},
        info: () => {},
        warn: (message: string) => (calls.push(message), Promise.reject(new Error('the transport is down')) as never),
        error: () => {},
        child: () => rejecting,
      };
      try {
        const { code, text } = await work(app, { lines: 2, logger: rejecting });
        expect(code).toBe(0);
        expect(warned(text)).toHaveLength(2);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(calls).toEqual([]);
      expect(log.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
      expect(unhandled).toEqual([]);
      await app.shutdown();
    });

    it.each(['schedule:run', 'schedule:test'] as const)('%s prints no line: the failed run is reported and the exit code is 1', async (command) => {
      const { app } = await withPackage(mismatched());
      const { code, text } = await once(app, command, command === 'schedule:test' ? ['child'] : []);
      expect(code).toBe(1);
      expect(text).toContain('child: failed:');
      expect(warned(text)).toEqual([]);
      if (command === 'schedule:run') expect(text).toContain('count: ran');
      await app.shutdown();
    });

    it("the failed run says what the line says, in the queue's words", async () => {
      const { app, scheduler, clock, runs } = await withPackage(mismatched());
      await expect(scheduler.checkProcess()).resolves.toBeUndefined();
      const results = await Promise.all((await scheduler.tick(clock.now())).map((tick) => tick.done));
      expect(results.map((result) => [result.task, result.outcome]).sort()).toEqual([['child', 'failed'], ['count', 'ran'], ['other', 'failed']]);
      expect((results.find((result) => result.task === 'child')!.error as Error).message).toBe('PkgChildJob is named "pkg.sync", but that name belongs to PkgJob in this app\'s jobs.');
      expect(runs.count('count')).toBe(1);
      await app.shutdown();
    });

    it('names that cannot be shown: empty, a Symbol, a method, a getter that throws, both unnamed', async () => {
      const variant = (define: (job: JobClass) => void) => {
        const job = class {
          static readonly job = 'pkg.sync';
          static readonly schema = v.object({ scope: v.string() });
          handle() {}
        };
        define(job);
        return job;
      };
      const { app } = await withPackage(defineSchedule(() => {}));
      const table: [string, JobClass][] = [
        ['empty', variant((job) => Object.defineProperty(job, 'name', { value: '' }))],
        ['symbol', variant((job) => Object.defineProperty(job, 'name', { value: Symbol('sym') }))],
        ['method', variant((job) => Object.defineProperty(job, 'name', { value() {} }))],
        [
          'getter',
          variant((job) =>
            Object.defineProperty(job, 'name', {
              get() {
                throw new Error('no name');
              },
            }),
          ),
        ],
      ];
      for (const [, job] of table) expect(await said(app, [jobTask('t', job)]), String(table.findIndex(([, other]) => other === job))).toEqual([full('t', '(unnamed class)', 'pkg.sync', 'PkgJob')]);
      await app.shutdown();
      const unnamed = variant((job) => Object.defineProperty(job, 'name', { value: '' }));
      const both = await withQueue(defineSchedule(() => {}), { modules: [], providers: [providerOfJobs(unnamed)] });
      expect(await said(both.app, [jobTask('t', variant((job) => Object.defineProperty(job, 'name', { value: '' })))])).toEqual([full('t', '(unnamed class)', 'pkg.sync', 'another class') + TWO_COPIES]);
      await both.app.shutdown();
    });

    it('two copies of one class: the line says "another class" and names the two copies', async () => {
      const copy = class PkgJob {
        static readonly job = 'pkg.sync';
        static readonly schema = v.object({ scope: v.string() });
        handle() {}
      };
      const { app } = await withPackage(defineSchedule(() => {}));
      expect(await said(app, [jobTask('copy', copy)])).toEqual([full('copy', 'PkgJob', 'pkg.sync', 'another class') + TWO_COPIES]);
      await app.shutdown();
    });

    it('the line holds neither the secret of a task name nor a control character', { timeout: 20_000 }, async () => {
      const { app } = await withPackage(defineSchedule((s) => void s.job(PkgChildJob, { scope: 'x' }).everyMinute().name('esc\nape Cookie: a=1; marmeon_session=s3ss10nvalue')));
      app.container.make(Redactor).addKeys('marmeon_session');
      const { text } = await work(app, { lines: 1 });
      expect(text).not.toContain('s3ss10nvalue');
      expect(warned(text)).toHaveLength(1);
      expect(text).toContain('The task "esc\\nape Cookie: [redacted]; marmeon_session=[redacted]" queues PkgChildJob');
      await app.shutdown();
    });

    it('a task of another environment gets no line; an unknown name there is refused as before', async () => {
      const elsewhere = await withPackage(defineSchedule((s) => void s.job(PkgOtherJob, { scope: 'x' }).everyMinute().environments('production').name('prod-only')));
      expect(await said(elsewhere.app, elsewhere.scheduler.tasks)).toEqual([]);
      await expect(elsewhere.scheduler.checkProcess()).resolves.toBeUndefined();
      await elsewhere.app.shutdown();
      const unknown = await withPackage(defineSchedule((s) => void s.job(StatsJob, { scope: 'x' }).everyMinute().environments('production').name('prod-only')));
      await expect(unknown.scheduler.checkProcess()).rejects.toThrow('The schedule of module fixture queues StatsJob ("fixture.stats"), which is no module\'s job — add it to jobs: [...] of its module, or no worker can run it.');
      await unknown.app.shutdown();
    });

    it('a task limited to the own environment warns; a production app warns for production, not for local', { timeout: 20_000 }, async () => {
      const mine = await withPackage(defineSchedule(() => {}));
      const environment = mine.app.container.make(ScheduleConfig).environment;
      expect(await said(mine.app, [jobTask('here', PkgChildJob, [environment]), jobTask('there', PkgChildJob, [`not-${environment}`])])).toEqual([full('here', 'PkgChildJob', 'pkg.sync', 'PkgJob')]);
      await mine.app.shutdown();
      const production = await withPackage(
        defineSchedule((s) => {
          s.job(PkgChildJob, { scope: 'p' }).everyMinute().environments('production').name('for-production');
          s.job(PkgChildJob, { scope: 'l' }).everyMinute().environments('local').name('for-local');
        }),
        { env: { NODE_ENV: 'production' } },
      );
      expect(await said(production.app, production.scheduler.tasks)).toEqual([full('for-production', 'PkgChildJob', 'pkg.sync', 'PkgJob')]);
      await production.app.shutdown();
    });

    it('command and call tasks only: the queue is neither read nor made', async () => {
      const { app } = await withPackage(defineSchedule(() => {}));
      let touched = 0;
      const counting = { container: { make: () => touched++, has: () => touched++ } };
      await expect(warnJobNames([{ name: 'c', definition: { kind: 'command', target: 'x' } }, { name: 'k', definition: { kind: 'call', target: CountRun } }] as never, counting as never, () => assert.fail('no line'))).resolves.toBeUndefined();
      expect(touched).toBe(0);
      await app.shutdown();
    });

    it('a check that never settles does not hold up the start: SIGTERM still exits 0', { timeout: 20_000 }, async () => {
      const { app } = await withPackage(mismatched());
      check.neverSettle = true;
      try {
        const { code, text } = await work(app);
        expect(code).toBe(0);
        expect(warned(text)).toEqual([]);
      } finally {
        check.neverSettle = false;
      }
      await app.shutdown();
    });

    it('a clean schedule prints no line at command level once the check has ended', { timeout: 20_000 }, async () => {
      const { app } = await withPackage(defineSchedule((s) => void s.job(PkgJob, { scope: 'all' }).everyMinute().name('pkg')));
      check.kept.length = 0;
      const { code, text } = await work(app);
      await Promise.all(check.kept);
      expect(code).toBe(0);
      expect(check.kept).toHaveLength(1);
      expect(warned(text)).toEqual([]);
      await app.shutdown();
    });

    it('an unknown name still refuses the start, with the text it had', async () => {
      const { app, scheduler } = await withPackage(defineSchedule((s) => void s.job(StatsJob, { scope: 'x' }).everyMinute()));
      await expect(scheduler.checkProcess()).rejects.toThrow('The schedule of module fixture queues StatsJob ("fixture.stats"), which is no module\'s job — add it to jobs: [...] of its module, or no worker can run it.');
      await app.shutdown();
    });

    it('the advice works: the registered class, or a class of your own with another name in a module\'s jobs', async () => {
      class OwnJob {
        static readonly job = 'app.sync';
        static readonly schema = v.object({ scope: v.string() });
        handle(_payload: JobPayload<typeof OwnJob>) {}
      }
      const { app, scheduler, clock } = await withPackage(
        defineSchedule((s) => {
          s.job(PkgJob, { scope: 'registered' }).everyMinute().name('registered');
          s.job(OwnJob, { scope: 'own' }).everyMinute().name('own');
        }),
        { modules: [defineModule({ name: 'own', jobs: [OwnJob] })] },
      );
      await expect(scheduler.checkProcess()).resolves.toBeUndefined();
      expect(await said(app, scheduler.tasks)).toEqual([]);
      const results = await Promise.all((await scheduler.tick(clock.now())).map((tick) => tick.done));
      expect(results.map((result) => [result.task, result.outcome]).sort()).toEqual([['own', 'ran'], ['registered', 'ran']]);
      expect(await app.container.make(Queue).size()).toBe(2);
      await app.shutdown();
    });
  });
});

describe('the provider', () => {
  it('adds the schedule:* commands — and marmeon dev runs schedule:work only when the app schedules something', async () => {
    const some = await boot(defineSchedule((s) => void s.call(CountRun).hourly()));
    expect(some.app.container.make(CommandRegistry).all().map((command) => command.command)).toEqual(expect.arrayContaining(['schedule:work', 'schedule:run', 'schedule:list', 'schedule:test']));
    expect(some.app.container.make(DevProcesses).all()).toEqual([{ name: 'schedule', args: ['schedule:work', '--stop-timeout=5'] }]);
    await some.app.shutdown();
    const none = await boot(defineSchedule(() => {}));
    expect(none.app.container.make(DevProcesses).all()).toEqual([]);
    await none.app.shutdown();
  });

  it('lists the schedule:* commands while the app only registers (marmeon build)', async () => {
    const built = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [CliServiceProvider, SchedulerServiceProvider],
    }, { phase: 'build', env: { NODE_ENV: 'test', CACHE_DRIVER: 'memory' } });
    expect(built.container.make(CommandRegistry).all().map((command) => command.command)).toEqual(expect.arrayContaining(['schedule:work', 'schedule:run', 'schedule:list', 'schedule:test']));
  });
});

describe('a schedule set up wrongly', () => {
  it('fails the start: no frequency, two tasks with one name, an invalid expression or time zone', async () => {
    await expect(boot(defineSchedule((s) => void s.call(CountRun)))).rejects.toThrow('[marmeon:Q5] The task "CountRun" (schedule of module fixture) has no frequency — add one: .daily(), .everyFifteenMinutes(), .cron(\'…\').');
    await expect(boot(defineSchedule((s) => (s.call(CountRun).daily(), void s.call(CountRun).hourly())))).rejects.toThrow(
      'Two scheduled tasks are named "CountRun" (modules fixture and fixture) — the name keys their locks: give one a name of its own with .name(\'…\').',
    );
    await expect(boot(defineSchedule((s) => void s.call(CountRun).cron('*/5 25 * * *')))).rejects.toThrow('The task "CountRun" (schedule of module fixture): Invalid cron expression "*/5 25 * * *": the hour field "25" has 25, outside 0–23.');
    await expect(boot(defineSchedule((s) => void s.call(CountRun).daily().timeZone('Europe/Berln')))).rejects.toThrow('"Europe/Berln" is not a time zone');
    await expect(boot(defineSchedule((s) => void s.call(CountRun).daily().at('24:00' as string)))).rejects.toThrow("at(): \"24:00\" is not a time of day — use HH:MM, like '03:10'");
    await expect(boot(defineSchedule(() => {}), { env: { SCHEDULE_TIMEZONE: 'Mars/Olympus' } })).rejects.toThrow(/SCHEDULE_TIMEZONE/);
  });

  it('names an unknown command when the scheduler starts — with the closest one', async () => {
    const { scheduler, app } = await boot(defineSchedule((s) => void s.command('fixture:prnue').daily()));
    await expect(scheduler.checkProcess()).rejects.toThrow('The schedule of module fixture runs the command "fixture:prnue", which the app does not have. Did you mean "fixture:prune"?');
    await app.shutdown();
  });

  it('does not ask for a command limited to other environments — its package may be a dev dependency (devtools:prune)', async () => {
    const elsewhere = await boot(defineSchedule((s) => void s.command('devtools:prune').hourly().environments('local')), { env: { NODE_ENV: 'production' } });
    await expect(elsewhere.scheduler.checkProcess()).resolves.toBeUndefined();
    await elsewhere.app.shutdown();
    const here = await boot(defineSchedule((s) => void s.command('devtools:prune').hourly().environments('local')), { env: { NODE_ENV: 'development' } });
    await expect(here.scheduler.checkProcess()).rejects.toThrow('runs the command "devtools:prune", which the app does not have.');
    await here.app.shutdown();
  });

  it('counts a missing NODE_ENV as production for environments() — protected like production', async () => {
    const schedule = defineSchedule((s) => {
      s.call(CountRun).hourly().environments('production').name('production-only');
      s.call(CountRun).hourly().environments('local').name('local-only');
    });
    const unset = await boot(schedule, { env: { NODE_ENV: '' } });
    expect(unset.schedule.due('2026-10-05T11:00:00Z')).toEqual(['production-only']);
    await unset.app.shutdown();
  });

  it('selects the tasks by APP_ENV: a staging server runs its staging tasks and leaves production\'s out', async () => {
    const schedule = defineSchedule((s) => {
      s.call(CountRun).hourly().environments('production').name('production-only');
      s.call(CountRun).hourly().environments('staging').name('staging-only');
      s.call(CountRun).hourly().environments('staging', 'production').name('both');
      s.call(CountRun).hourly().environments('local').name('local-only');
    });
    const at = '2026-10-05T11:00:00Z';
    const staging = await boot(schedule, { env: { NODE_ENV: 'production', APP_ENV: 'staging' } });
    expect(staging.schedule.due(at), 'NODE_ENV=production APP_ENV=staging').toEqual(['staging-only', 'both']);
    await staging.app.shutdown();
    const production = await boot(schedule, { env: { NODE_ENV: 'production' } });
    expect(production.schedule.due(at), 'NODE_ENV=production (APP_ENV production by default)').toEqual(['production-only', 'both']);
    await production.app.shutdown();
    const development = await boot(schedule, { env: { NODE_ENV: 'development' } });
    expect(development.schedule.due(at), 'NODE_ENV=development (APP_ENV local by default)').toEqual(['local-only']);
    await development.app.shutdown();
  });
});


describe('schedule:list --json', () => {
  afterEach(() => vi.restoreAllMocks());

  async function list(schedule: ModuleDefinition['schedule'], options: Record<string, boolean>, shared = false) {
    const { app } = await boot(schedule, shared ? { providers: [DatabaseServiceProvider], env: { CACHE_DRIVER: 'database', DB_DATABASE: ':memory:' } } : {});
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
    const List = app.container.make(CommandRegistry).get('schedule:list')!;
    const code = (app.container.make(List) as { handle(input: unknown): number }).handle({ args: [], options, output: new Output(), root: app.root });
    vi.restoreAllMocks();
    await app.shutdown();
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  const tasks = defineSchedule((s) => {
    s.call(CountRun).everyMinute().name('plain');
    s.call(CountRun).daily().at('03:10').timeZone('Europe/Berlin').name('berlin').description('Rebuilds the night report').onOneServer().withoutOverlapping({ expiresAfter: { minutes: 30 } }).catchUp('skip').environments('production', 'local').when(() => true);
    s.call(CountRun).cron('0 0 30 2 *').name('never');
    s.job(StatsJob, { scope: 'all' }).hourly().name('stats');
    s.command('fixture:prune', ['--days=30']).daily().name('prune');
  });

  it('prints one document that pins every field of every variant, in the stored format', async () => {
    const { code, stdout, stderr } = await list(tasks, { json: true }, true);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.endsWith('\n')).toBe(true);
    const document = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(document)[0]).toBe('format');
    const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-schedule-list/v2.json', import.meta.url), 'utf8'));
    expect(document).toMatchObject(fixture);
    // toMatchObject ignores extra keys: the lists and the options of each task are exactly these.
    expect((document.tasks as Record<string, unknown>[]).map((task) => Object.keys(task))).toEqual(Array(5).fill(['name', 'expression', 'timeZone', 'next', 'does', 'description', 'options']));
    expect((document.tasks as { options: object }[]).map((task) => Object.keys(task.options))).toEqual(Array(5).fill(['oneServer', 'overlapSeconds', 'catchUp', 'environments', 'filtered']));
  });

  it('keeps every older format in the directory: version 1 named the lock in minutes and had no description', () => {
    const directory = new URL('./__fixtures__/formats/cli-schedule-list/', import.meta.url);
    expect(readdirSync(directory).sort()).toEqual(['v1.json', 'v2.json']);
    const v1 = JSON.parse(readFileSync(new URL('v1.json', directory), 'utf8')) as { format: number; tasks: { description?: unknown; options: Record<string, unknown> }[] };
    expect(v1.format).toBe(1);
    expect(v1.tasks.map((task) => Object.keys(task.options)[1])).toEqual(Array(5).fill('overlapMinutes'));
    expect(v1.tasks.some((task) => 'description' in task)).toBe(false);
    // Version 1 reads as version 2: minutes become seconds, and a missing description reads as null.
    const v2 = JSON.parse(readFileSync(new URL('v2.json', directory), 'utf8')) as { tasks: { description: string | null; options: Record<string, unknown> }[] };
    const asV2 = v1.tasks.map((task) => (task.options.overlapMinutes === null ? null : (task.options.overlapMinutes as number) * 60));
    expect(asV2).toEqual(v2.tasks.map((task) => task.options.overlapSeconds));
  });

  it('shows .description() under the task in the table', async () => {
    const table = await list(tasks, {}, true);
    const lines = table.stdout.split('\n');
    const berlin = lines.findIndex((line) => line.startsWith('berlin'));
    expect(lines[berlin + 1]).toMatch(/^ {2}Rebuilds the night report\s*$/);
    expect(lines.filter((line) => line.includes('Rebuilds the night report'))).toHaveLength(1);
    // The note is outside the columns: a long description does not widen the Task column.
    expect(lines.find((line) => line.startsWith('plain'))).toMatch(/^plain {3}\* \* \* \* \*/);
  });

  it('puts the lock warning in warnings, and keeps it off stdout apart from that', async () => {
    const { stdout, stderr } = await list(defineSchedule((s) => void s.call(CountRun).everyMinute().name('count').withoutOverlapping()), { json: true });
    expect(JSON.parse(stdout).warnings).toEqual([expect.stringContaining('withoutOverlapping() locks in CACHE_DRIVER=memory')]);
    expect(stderr).toBe('');
  });

  it('prints an empty list as a document, and the table without --json', async () => {
    const empty = await list(defineSchedule(() => {}), { json: true });
    expect(JSON.parse(empty.stdout)).toEqual({ format: 2, tasks: [], warnings: [] });
    const table = await list(tasks, {}, true);
    expect(table.stdout).toMatch(/^Task\s+Schedule\s+Next run/);
    expect(table.stdout).toContain('one server, no overlap, no catch-up, only production/local, filtered');
  });
});

describe('schedule:list masks secrets', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows no job payload value or command argument the redactor knows, in the table or the document', async () => {
    const { app } = await boot(
      defineSchedule((s) => {
        s.job(StatsJob, { scope: 'all', apiKey: 'geheim' } as never).hourly();
        s.command('fixture:prune', ['--password=geheim']).daily();
      }),
    );
    const List = app.container.make(CommandRegistry).get('schedule:list')!;
    for (const options of [{ json: true }, {}]) {
      const stdout: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
      (app.container.make(List) as { handle(input: unknown): number }).handle({ args: [], options, output: new Output(), root: app.root });
      vi.restoreAllMocks();
      expect(stdout.join(''), JSON.stringify(options)).not.toContain('geheim');
      expect(stdout.join('')).toContain('fixture.stats');
    }
    await app.shutdown();
  });
});

describe('s.job() next to a job named <job>:schedule', () => {
  class ReportsJob {
    static readonly job = 'reports';
    static readonly schema = v.object({});
    handle() {}
  }
  class ReportsScheduleJob {
    static readonly job = 'reports:schedule';
    static readonly schema = v.object({});
    handle() {}
  }

  class PickyJob {
    static readonly job = 'picky';
    static readonly schema = v.object({ n: v.number() });
    handle() {}
  }

  async function withJobs(jobs: JobClass[], schedule: ModuleDefinition['schedule'] = defineSchedule((s) => void s.job(ReportsJob).everyMinute().name('reports-task')), driver = 'database') {
    const dir = tempDir('marmeon-schedule-queue-');
    const booted = await boot(
      schedule,
      {
        providers: [EncryptionServiceProvider, DatabaseServiceProvider, QueueServiceProvider],
        env: { APP_KEY: generateKey(), DB_MANAGED: 'false', DB_DATABASE: join(dir, 'app.sqlite'), QUEUE_DRIVER: driver, CACHE_DRIVER: 'database' },
        modules: [defineModule({ name: 'jobs', jobs })],
      },
    );
    for (const file of [QUEUE_MIGRATION, CACHE_MIGRATION]) await runMigration(booted.app.container.make(Connections), ((await import(file.href)) as { default: Migration }).default);
    return booted;
  }

  it('fails the tick with a ScheduleError that names the task and the job, and not the key', async () => {
    const { scheduler, clock, app } = await withJobs([ReportsJob, ReportsScheduleJob]);
    const [run] = await scheduler.tick(clock.now());
    const result = await run!.done;
    expect(result).toMatchObject({ task: 'reports-task', outcome: 'failed' });
    expect(result.error).toBeInstanceOf(ScheduleError);
    expect((result.error as Error).message).toBe(
      '[marmeon:Q5] The task "reports-task" queues the job "reports", but the app registers a job named "reports:schedule", and the unique key of a scheduled job starts with "schedule:", so both name one lock. Rename "reports:schedule" so it does not begin with "reports:". See docs/queues.md#unique-jobs.',
    );
    expect((result.error as Error).message).not.toContain('schedule:reports-task');
    expect(await app.container.make(Queue).size()).toBe(0);
    await app.shutdown();
  });

  describe('on the sync connection, where the dispatch also runs the job', () => {
    class ReportsDailyJob {
      static readonly job = 'reports:daily';
      static readonly schema = v.object({});
      handle() {}
    }
    class OverlapJob {
      static readonly job = 'reports';
      static readonly schema = v.object({});
      static readonly middleware = [withoutOverlapping('daily:7')];
      handle() {}
    }
    class NestingJob {
      static readonly job = 'nesting';
      static readonly schema = v.object({});
      static readonly inject = [Queue];
      readonly #queue: Queue;
      constructor(queue: Queue) {
        this.#queue = queue;
      }
      async handle() {
        await this.#queue.dispatch(ReportsJob, {}, { unique: 'daily:7' });
      }
    }

    // Dispatches `target` with the unique key it is given, from inside the scheduled job.
    const dispatching = (name: string, target: JobClass, unique: string) =>
      class {
        static readonly job = name;
        static readonly schema = v.object({});
        static readonly inject = [Queue];
        readonly #queue: Queue;
        constructor(queue: Queue) {
          this.#queue = queue;
        }
        async handle() {
          await this.#queue.dispatch(target, {}, { unique });
        }
      };

    async function withSync(jobs: JobClass[], target: JobClass, name: string) {
      const booted = await withJobs(jobs, defineSchedule((s) => void s.job(target).everyMinute().name(name)), 'sync');
      const [run] = await booted.scheduler.tick(booted.clock.now());
      return { ...booted, result: await run!.done };
    }

    it('keeps the JobKeyLockError of a withoutOverlapping() key instead of blaming the unique key of the schedule', async () => {
      const { result, app } = await withSync([OverlapJob, ReportsDailyJob], OverlapJob, 'reports-task');
      expect(result.outcome).toBe('failed');
      expect(result.error).not.toBeInstanceOf(ScheduleError);
      expect(result.error).toMatchObject({ name: 'JobKeyLockError', job: 'reports', other: 'reports:daily', key: 'daily:7', kind: 'overlap' });
      await app.shutdown();
    });

    // The conversion needs all of: the key is the schedule's, the job is the scheduled one, and the kind is `unique`. The kind clause
    // has no test of its own: a key that starts with `schedule:` and meets a lock is refused by the outer dispatch before the job runs,
    // so no `overlap` refusal of the scheduled job reaches the catch; the clause stays as a guard.
    it('keeps the error when the scheduled job dispatches a job of its own name with another unique key (the key clause)', async () => {
      const Self = dispatching('reports', ReportsJob, 'daily:7');
      const { result, app } = await withSync([Self, ReportsDailyJob], Self, 'reports-task');
      expect(result.outcome).toBe('failed');
      expect(result.error).not.toBeInstanceOf(ScheduleError);
      expect(result.error).toMatchObject({ name: 'JobKeyLockError', job: 'reports', other: 'reports:daily', key: 'daily:7', kind: 'unique' });
      await app.shutdown();
    });

    it('keeps the error when another job is refused with the schedule key of the task (the job clause)', async () => {
      const Outer = dispatching('nesting', ReportsJob, 'schedule:nesting-task');
      const { result, app } = await withSync([Outer, ReportsJob, ReportsScheduleJob], Outer, 'nesting-task');
      expect(result.outcome).toBe('failed');
      expect(result.error).not.toBeInstanceOf(ScheduleError);
      expect(result.error).toMatchObject({ name: 'JobKeyLockError', job: 'reports', other: 'reports:schedule', key: 'schedule:nesting-task', kind: 'unique' });
      await app.shutdown();
    });

    it('keeps the JobKeyLockError of a job dispatched from inside the scheduled job', async () => {
      const { result, app } = await withSync([NestingJob, ReportsJob, ReportsDailyJob], NestingJob, 'nesting-task');
      expect(result.outcome).toBe('failed');
      expect(result.error).not.toBeInstanceOf(ScheduleError);
      expect(result.error).toMatchObject({ name: 'JobKeyLockError', job: 'reports', other: 'reports:daily', key: 'daily:7', kind: 'unique' });
      await app.shutdown();
    });
  });

  it('keeps the own error of a dispatch that fails for another reason: a QueueError, not a ScheduleError', async () => {
    const { scheduler, clock, app } = await withJobs([ReportsJob, ReportsScheduleJob, PickyJob], defineSchedule((s) => void s.job(PickyJob, {} as never).everyMinute().name('picky-task')));
    const [run] = await scheduler.tick(clock.now());
    const result = await run!.done;
    expect(result.outcome).toBe('failed');
    expect(result.error).not.toBeInstanceOf(ScheduleError);
    expect(result.error).toBeInstanceOf((await import('@marmeon/queue')).QueueError);
    expect(result.error).toMatchObject({ name: 'JobPayloadError' });
    await app.shutdown();
  });

  it('still queues the job when no job is named <job>:schedule', async () => {
    const { scheduler, clock, app } = await withJobs([ReportsJob]);
    const [run] = await scheduler.tick(clock.now());
    expect((await run!.done).outcome).toBe('ran');
    expect(await app.container.make(Queue).size()).toBe(1);
    await app.shutdown();
  });
});
