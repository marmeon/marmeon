import type { CommandClass } from 'marmeon';
import { durationToSeconds, type Container, type Duration } from '@marmeon/core';
import type { JobClass } from '@marmeon/queue';
import { ScheduleError } from './cron.ts';
import { withCode } from '@marmeon/core/internal';

/** What a task does: queue a job (`s.job`), run a console command (`s.command`), or call a callable task class (`s.call`). */
export type TaskKind = 'job' | 'command' | 'call';

/** A class `s.call()` runs — built through the container in a scope of its own (constructor injection), then `handle()`. */
export interface CallableTask {
  handle(): unknown;
}
export type CallableTaskClass = new (...args: any[]) => CallableTask;

/** A condition of `when()`/`skip()`, asked each time the task is due — with the task's own scope, for services. */
export type TaskFilter = (scope: Container) => boolean | Promise<boolean>;

/** What a task does when the scheduler was not running at a time it was due (a deploy, a paused machine). */
export type CatchUp = 'once' | 'skip';

/** `0` (Sunday) … `6` (Saturday), or the day's English name. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type Hour = Digit | `${'0' | '1'}${Digit}` | `2${'0' | '1' | '2' | '3'}`;
type Minute = `${'0' | '1' | '2' | '3' | '4' | '5'}${Digit}`;
/** A time of day: `'03:10'`, `'9:30'`, `'23:59'`. */
export type TimeOfDay = `${Hour}:${Minute}`;
/** A literal time is checked here; a `string` from elsewhere when the schedule is read. */
export type CheckTime<T extends string> = string extends T ? T : T extends TimeOfDay ? T : 'a time of day like 03:10 — hours 0–23, minutes 00–59';

/** Everything known about a task — what `defineSchedule` collected. Read-only: change a task through its builder. */
export interface TaskDefinition {
  readonly kind: TaskKind;
  readonly target: JobClass | CommandClass | CallableTaskClass | string;
  readonly payload: unknown;
  readonly args: readonly string[];
  /** The module whose schedule defined it — for messages. */
  readonly module: string;
  readonly fields: readonly [minute: string, hour: string, day: string, month: string, weekday: string] | undefined;
  /** Set by `cron()`: the expression as written. */
  readonly expression: string | undefined;
  /** The IANA name `.timeZone()` set; undefined = `SCHEDULE_TIMEZONE`. */
  readonly timeZone: string | undefined;
  readonly when: readonly TaskFilter[];
  readonly skip: readonly TaskFilter[];
  readonly environments: readonly string[] | undefined;
  readonly onOneServer: boolean;
  /** Seconds the overlap lock holds at most (`withoutOverlapping()`), undefined = overlapping allowed. */
  readonly overlapSeconds: number | undefined;
  readonly catchUp: CatchUp;
  readonly name: string | undefined;
  readonly description: string | undefined;
}

/** What the builder fills in; handed out as the read-only {@link TaskDefinition}. */
type Draft = Omit<{ -readonly [K in keyof TaskDefinition]: TaskDefinition[K] }, 'fields' | 'when' | 'skip'> & {
  fields: [minute: string, hour: string, day: string, month: string, weekday: string] | undefined;
  when: TaskFilter[];
  skip: TaskFilter[];
};

/** Options of {@link ScheduledTask.withoutOverlapping}. */
export interface TaskOverlapOptions {
  /** How long the lock holds at most, in case a scheduler dies holding it. Default `{ hours: 24 }`. */
  readonly expiresAfter?: Duration;
}

