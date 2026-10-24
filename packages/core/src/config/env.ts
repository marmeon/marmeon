/**
 * The environment reader: the `env` of a config definition, a Standard Schema without any validation library. An empty
 * variable is a missing one, and a message never repeats the value (a variable may hold a secret).
 * See docs/configuration.md#reading-variables.
 */
import type { StandardIssue, StandardResult, StandardSchemaV1 } from './standard-schema.ts';

/** A message, or one made from the value (to name the entries of a list that are wrong). */
export type EnvMessage<T> = string | ((value: T) => string);

/** A variable read: its value, or what is wrong with it. */
export type EnvRead<T> = { readonly value: T; readonly problem?: undefined } | { readonly problem: string };

/** What `env({ … })` takes for each variable: a building block, or one made optional or given a default. */
export interface EnvVariable<Out> {
  /** Reads the variable `name` (`undefined` when missing or empty). */
  readonly '~env': (raw: string | undefined, name: string) => EnvRead<Out>;
}

interface BlockSpec<T> {
  /** Reads a present, non-empty variable as the block's type. */
  readonly parse: (raw: string, name: string) => EnvRead<T>;
  /** Run in order on the parsed value; the first one that answers a message is the variable's problem. */
  readonly checks: readonly ((value: T, name: string) => string | undefined)[];
  /** The message for a missing variable (`.required(…)`). */
  readonly missing?: string | undefined;
}

const ok = <T>(value: T): EnvRead<T> => ({ value });
const fail = (problem: string): EnvRead<never> => ({ problem });
const text = <T>(message: EnvMessage<T>, value: T): string => (typeof message === 'string' ? message : message(value));

/**
 * A building block: required as it is; `.optional()` or `.default(…)` say what a missing variable is. Immutable — every method
 * returns a new block.
 */
export class EnvBlock<T> implements EnvVariable<T> {
  readonly #spec: BlockSpec<T>;

  constructor(spec: BlockSpec<T>) {
    this.#spec = spec;
  }

