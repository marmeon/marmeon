/**
 * The ICU MessageFormat subset Marmeon speaks — parsed once, formatted through `Intl`; the syntax is in
 * `docs/localization.md#messages`. The result is plain text — render it as text, never as HTML.
 */

export type Part =
  | string
  | { readonly kind: 'pound' }
  | { readonly kind: 'value'; readonly name: string }
  | { readonly kind: 'number' | 'date' | 'time'; readonly name: string; readonly style: string }
  | { readonly kind: 'plural' | 'selectordinal' | 'select'; readonly name: string; readonly branches: Readonly<Record<string, readonly Part[]>> };

export class MessageSyntaxError extends SyntaxError {
  override name = 'MessageSyntaxError';
}

const BRANCHING = new Set(['plural', 'selectordinal', 'select']);
const FORMATS = new Set(['number', 'date', 'time']);

/** Parses a message into parts; throws a {@link MessageSyntaxError} that says where it went wrong. */
export function parseMessage(message: string): readonly Part[] {
  let at = 0;
  const fail = (what: string): never => {
    throw new MessageSyntaxError(`[marmeon:S5] ${what} at position ${at} of "${message}"`);
  };
  const spaces = () => {
    while (at < message.length && /\s/.test(message[at]!)) at++;
  };
  const until = (stops: string) => {
    const start = at;
    while (at < message.length && !stops.includes(message[at]!)) at++;
    return message.slice(start, at);
  };

  const text = (inPlural: boolean, nested: boolean): Part[] => {
    const parts: Part[] = [];
    let literal = '';
    const flush = () => {
      if (literal) parts.push(literal);
      literal = '';
    };
    while (at < message.length) {
      const char = message[at]!;
      if (char === "'") {
        const next = message[at + 1];
        if (next === "'") {
          literal += "'";
          at += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          // Quoted literal text up to the next lone apostrophe.
          at++;
          while (at < message.length) {
            if (message[at] === "'") {
              if (message[at + 1] === "'") {
                literal += "'";
                at += 2;
                continue;
              }
              at++;
              break;
            }
            literal += message[at++];
          }
        } else {
          literal += char;
          at++;
        }
      } else if (char === '{') {
        flush();
        at++;
        parts.push(placeholder(inPlural));
      } else if (char === '}') {
        if (nested) break;
        fail('Unexpected "}"');
      } else if (char === '#' && inPlural) {
        flush();
        parts.push({ kind: 'pound' });
        at++;
      } else {
        literal += char;
        at++;
      }
    }
    flush();
    return parts;
  };

  const placeholder = (inPlural: boolean): Part => {
    spaces();
    const name = until(',}').trim();
    if (!/^[\w-]+$/.test(name)) fail(`Invalid placeholder name "${name}"`);
    if (at >= message.length) fail(`Unclosed placeholder {${name}`);
    if (message[at] === '}') {
      at++;
      return { kind: 'value', name };
    }
    at++; // ','
    const type = until(',}').trim();
    if (!BRANCHING.has(type) && !FORMATS.has(type)) fail(`Unknown placeholder type "${type}" (supported: number, date, time, plural, selectordinal, select)`);
    if (at >= message.length) fail(`Unclosed placeholder {${name}`);
    if (message[at] === '}') {
      at++;
      if (BRANCHING.has(type)) fail(`{${name}, ${type}} needs branches`);
      return { kind: type as 'number' | 'date' | 'time', name, style: '' };
    }
    at++; // ','
    if (FORMATS.has(type)) {
      const style = until('}').trim();
      if (at >= message.length) fail(`Unclosed placeholder {${name}`);
      at++;
      return { kind: type as 'number' | 'date' | 'time', name, style };
    }
    const branches: Record<string, readonly Part[]> = {};
    for (;;) {
      spaces();
      if (at >= message.length) fail(`Unclosed placeholder {${name}`);
      if (message[at] === '}') {
        at++;
        break;
      }
      const selector = until('{} \t\n').trim();
      spaces();
      if (message[at] !== '{' || !selector) fail(`Expected a branch like "other {…}" in {${name}, ${type}}`);
      if (selector.startsWith('offset:')) fail('"offset:" is not supported');
      at++;
      // `#` is the number in a plural's branches — and in a select inside one.
      branches[selector] = text(type !== 'select' || inPlural, true);
      if (message[at] !== '}') fail(`Unclosed branch "${selector}" in {${name}, ${type}}`);
      at++;
    }
    if (!Object.hasOwn(branches, 'other')) fail(`{${name}, ${type}} needs an "other" branch`);
    return { kind: type as 'plural' | 'selectordinal' | 'select', name, branches };
  };

  return text(false, false);
}