/** How often — every builder has these; each sets the whole cron expression (a later one replaces an earlier one). */
export interface Frequencies<K extends TaskKind> {
  everyMinute(): ScheduledTask<K>;
  everyTwoMinutes(): ScheduledTask<K>;
  everyThreeMinutes(): ScheduledTask<K>;
  everyFiveMinutes(): ScheduledTask<K>;
  everyTenMinutes(): ScheduledTask<K>;
  everyFifteenMinutes(): ScheduledTask<K>;
  everyThirtyMinutes(): ScheduledTask<K>;
  /** At minute 0 of every hour. */
  hourly(): ScheduledTask<K>;
  /** At `minute` of every hour. */
  hourlyAt(minute: number): ScheduledTask<K>;
  everyTwoHours(): ScheduledTask<K>;
  everyThreeHours(): ScheduledTask<K>;
  everySixHours(): ScheduledTask<K>;
  /** At midnight — `.daily().at('03:10')` for another time. */
  daily(): ScheduledTask<K>;
  dailyAt<const T extends string>(time: CheckTime<T>): ScheduledTask<K>;
  /** Sundays at midnight — `weeklyOn('monday', '08:00')` for another day and time. */
  weekly(): ScheduledTask<K>;
  weeklyOn<const T extends string = '0:00'>(day: Weekday, time?: CheckTime<T>): ScheduledTask<K>;
  /** On the 1st at midnight. */
  monthly(): ScheduledTask<K>;
  monthlyOn<const T extends string = '0:00'>(day: number, time?: CheckTime<T>): ScheduledTask<K>;
  /** On January 1st at midnight. */
  yearly(): ScheduledTask<K>;
  /** A cron expression of its own: `cron('*\/5 9-17 * * mon-fri')`. */
  cron(expression: string): ScheduledTask<K>;
}

/** A task as `s.job()`, `s.command()` and `s.call()` return it: it needs a frequency first. */
export interface UnscheduledTask<K extends TaskKind> extends Frequencies<K> {
  /**
   * The task's name — in `schedule:list`, `schedule:test <name>`, logs and locks. Default: the job's name, the command with its
   * arguments (`queue:prune-failed --hours=168` — the same command with other arguments is another task, with locks of its own),
   * or the class name.
   */
  name(name: string): UnscheduledTask<K>;
  /** A line `schedule:list` shows under the task. */
  description(text: string): UnscheduledTask<K>;
  onOneServer(this: 'Say how often first — .daily().onOneServer(): a task needs a frequency before its options'): never;
  withoutOverlapping(this: 'Say how often first — .everyMinute().withoutOverlapping(): a task needs a frequency before its options'): never;
  at(this: 'at() sets the time of a daily, weekly or monthly task — say how often first: .daily().at(…)', time?: unknown): never;
}

/** The overlap option, by kind: queuing a job takes no time, and `s.job` is unique until the job runs anyway. */
type Overlapping<K extends TaskKind> = K extends 'job'
  ? (this: 's.job() only queues the job — that never overlaps, and the next one is not queued while it still waits. Overlapping runs of the job itself: withoutOverlapping() middleware on the job class') => never
  : (options?: TaskOverlapOptions) => ScheduledTask<K>;