  /** Reads the variable `name`, or an entry of a list (`raw` is `undefined` when the variable is missing or empty). */
  readonly '~env' = (raw: string | undefined, name: string): EnvRead<T> => {
    if (raw === undefined || raw === '') return fail(this.#spec.missing ?? `${name} is required.`);
    const parsed = this.#spec.parse(raw, name);
    if (parsed.problem !== undefined) return parsed;
    for (const check of this.#spec.checks) {
      const problem = check(parsed.value, name);
      if (problem !== undefined) return fail(problem);
    }
    return parsed;
  };

  /** The value must pass `test`; else `message` is the variable's problem. */
  check(test: (value: T) => boolean, message: EnvMessage<T>): this {
    return this.withCheck((value) => (test(value) ? undefined : text(message, value)));
  }

  /** Required (as every block is) — with `message` for a missing variable, such as the command that sets it. */
  required(message?: string): this {
    return this.derive({ ...this.#spec, missing: message });
  }

  /** A missing variable is `undefined`. */
  optional(): EnvVariable<T | undefined> {
    const read = this['~env'];
    return { '~env': (raw, name) => (raw === undefined || raw === '' ? ok(undefined) : read(raw, name)) };
  }

  /** A missing variable is `value` — not checked, so give one that is valid. */
  default(value: T): EnvVariable<T> {
    const read = this['~env'];
    return { '~env': (raw, name) => (raw === undefined || raw === '' ? ok(Array.isArray(value) ? ([...value] as T) : value) : read(raw, name)) };
  }

  protected derive(spec: BlockSpec<T>): this {
    return new (this.constructor as new (spec: BlockSpec<T>) => this)(spec);
  }

  protected withCheck(check: (value: T, name: string) => string | undefined): this {
    return this.derive({ ...this.#spec, checks: [...this.#spec.checks, check] });
  }
}

/** Text — `.min()`/`.max()` its length, `.regex()` its form. */
export class EnvString extends EnvBlock<string> {
  /** At least `length` characters. */
  min(length: number, message?: string): this {
    return this.withCheck((value, name) => (value.length >= length ? undefined : (message ?? `${name} must be at least ${length} characters long.`)));
  }

  /** At most `length` characters. */
  max(length: number, message?: string): this {
    return this.withCheck((value, name) => (value.length <= length ? undefined : (message ?? `${name} must be at most ${length} characters long.`)));
  }

  /** Matches `pattern` (its `g`/`y` flags are dropped, so it matches the same way every time). */
  regex(pattern: RegExp, message?: string): this {
    const stable = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return this.withCheck((value, name) => (stable.test(value) ? undefined : (message ?? `${name} must match ${stable}.`)));
  }
}

/** A number — `.min()`/`.max()` its range. */
export class EnvNumber extends EnvBlock<number> {
  /** At least `minimum`. */
  min(minimum: number, message?: string): this {
    return this.withCheck((value, name) => (value >= minimum ? undefined : (message ?? `${name} must be at least ${minimum}.`)));
  }

  /** At most `maximum`. */
  max(maximum: number, message?: string): this {
    return this.withCheck((value, name) => (value <= maximum ? undefined : (message ?? `${name} must be at most ${maximum}.`)));
  }
}

/** A whole number as written by hand: an optional sign and decimal digits — not `1e3`, `5.`, `0x10` or ` 5`. */
const INTEGER = /^[+-]?\d+$/;
/** A number as written by hand: a whole number, or one with decimals (`0.5`) — not `.5`, `5.`, `1e3` or `Infinity`. */
const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
/** The same as valibot's and the e-mail rule's — what an address in a `.env` looks like. */
const EMAIL = /^[\w+-]+(?:\.[\w+-]+)*@[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*\.[a-zA-Z]{2,}$/u;

function toNumber(raw: string, pattern: RegExp = NUMBER): number | undefined {
  const number = pattern.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** `a`, `a or b`, `a, b or c`. */
function either(values: readonly string[]): string {
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

const string = (): EnvString => new EnvString({ parse: (raw) => ok(raw), checks: [] });

const number = (message?: string): EnvNumber =>
  new EnvNumber({
    parse: (raw, name) => {
      const value = toNumber(raw);
      return value === undefined ? fail(message ?? `${name} must be a number.`) : ok(value);
    },
    checks: [],
  });

const integer = (message?: string): EnvNumber =>
  new EnvNumber({
    parse: (raw, name) => {
      const value = toNumber(raw, INTEGER);
      return value === undefined || !Number.isSafeInteger(value) ? fail(message ?? `${name} must be a whole number.`) : ok(value);
    },
    checks: [],
  });

// A Map, not an object literal: `constructor` or `__proto__` must not find what Object.prototype has.
const BOOLEANS: ReadonlyMap<string, boolean> = new Map([['true', true], ['false', false], ['1', true], ['0', false]]);

const boolean = (message?: string): EnvBlock<boolean> =>
  new EnvBlock({
    parse: (raw, name) => {
      const value = BOOLEANS.get(raw.toLowerCase());
      return value === undefined ? fail(message ?? `${name} must be true or false (or 1 or 0).`) : ok(value);
    },
    checks: [],
  });

const choice = <const T extends readonly [string, ...string[]]>(values: T, message?: string): EnvBlock<T[number]> => {
  if (values.includes('')) throw new TypeError('env.in(): an empty variable is a missing one, so "" is never a value — use .optional() or .default().');
  const allowed = new Set<string>(values);
  return new EnvBlock({
    parse: (raw, name) => (allowed.has(raw) ? ok(raw as T[number]) : fail(message ?? `${name} must be ${either(values)}.`)),
    checks: [],
  });
};

const url = ({ protocols = ['http', 'https'], message }: { readonly protocols?: readonly [string, ...string[]]; readonly message?: string } = {}): EnvBlock<string> => {
  const names = protocols.map((protocol) => protocol.replace(/:$/, '').toLowerCase());
  const allowed = new Set(names.map((protocol) => `${protocol}:`));
  return new EnvBlock({
    parse: (raw, name) => {
      const parsed = /\s/.test(raw) ? null : URL.parse(raw);
      // `scheme://…`: an address with an authority, as every URL a server connects to has (`localhost:6379` parses too — with the scheme `localhost:`).
      const valid = parsed !== null && allowed.has(parsed.protocol) && raw.slice(parsed.protocol.length).startsWith('//');
      return valid ? ok(raw) : fail(message ?? `${name} must be a URL starting with ${either(names.map((protocol) => `${protocol}://`))}.`);
    },
    checks: [],
  });
};

const port = (message?: string): EnvNumber =>
  new EnvNumber({
    parse: (raw, name) => {
      const value = toNumber(raw, INTEGER);
      return value !== undefined && Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? ok(value) : fail(message ?? `${name} must be a port from 1 to 65535.`);
    },
    checks: [],
  });

const email = (message?: string): EnvBlock<string> =>
  new EnvBlock({ parse: (raw, name) => (EMAIL.test(raw) ? ok(raw) : fail(message ?? `${name} must be an e-mail address.`)), checks: [] });

const listOf = <T>(item: EnvBlock<T>, { separator = ',' }: { readonly separator?: string } = {}): EnvBlock<T[]> => {
  if (separator === '') throw new TypeError('env.list(): the separator cannot be empty.');
  return new EnvBlock({
    parse: (raw, name) => {
      const entries = raw.split(separator).map((entry) => entry.trim()).filter((entry) => entry !== '');
      const values: T[] = [];
      for (const [index, entry] of entries.entries()) {
        // One problem per variable: the first entry that is wrong, by its place (`ADMINS entry 2`), never by its value.
        const read = item['~env'](entry, `${name} entry ${index + 1}`);
        if (read.problem !== undefined) return read;
        values.push(read.value);
      }
      return ok(values);
    },
    checks: [],
  });
};

type Fields = Readonly<Record<string, EnvVariable<unknown>>>;
type InputOf<F extends Fields> = { readonly [K in keyof F]?: string | undefined };

interface CrossCheck<Out> {
  readonly variable: string;
  readonly test: (values: Out) => boolean;
  readonly message: EnvMessage<Out>;
}

/** Where an `EnvSchema` hands out its variables: a registered symbol, so a script outside the package finds it without importing `internal`. */
const ENV_FIELDS: unique symbol = Symbol.for('marmeon.env.fields');
/** The same for the retired names: old name to new name. */
const ENV_RENAMED: unique symbol = Symbol.for('marmeon.env.renamed');

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Options of `EnvSchema.renamed()`. */
export interface RenamedOptions {
  /** How the old value becomes the new one, when the unit changes: the stop message says it in place of "same value". */
  readonly conversion?: string;
}

/** The schema `env({ … })` makes — a Standard Schema; `.check()` adds a rule between variables, `.renamed()` retires a name. */
export class EnvSchema<Out, In = Readonly<Record<string, string | undefined>>> implements StandardSchemaV1<In, Out> {
  readonly #fields: Fields;
  readonly #checks: readonly CrossCheck<Out>[];
  #renamed: ReadonlyMap<string, string> = new Map();
  #notes: ReadonlyMap<string, string> = new Map();
  readonly '~standard': StandardSchemaV1<In, Out>['~standard'];

  constructor(fields: Fields, checks: readonly CrossCheck<Out>[] = []) {
    this.#fields = fields;
    this.#checks = checks;
    this['~standard'] = { version: 1, vendor: 'marmeon', validate: (value) => this.#validate(value) };
  }

  /**
   * The variables of the schema by name, frozen: the building blocks, never a value.
   * @internal Read by the repository's API snapshot (`scripts/api.ts`) to list each package's variables and their defaults.
   */
  get [ENV_FIELDS](): Fields {
    return Object.freeze({ ...this.#fields });
  }

  /**
   * A rule between variables, checked once every variable read cleanly: `message` is the problem of `variable`.
   *
   * ```ts
   * env({ APP_LOCALE: env.string(), APP_LOCALES: env.list(env.string()) })
   *   .check((e) => e.APP_LOCALES.includes(e.APP_LOCALE), 'APP_LOCALE must be one of APP_LOCALES', 'APP_LOCALE')
   * ```
   */
  check(test: (values: Out) => boolean, message: EnvMessage<Out>, variable: keyof Out & string): EnvSchema<Out, In> {
    return this.#derive([...this.#checks, { variable, test, message }], this.#renamed, this.#notes);
  }

  /**
   * Retires the name `from`: a start with `from` set (and not empty) stops with a problem that names `to`. The old value is
   * never read, so a renamed variable cannot fall back to its default unnoticed. See docs/configuration.md#renamed-variables.
   *
   * ```ts
   * env({ NOTES_PER_PAGE: env.integer().default(20) }).renamed('NOTES_PAGE_SIZE', 'NOTES_PER_PAGE')
   * ```
   *
   * The problem says the value carries over unchanged. When it does not (the old name had no unit), `conversion` says how the value changes instead.
   */
  renamed(from: string, to: keyof Out & string, options: RenamedOptions = {}): EnvSchema<Out, In> {
    const { conversion } = options;
    if (!VARIABLE_NAME.test(from) || !VARIABLE_NAME.test(to)) throw new TypeError(`env.renamed(): ${from} and ${to} must be variable names in upper case, such as NOTES_PER_PAGE.`);
    if (conversion !== undefined && conversion.trim() === '') throw new TypeError(`env.renamed(): the conversion of ${from} is empty — say how the value changes, or leave it out.`);
    if (from === to) throw new TypeError(`env.renamed(): ${from} cannot be renamed to itself.`);
    if (!Object.hasOwn(this.#fields, to)) throw new TypeError(`env.renamed(): ${to} is not a variable of this schema.`);
    if (Object.hasOwn(this.#fields, from)) throw new TypeError(`env.renamed(): ${from} is a variable of this schema, so it cannot be retired.`);
    if (this.#renamed.has(from)) throw new TypeError(`env.renamed(): ${from} is retired already.`);
    return this.#derive(this.#checks, new Map([...this.#renamed, [from, to]]), conversion === undefined ? this.#notes : new Map([...this.#notes, [from, conversion]]));
  }

  /** A copy with other checks and locks — the locks are set here only, so every one passed the tests of `.renamed()`. */
  #derive(checks: readonly CrossCheck<Out>[], renamed: ReadonlyMap<string, string>, notes: ReadonlyMap<string, string>): EnvSchema<Out, In> {
    const schema = new EnvSchema<Out, In>(this.#fields, checks);
    schema.#renamed = new Map(renamed);
    schema.#notes = new Map(notes);
    return schema;
  }

  /**
   * The retired names by name, frozen: old name to new name.
   * @internal Read by the repository's API snapshot (`scripts/api.ts`) to list the locks next to the variables.
   */
  get [ENV_RENAMED](): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.#renamed));
  }

  #validate(environment: unknown): StandardResult<Out> {
    if (typeof environment !== 'object' || environment === null) return { issues: [{ message: 'The environment must be an object of strings.' }] };
    const source = environment as Readonly<Record<string, unknown>>;
    const entries: [string, unknown][] = [];
    const issues: StandardIssue[] = [];
    // First, and whatever the new name holds: a retired name that is set stops the start, with no precedence between the two.
    for (const [from, to] of this.#renamed) {
      const old = Object.hasOwn(source, from) ? source[from] : undefined;
      if (old === undefined || old === '') continue;
      const advice = this.#notes.get(from) ?? 'same value; rename it in .env and wherever the environment is set';
      issues.push({ message: `${from} was renamed ${to} — ${advice} (docs/configuration.md#renamed-variables).`, path: [from] });
    }
    for (const [name, field] of Object.entries(this.#fields)) {
      const raw = Object.hasOwn(source, name) ? source[name] : undefined;
      if (raw !== undefined && typeof raw !== 'string') {
        issues.push({ message: `${name} must be a string, as every environment variable is.`, path: [name] });
        continue;
      }
      const read = field['~env'](raw, name);
      if (read.problem !== undefined) issues.push({ message: read.problem, path: [name] });
      else entries.push([name, read.value]);
    }
    if (issues.length > 0) return { issues };
    // Own properties only — a variable named `__proto__` is a key like any other, never the object's prototype.
    const values = Object.fromEntries(entries);
    for (const check of this.#checks) {
      if (!check.test(values as Out)) issues.push({ message: text(check.message, values as Out), path: [check.variable] });
    }
    return issues.length > 0 ? { issues } : { value: values as Out };
  }
}

/**
 * The environment variables of a config definition, by name — each read by a building block (`env.string()`,
 * `env.integer()`, `env.in([...])`, `env.list(block)` …). See docs/configuration.md#reading-variables.
 */
function envSchema<const F extends Fields>(fields: F): EnvSchema<{ -readonly [K in keyof F]: F[K] extends EnvVariable<infer Out> ? Out : never }, InputOf<F>> {
  return new EnvSchema(fields);
}

/**
 * The environment variables of a config definition, by name — each read by a building block (`env.string()`,
 * `env.integer()`, `env.in([...])`). See docs/configuration.md#reading-variables.
 */
export const env = Object.assign(envSchema, {
  /** Text. */
  string,
  /** A whole number. */
  integer,
  /** A number — decimals too (`0.5`). */
  number,
  /** `true`/`false` or `1`/`0`, in any case; anything else is a problem. */
  boolean,
  /** One of `values`, case-sensitive — its type is their union. */
  in: choice,
  /** An absolute URL with `//` — `http`/`https` unless `protocols` names others (`['redis', 'rediss']`). */
  url,
  /** A port from 1 to 65535. */
  port,
  /** An e-mail address. */
  email,
  /** Entries split at `,` (or `separator`), trimmed, empty ones dropped — each read by `item`. */
  list: listOf,
});