/** The `Intl` objects of one locale — created once, reused for every message. */
export class LocaleFormats {
  readonly locale: string;
  readonly #numbers = new Map<string, Intl.NumberFormat>();
  readonly #dates = new Map<string, Intl.DateTimeFormat>();
  readonly #plurals = new Map<string, Intl.PluralRules>();
  readonly #relative = new Map<string, Intl.RelativeTimeFormat>();

  constructor(locale: string) {
    this.locale = locale;
  }

  number(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
    return cached(this.#numbers, options, () => new Intl.NumberFormat(this.locale, options));
  }

  date(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
    return cached(this.#dates, options, () => new Intl.DateTimeFormat(this.locale, options));
  }

  plural(type: Intl.PluralRuleType): Intl.PluralRules {
    return cached(this.#plurals, { type }, () => new Intl.PluralRules(this.locale, { type }));
  }

  relative(options: Intl.RelativeTimeFormatOptions = {}): Intl.RelativeTimeFormat {
    return cached(this.#relative, options, () => new Intl.RelativeTimeFormat(this.locale, options));
  }
}

function cached<T>(cache: Map<string, T>, options: object, create: () => T): T {
  const key = JSON.stringify(options);
  let value = cache.get(key);
  if (!value) cache.set(key, (value = create()));
  return value;
}

const STYLES = new Set(['short', 'medium', 'long', 'full']);

function toDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** Formats parsed parts. A missing value leaves its placeholder as written (`{name}`) — visible, never a crash. */
export function formatParts(parts: readonly Part[], params: Readonly<Record<string, unknown>>, formats: LocaleFormats, pound?: number): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (part.kind === 'pound') {
      out += pound === undefined ? '#' : formats.number().format(pound);
      continue;
    }
    const value = Object.hasOwn(params, part.name) ? params[part.name] : undefined;
    if (value === undefined || value === null) {
      out += `{${part.name}}`;
      continue;
    }
    switch (part.kind) {
      case 'value':
        out +=
          typeof value === 'number' || typeof value === 'bigint'
            ? formats.number().format(value)
            : value instanceof Date
              ? formats.date({ dateStyle: 'medium' }).format(value)
              : String(value);
        break;
      case 'number': {
        const options: Intl.NumberFormatOptions =
          part.style === 'integer' ? { maximumFractionDigits: 0 } : part.style === 'percent' ? { style: 'percent' } : {};
        out += formats.number(options).format(Number(value));
        break;
      }
      case 'date':
      case 'time': {
        const date = toDate(value);
        const style = (STYLES.has(part.style) ? part.style : 'medium') as 'short' | 'medium' | 'long' | 'full';
        out += date ? formats.date(part.kind === 'date' ? { dateStyle: style } : { timeStyle: style }).format(date) : String(value);
        break;
      }
      case 'plural':
      case 'selectordinal': {
        const count = Number(value);
        const exact = part.branches[`=${count}`];
        const branch = exact ?? part.branches[formats.plural(part.kind === 'plural' ? 'cardinal' : 'ordinal').select(count)] ?? part.branches.other!;
        out += formatParts(branch, params, formats, count);
        break;
      }
      case 'select': {
        const key = String(value);
        out += formatParts(Object.hasOwn(part.branches, key) ? part.branches[key]! : part.branches.other!, params, formats, pound);
        break;
      }
    }
  }
  return out;
}

/** Parses and formats in one go — for a message used once. */
export function formatMessage(message: string, params: Readonly<Record<string, unknown>> = {}, locale = 'en'): string {
  return formatParts(parseMessage(message), params, new LocaleFormats(locale));
}