/** A task with a frequency: more options can follow. */
export interface ScheduledTask<K extends TaskKind> extends Frequencies<K> {
  /** The time of day (hour and minute fields): `.daily().at('03:10')`. */
  at<const T extends string>(time: CheckTime<T>): ScheduledTask<K>;
  /** Monday to Friday only. */
  weekdays(): ScheduledTask<K>;
  /** Saturday and Sunday only. */
  weekends(): ScheduledTask<K>;
  /** Only on these days of the week. */
  days(...days: [Weekday, ...Weekday[]]): ScheduledTask<K>;
  /** Whose clocks the times are on (IANA name) — daylight saving time included. Default: `SCHEDULE_TIMEZONE` (UTC). */
  timeZone(timeZone: string): ScheduledTask<K>;
  /** Runs only when `filter` says true (asked each time it is due). */
  when(filter: TaskFilter): ScheduledTask<K>;
  /** Does not run when `filter` says true. */
  skip(filter: TaskFilter): ScheduledTask<K>;
  /** Runs only in these environments — by `APP_ENV` (default `local`, `testing` or `production` by `NODE_ENV`): `.environments('production')`. */
  environments(...names: [string, ...string[]]): ScheduledTask<K>;
  /**
   * Runs on one server only, when several run the scheduler: the first to take the lock `schedule:<name>:<minute>` runs
   * it. Needs a cache all servers share (`database` or `redis`); with `file` or `memory` the scheduler warns at its start.
   */
  onOneServer(): ScheduledTask<K>;
  /**
   * Skips a run while the previous one still runs — on any server (a lock in the cache, which expires after
   * `options.expiresAfter`, default `{ hours: 24 }`, in case a scheduler dies holding it). "Any server" needs a shared cache, like
   * `onOneServer()`: with `file` or `memory` the scheduler warns at its start.
   */
  withoutOverlapping: Overlapping<K>;
  /**
   * When the scheduler was down at a time the task was due: `'once'` (default) runs it once when the scheduler is back,
   * however many times it was missed; `'skip'` waits for the next due time.
   */
  catchUp(mode: CatchUp): ScheduledTask<K>;
  name(name: string): ScheduledTask<K>;
  /** A line `schedule:list` shows under the task. */
  description(text: string): ScheduledTask<K>;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTime(time: unknown, where: string): [minute: string, hour: string] {
  const match = typeof time === 'string' ? TIME.exec(time) : null;
  if (!match) throw new ScheduleError(withCode('Q5', `${where}: ${JSON.stringify(time)} is not a time of day — use HH:MM, like '03:10' (hours 0–23, minutes 00–59).`));
  return [String(Number(match[2])), String(Number(match[1]))];
}

function weekday(day: unknown, where: string): number {
  const index = typeof day === 'string' ? WEEKDAYS.indexOf(day.toLowerCase() as never) : typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6 ? day : -1;
  if (index < 0) throw new ScheduleError(withCode('Q5', `${where}: ${JSON.stringify(day)} is not a day of the week — 0 (Sunday) to 6, or a name like 'monday'.`));
  return index;
}

/** The builder behind every task — one object, typed by stage (`UnscheduledTask` → `ScheduledTask`). */
export class PendingTask {
  readonly #draft: Draft;

  constructor(definition: Pick<TaskDefinition, 'kind' | 'target' | 'payload' | 'args' | 'module'>) {
    this.#draft = {
      ...definition,
      fields: undefined,
      expression: undefined,
      timeZone: undefined,
      when: [],
      skip: [],
      environments: undefined,
      onOneServer: false,
      overlapSeconds: undefined,
      catchUp: 'once',
      name: undefined,
      description: undefined,
    };
  }

  get definition(): TaskDefinition {
    return this.#draft;
  }

