import type { CommandClass } from '@bespokecore/cli';
import type { Container } from '@bespokecore/core';
import type { JobClass } from '@bespokecore/queue';
import { ScheduleError } from './cron.ts';

/** What a task does: queue a job (`s.job`), run a console command (`s.command`), or call an invokable class (`s.call`). */
export type TaskKind = 'job' | 'command' | 'call';

/** A class `s.call()` runs — built through the container in a scope of its own (constructor injection), then `handle()`. */
export interface Invokable {
  handle(): unknown;
}
export type InvokableClass = new (...args: any[]) => Invokable;

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

/** Everything known about a task — what `defineSchedule` collected. */
export interface TaskDefinition {
  readonly kind: TaskKind;
  readonly target: JobClass | CommandClass | InvokableClass | string;
  readonly payload: unknown;
  readonly args: readonly string[];
  /** The module whose schedule defined it — for messages. */
  readonly module: string;
  fields: [minute: string, hour: string, day: string, month: string, weekday: string] | undefined;
  /** Set by `cron()`: the expression as written. */
  expression: string | undefined;
  timezone: string | undefined;
  readonly when: TaskFilter[];
  readonly skip: TaskFilter[];
  environments: readonly string[] | undefined;
  onOneServer: boolean;
  /** Minutes the overlap lock holds at most (`withoutOverlapping()`), undefined = overlapping allowed. */
  overlapMinutes: number | undefined;
  catchUp: CatchUp;
  name: string | undefined;
  description: string | undefined;
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
  /** The task's name — in `schedule:list`, `schedule:test <name>`, logs and locks. Default: the job's or command's name, or the class name. */
  name(name: string): UnscheduledTask<K>;
  description(text: string): UnscheduledTask<K>;
  onOneServer(this: 'Say how often first — .daily().onOneServer(): a task needs a frequency before its options'): never;
  withoutOverlapping(this: 'Say how often first — .everyMinute().withoutOverlapping(): a task needs a frequency before its options'): never;
  at(this: 'at() sets the time of a daily, weekly or monthly task — say how often first: .daily().at(…)', time?: unknown): never;
}

/** The overlap option, by kind: queuing a job takes no time, and `s.job` is unique until the job runs anyway. */
type Overlapping<K extends TaskKind> = K extends 'job'
  ? (this: 's.job() only queues the job — that never overlaps, and the next one is not queued while it still waits. Overlapping runs of the job itself: withoutOverlapping() middleware on the job class') => never
  : (expiresAfterMinutes?: number) => ScheduledTask<K>;

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
  timezone(timeZone: string): ScheduledTask<K>;
  /** Runs only when `filter` says true (asked each time it is due). */
  when(filter: TaskFilter): ScheduledTask<K>;
  /** Does not run when `filter` says true. */
  skip(filter: TaskFilter): ScheduledTask<K>;
  /** Runs only in these environments (`NODE_ENV`): `.environments('production')`. */
  environments(...names: [string, ...string[]]): ScheduledTask<K>;
  /**
   * Runs on one server only, when several run the scheduler (E88): the first to take the lock
   * `schedule:<name>:<minute>` in the shared cache runs it. Needs a cache all servers share — `CACHE_DRIVER=database`
   * or `redis`. With `file` the lock holds on this machine only, with `memory` in this process only: the scheduler starts
   * and warns (E123) — right for a single scheduler, wrong for several.
   */
  onOneServer(): ScheduledTask<K>;
  /**
   * Skips a run while the previous one still runs — on any server (a lock in the cache, which expires after
   * `expiresAfterMinutes`, default 1440, in case a scheduler dies holding it). "Any server" needs a shared cache, like
   * `onOneServer()`: with `file` or `memory` the scheduler warns at its start (E123).
   */
  withoutOverlapping: Overlapping<K>;
  /**
   * When the scheduler was down at a time the task was due: `'once'` (default) runs it once when the scheduler is back,
   * however many times it was missed; `'skip'` waits for the next due time.
   */
  catchUp(mode: CatchUp): ScheduledTask<K>;
  name(name: string): ScheduledTask<K>;
  description(text: string): ScheduledTask<K>;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTime(time: unknown, where: string): [minute: string, hour: string] {
  const match = typeof time === 'string' ? TIME.exec(time) : null;
  if (!match) throw new ScheduleError(`${where}: ${JSON.stringify(time)} is not a time of day — use HH:MM, like '03:10' (hours 0–23, minutes 00–59).`);
  return [String(Number(match[2])), String(Number(match[1]))];
}

