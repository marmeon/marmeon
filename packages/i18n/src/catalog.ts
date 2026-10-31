import { dayOptions, formatParts, LocaleFormats, MessageSyntaxError, parseMessage, type Part } from './format.ts';
import { baseLanguage } from './locale.ts';
import type { Translate } from './messages.ts';

/** Numbers, dates and relative times for one locale — `Intl`, with its formatters reused. */
export interface Formatter {
  readonly locale: string;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  /**
   * A date or time: a `Date`, a timestamp or an ISO string (what a `Date` prop is in the browser). A calendar day
   * (`2026-10-14`, what a `date` column reads back as) is shown as that day in every zone; see
   * [Time](docs/time.md#a-calendar-day).
   */
  date(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  /**
   * `date` relative to `now` in the largest fitting unit — "3 minutes ago", "yesterday", "in 2 days". Pass the
   * server's `now` (a prop), not the browser's clock: server and browser then render the same text.
   */
  relative(date: Date | number | string, now: Date | number | string, options?: Intl.RelativeTimeFormatOptions): string;
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

function time(value: Date | number | string): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
}

function createFormatter(formats: LocaleFormats): Formatter {
  return {
    locale: formats.locale,
    number: (value, options) => formats.number(options).format(value),
    date: (value, options = { dateStyle: 'medium' }) => formats.date(dayOptions(value, options)).format(new Date(time(value))),
    relativeTime: (value, unit, options) => formats.relative(options).format(value, unit),
    relative(date, now, options = { numeric: 'auto' }) {
      const seconds = (time(date) - time(now)) / 1000;
      const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1];
      return formats.relative(options).format(Math.round(seconds / size), unit);
    },
  };
}

interface Entry {
  readonly message: string;
  readonly parts: readonly Part[];
  readonly locale: string;
}

export class MessageError extends Error {
  override name = 'MessageError';
}

/**
 * Messages of several locales, by namespace — looked up by key (`auth.login.title`) in a locale, else its language
 * (`de-AT` → `de`), else the fallback locale. Messages are parsed when added (a malformed one fails then, with its
 * key and file), and only read afterwards: one catalog serves every request, the locale is the caller's.
 */
export class Catalog {
  readonly fallback: string;
  readonly #messages = new Map<string, Map<string, Map<string, Entry>>>(); // locale → namespace → key → entry
  readonly #formats = new Map<string, LocaleFormats>();
  readonly #formatters = new Map<string, Formatter>();

  constructor({ fallback }: { fallback: string }) {
    this.fallback = fallback;
  }

  /** Adds a namespace's messages in `locale` (a module's `lang/<locale>.ts`). `source` names the file in errors. */
  add(locale: string, namespace: string, messages: unknown, source = `${namespace} (${locale})`): this {
    if (!/^[\w-]+$/.test(namespace)) throw new MessageError(`Invalid namespace "${namespace}" in ${source}.`);
    const namespaces = this.#messages.get(locale) ?? new Map<string, Map<string, Entry>>();
    if (namespaces.has(namespace)) throw new MessageError(`The ${namespace} messages in ${locale} are defined twice (${source}).`);
    const entries = new Map<string, Entry>();
    const walk = (tree: unknown, path: string) => {
      if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
        throw new MessageError(`${source} must export an object of messages (strings, nested in objects)${path ? ` — ${path} is not one` : ''}.`);
      }
      for (const [key, value] of Object.entries(tree)) {
        if (key.includes('.')) throw new MessageError(`Message keys may not contain dots: "${key}" in ${source}.`);
        const at = path ? `${path}.${key}` : key;
        if (typeof value === 'string') {
          try {
            entries.set(at, { message: value, parts: parseMessage(value), locale });
          } catch (error) {
            if (error instanceof MessageSyntaxError) throw new MessageError(`[marmeon:S5] Message ${namespace}.${at} in ${source} is malformed: ${error.message.replace(/^\[marmeon:S5\] /, '')}`);
            throw error;
          }
        } else {
          walk(value, at);
        }
      }
    };
    walk(messages, '');
    namespaces.set(namespace, entries);
    this.#messages.set(locale, namespaces);
    return this;
  }

  /** @internal Adds a namespace's messages in `locale`, in place of the ones it has (the framework's texts with an app's wording). */
  replace(locale: string, namespace: string, messages: unknown, source = `${namespace} (${locale})`): this {
    this.#messages.get(locale)?.delete(namespace);
    return this.add(locale, namespace, messages, source);
  }

  /** The locales with messages. */
  locales(): string[] {
    return [...this.#messages.keys()];
  }

  /** @internal The namespaces `locale` has messages for. */
  namespaces(locale: string): string[] {
    return [...(this.#messages.get(locale)?.keys() ?? [])];
  }

  #find(locale: string, key: string): Entry | undefined {
    const dot = key.indexOf('.');
    if (dot === -1) return undefined;
    const namespace = key.slice(0, dot);
    const path = key.slice(dot + 1);
    for (const candidate of new Set([locale, baseLanguage(locale), this.fallback, baseLanguage(this.fallback)])) {
      const entry = candidate === undefined ? undefined : this.#messages.get(candidate)?.get(namespace)?.get(path);
      if (entry) return entry;
    }
    return undefined;
  }

  /** Whether `key` has a message in `locale` (or its fallbacks). */
  has(locale: string, key: string): boolean {
    return this.#find(locale, key) !== undefined;
  }

  /** The raw message of `key` — the text as written, placeholders unfilled. */
  message(locale: string, key: string): string | undefined {
    return this.#find(locale, key)?.message;
  }

  /**
   * `key`'s message with its placeholders filled — formatted for the locale the message was found in (a fallback
   * English text gets English plurals). `fallback` when no locale has the key; else the key itself.
   */
  text(locale: string, key: string, params: Readonly<Record<string, unknown>> = {}, fallback?: string): string {
    const entry = this.#find(locale, key);
    if (entry) return formatParts(entry.parts, params, this.#formatsOf(entry.locale));
    if (fallback === undefined) return key;
    try {
      return formatParts(parseMessage(fallback), params, this.#formatsOf(locale));
    } catch {
      return fallback;
    }
  }

  /**
   * The keys of one namespace in `locale` — `t('login.title')`, typed against the namespace's source file. What a UI
   * adapter's hook returns: as a method, the adapter needs no runtime import of this package (only its types).
   */
  translate<N extends string>(locale: string, namespace: N): Translate<N> {
    const t = (key: string, params?: Readonly<Record<string, unknown>>) => this.text(locale, `${namespace}.${key}`, params);
    return Object.assign(t, {
      locale,
      namespace,
      format: this.formatter(locale),
      has: (key: string) => this.has(locale, `${namespace}.${key}`),
    }) as unknown as Translate<N>;
  }

  /** Numbers, dates and relative times in `locale`. What a UI adapter's hook returns with the translation: as a method, the adapter needs no runtime import of this package (only its types). */
  formatter(locale: string): Formatter {
    let formatter = this.#formatters.get(locale);
    if (!formatter) this.#formatters.set(locale, (formatter = createFormatter(this.#formatsOf(locale))));
    return formatter;
  }

  #formatsOf(locale: string): LocaleFormats {
    let formats = this.#formats.get(locale);
    if (!formats) this.#formats.set(locale, (formats = new LocaleFormats(locale)));
    return formats;
  }
}