  #set(minute: string, hour = '*', day = '*', month = '*', weekday = '*'): this {
    this.#draft.fields = [minute, hour, day, month, weekday];
    this.#draft.expression = undefined;
    return this;
  }

  #every(minutes: number): this {
    return this.#set(`*/${minutes}`);
  }

  everyMinute() {
    return this.#set('*');
  }
  everyTwoMinutes() {
    return this.#every(2);
  }
  everyThreeMinutes() {
    return this.#every(3);
  }
  everyFiveMinutes() {
    return this.#every(5);
  }
  everyTenMinutes() {
    return this.#every(10);
  }
  everyFifteenMinutes() {
    return this.#every(15);
  }
  everyThirtyMinutes() {
    return this.#every(30);
  }
  hourly() {
    return this.#set('0');
  }
  hourlyAt(minute: number) {
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new ScheduleError(withCode('Q5', `hourlyAt(${String(minute)}): the minute is 0–59.`));
    return this.#set(String(minute));
  }
  everyTwoHours() {
    return this.#set('0', '*/2');
  }
  everyThreeHours() {
    return this.#set('0', '*/3');
  }
  everySixHours() {
    return this.#set('0', '*/6');
  }
  daily() {
    return this.#set('0', '0');
  }
  dailyAt(time: string) {
    return this.#set(...parseTime(time, 'dailyAt()'));
  }
  weekly() {
    return this.#set('0', '0', '*', '*', '0');
  }
  weeklyOn(day: Weekday, time = '0:00') {
    const [minute, hour] = parseTime(time, 'weeklyOn()');
    return this.#set(minute, hour, '*', '*', String(weekday(day, 'weeklyOn()')));
  }
  monthly() {
    return this.#set('0', '0', '1');
  }
  monthlyOn(day: number, time = '0:00') {
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new ScheduleError(withCode('Q5', `monthlyOn(${String(day)}): the day of the month is 1–31.`));
    const [minute, hour] = parseTime(time, 'monthlyOn()');
    return this.#set(minute, hour, String(day));
  }
  yearly() {
    return this.#set('0', '0', '1', '1');
  }
  cron(expression: string) {
    if (typeof expression !== 'string') throw new ScheduleError(withCode('Q5', `cron() takes an expression like '*/5 * * * *', not ${JSON.stringify(expression)}.`));
    this.#draft.fields = undefined;
    this.#draft.expression = expression;
    return this;
  }

  at(time: string) {
    const fields = this.#fields('at()');
    [fields[0], fields[1]] = parseTime(time, 'at()');
    return this;
  }
  weekdays() {
    this.#fields('weekdays()')[4] = '1-5';
    return this;
  }
  weekends() {
    this.#fields('weekends()')[4] = '0,6';
    return this;
  }
  days(...days: Weekday[]) {
    if (days.length === 0) throw new ScheduleError(withCode('Q5', 'days() needs at least one day of the week.'));
    this.#fields('days()')[4] = days.map((day) => weekday(day, 'days()')).join(',');
    return this;
  }
  timeZone(timeZone: string) {
    this.#draft.timeZone = timeZone;
    return this;
  }
  when(filter: TaskFilter) {
    this.#draft.when.push(filter);
    return this;
  }
  skip(filter: TaskFilter) {
    this.#draft.skip.push(filter);
    return this;
  }
  environments(...names: string[]) {
    this.#draft.environments = names;
    return this;
  }
  onOneServer() {
    this.#draft.onOneServer = true;
    return this;
  }
  withoutOverlapping(options: TaskOverlapOptions = {}) {
    if (this.#draft.kind === 'job') throw new ScheduleError(withCode('Q5', 's.job() only queues the job — that never overlaps. Overlapping runs of the job itself: withoutOverlapping() middleware on the job class.'));
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError(`withoutOverlapping(${JSON.stringify(options)}) takes an options object — withoutOverlapping({ expiresAfter: { minutes: 30 } }).`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'expiresAfter') throw new ScheduleError(withCode('Q5', `withoutOverlapping({ ${key} }): the only option is expiresAfter — withoutOverlapping({ expiresAfter: { minutes: 30 } }).`));
    }
    let seconds: number;
    try {
      seconds = durationToSeconds(options.expiresAfter ?? { hours: 24 });
    } catch (error) {
      throw new TypeError(`withoutOverlapping({ expiresAfter }): ${(error as Error).message}`, { cause: error });
    }
    if (!(seconds > 0)) throw new ScheduleError(withCode('Q5', `withoutOverlapping({ expiresAfter: ${JSON.stringify(options.expiresAfter)} }): the lock needs a span above zero after which it expires.`));
    this.#draft.overlapSeconds = seconds;
    return this;
  }
  catchUp(mode: CatchUp) {
    if (mode !== 'once' && mode !== 'skip') throw new ScheduleError(withCode('Q5', `catchUp() is 'once' or 'skip', not ${JSON.stringify(mode)}.`));
    this.#draft.catchUp = mode;
    return this;
  }
  name(name: string) {
    if (typeof name !== 'string' || name.trim() === '') throw new ScheduleError(withCode('Q5', 'name() needs a name.'));
    this.#draft.name = name.trim();
    return this;
  }
  description(text: string) {
    if (typeof text !== 'string' || /[\p{Cc}]/u.test(text)) throw new ScheduleError(withCode('Q5', 'description() takes one line of text.'));
    this.#draft.description = text;
    return this;
  }

  /** The cron fields an option changes — set by a frequency before (`.daily().at('03:10')`), not by `cron()`. */
  #fields(option: string): [string, string, string, string, string] {
    if (this.#draft.fields) return this.#draft.fields;
    throw new ScheduleError(
      withCode(
        'Q5',
        this.#draft.expression === undefined
          ? `${option} needs a frequency first — .daily().at('03:10').`
          : `${option} cannot change a cron('${this.#draft.expression}') expression — write it into the expression.`,
      ),
    );
  }
}