function weekday(day: unknown, where: string): number {
  const index = typeof day === 'string' ? WEEKDAYS.indexOf(day.toLowerCase() as never) : typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6 ? day : -1;
  if (index < 0) throw new ScheduleError(`${where}: ${JSON.stringify(day)} is not a day of the week — 0 (Sunday) to 6, or a name like 'monday'.`);
  return index;
}

/** The builder behind every task — one object, typed by stage (`UnscheduledTask` → `ScheduledTask`). */
export class PendingTask {
  readonly definition: TaskDefinition;

  constructor(definition: Pick<TaskDefinition, 'kind' | 'target' | 'payload' | 'args' | 'module'>) {
    this.definition = {
      ...definition,
      fields: undefined,
      expression: undefined,
      timezone: undefined,
      when: [],
      skip: [],
      environments: undefined,
      onOneServer: false,
      overlapMinutes: undefined,
      catchUp: 'once',
      name: undefined,
      description: undefined,
    };
  }

  #set(minute: string, hour = '*', day = '*', month = '*', weekday = '*'): this {
    this.definition.fields = [minute, hour, day, month, weekday];
    this.definition.expression = undefined;
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
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new ScheduleError(`hourlyAt(${String(minute)}): the minute is 0–59.`);
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
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new ScheduleError(`monthlyOn(${String(day)}): the day of the month is 1–31.`);
    const [minute, hour] = parseTime(time, 'monthlyOn()');
    return this.#set(minute, hour, String(day));
  }
  yearly() {
    return this.#set('0', '0', '1', '1');
  }
  cron(expression: string) {
    if (typeof expression !== 'string') throw new ScheduleError(`cron() takes an expression like '*/5 * * * *', not ${JSON.stringify(expression)}.`);
    this.definition.fields = undefined;
    this.definition.expression = expression;
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
    if (days.length === 0) throw new ScheduleError('days() needs at least one day of the week.');
    this.#fields('days()')[4] = days.map((day) => weekday(day, 'days()')).join(',');
    return this;
  }
  timezone(timeZone: string) {
    this.definition.timezone = timeZone;
    return this;
  }
  when(filter: TaskFilter) {
    this.definition.when.push(filter);
    return this;
  }
  skip(filter: TaskFilter) {
    this.definition.skip.push(filter);
    return this;
  }
  environments(...names: string[]) {
    this.definition.environments = names;
    return this;
  }
  onOneServer() {
    this.definition.onOneServer = true;
    return this;
  }
  withoutOverlapping(expiresAfterMinutes = 1440) {
    if (this.definition.kind === 'job') throw new ScheduleError('s.job() only queues the job — that never overlaps. Overlapping runs of the job itself: withoutOverlapping() middleware on the job class.');
    if (!(expiresAfterMinutes > 0)) throw new ScheduleError(`withoutOverlapping(${String(expiresAfterMinutes)}): the lock needs minutes > 0 after which it expires.`);
    this.definition.overlapMinutes = expiresAfterMinutes;
    return this;
  }
  catchUp(mode: CatchUp) {
    if (mode !== 'once' && mode !== 'skip') throw new ScheduleError(`catchUp() is 'once' or 'skip', not ${JSON.stringify(mode)}.`);
    this.definition.catchUp = mode;
    return this;
  }
  name(name: string) {
    if (typeof name !== 'string' || name.trim() === '') throw new ScheduleError('name() needs a name.');
    this.definition.name = name.trim();
    return this;
  }
  description(text: string) {
    this.definition.description = text;
    return this;
  }

  /** The cron fields an option changes — set by a frequency before (`.daily().at('03:10')`), not by `cron()`. */
  #fields(option: string): [string, string, string, string, string] {
    if (this.definition.fields) return this.definition.fields;
    throw new ScheduleError(
      this.definition.expression === undefined
        ? `${option} needs a frequency first — .daily().at('03:10').`
        : `${option} cannot change a cron('${this.definition.expression}') expression — write it into the expression.`,
    );
  }
}
