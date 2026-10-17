import { withCode } from '@marmeon/core/internal';

/** A schedule is set up wrongly — an invalid cron expression, a task without a frequency, two tasks with one name … — said at startup. */
export class ScheduleError extends Error {
  override name = 'ScheduleError';
}

/** The local time of one minute — what a cron expression is matched against. `weekday`: 0 = Sunday … 6 = Saturday. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  // 7 is Sunday too, as in every cron.
  { name: 'day of the week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/**
 * A cron expression — five fields, `minute hour day-of-month month day-of-week`, each `*`, a number, a range `1-5`, a
 * list `1,15`, a step `*\/5` or `10-50/10`; months and weekdays also by name (`jan`, `mon`). And the macros `@hourly`,
 * `@daily`, `@weekly`, `@monthly`, `@yearly`.
 *
 * Day of month and day of week combine like in every cron: when both are restricted, either one matching is enough.
 */
export class CronExpression {
  readonly source: string;
  readonly #sets: readonly ReadonlySet<number>[];
  /** Whether the field starts with `*` (`*`, `*\/5`) — "every", not a particular value. */
  readonly #wild: readonly boolean[];

  constructor(expression: string) {
    const source = expression.trim().replace(/\s+/g, ' ');
    const expanded = MACROS[source.toLowerCase()] ?? source;
    const parts = expanded.split(' ');
    if (parts.length !== 5) {
      throw new ScheduleError(withCode('Q5', `"${expression}" is not a cron expression: it needs five fields (minute hour day-of-month month day-of-week), like "*/5 * * * *".`));
    }
    this.source = source;
    this.#sets = parts.map((part, index) => parseField(part, FIELDS[index]!, expression));
    this.#wild = parts.map((part) => part.startsWith('*'));
  }

  /** Whether the hour field names particular hours (`2`, `9-17`) — not `*` or `*\/2`. Such a task runs once in an hour a clock change repeats. */
  get hourRestricted(): boolean {
    return !this.#wild[1];
  }

  matches(time: WallTime): boolean {
    const [minute, hour, day, month, weekday] = this.#sets as [ReadonlySet<number>, ReadonlySet<number>, ReadonlySet<number>, ReadonlySet<number>, ReadonlySet<number>];
    if (!minute.has(time.minute) || !hour.has(time.hour) || !month.has(time.month)) return false;
    const dayMatches = day.has(time.day);
    const weekdayMatches = weekday.has(time.weekday);
    // Both restricted: either is enough (`0 0 1 * mon` = the 1st and every Monday). Otherwise both must match.
    if (!this.#wild[2] && !this.#wild[4]) return dayMatches || weekdayMatches;
    return dayMatches && weekdayMatches;
  }

  /** Whether some minute of the hour `time` lies in could match — to skip hours quickly. */
  matchesHour(time: Omit<WallTime, 'minute'>): boolean {
    return this.matches({ ...time, minute: this.#firstMinute() });
  }

  #firstMinute(): number {
    return Math.min(...this.#sets[0]!);
  }

  toString(): string {
    return this.source;
  }
}

function parseField(part: string, field: Field, expression: string): ReadonlySet<number> {
  const values = new Set<number>();
  const fail = (why: string): never => {
    throw new ScheduleError(withCode('Q5', `Invalid cron expression "${expression}": the ${field.name} field "${part}" ${why}.`));
  };
  for (const item of part.split(',')) {
    const [range = '', stepText, ...rest] = item.split('/');
    if (rest.length > 0 || range === '') fail('is not a value, a range, a list or a step');
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) fail(`has an invalid step "${stepText}"`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = field.min;
      to = field.max === 7 ? 6 : field.max;
    } else {
      const [a = '', b, ...more] = range.split('-');
      if (more.length > 0) fail('has a range with more than two ends');
      from = value(a, field, fail);
      // `5/15` = from 5 to the end, in steps of 15.
      to = b === undefined ? (stepText === undefined ? from : field.max) : value(b, field, fail);
      if (to < from) fail(`has a range that runs backwards (${from}-${to})`);
    }
    for (let n = from; n <= to; n += step) values.add(field.max === 7 && n === 7 ? 0 : n);
  }
  return values;
}

function value(text: string, field: Field, fail: (why: string) => never): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return field.max === 12 ? named + 1 : named;
  if (!/^\d+$/.test(text)) fail(`has "${text}", which is neither a number${field.names ? ' nor a name' : ''}`);
  const number = Number(text);
  if (number < field.min || number > field.max) fail(`has ${number}, outside ${field.min}–${field.max}`);
  return number;
}
