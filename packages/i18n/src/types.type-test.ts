// Type guarantees of messages, keys and placeholders — compiled by the package build, never run.
// @ts-expect-error — `KeyOf` is not exported; `MessageKeyOf` is
import type { KeyOf } from './index.ts';
// @ts-expect-error — `ParamsOf` is not exported; `MessageParamsOf` is
import type { ParamsOf } from './index.ts';
// @ts-expect-error — `CheckKey` is not exported; `CheckMessageKey` is
import type { CheckKey } from './index.ts';
// @ts-expect-error — `KeyOf` is not exported by the browser-safe core either
import type { KeyOf as CoreKeyOf } from './messages.ts';
import type { MessageKeyOf, MessageAt, Messages, MessageParamsOf, TranslateArgs } from './types.ts';

const en = {
  login: { title: 'Sign in', failed: 'These credentials do not match our records.' },
  attempts: '{count, plural, one {# attempt} other {# attempts}} left',
  greeting: 'Hello {name}, you have {count, plural, =0 {no messages} one {# message from {sender}} other {# messages}} since {since, date, short}',
  kind: '{kind, select, link {Added {label}} other {Joined}}',
  plain: 'Nothing to fill in',
} as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(_: T) => undefined;

export function placeholders() {
  is<Equal<MessageKeyOf<typeof en>, 'login.title' | 'login.failed' | 'attempts' | 'greeting' | 'kind' | 'plain'>>(true);
  is<Equal<MessageAt<typeof en, 'login.title'>, 'Sign in'>>(true);
  is<Equal<MessageParamsOf<(typeof en)['attempts']>, { count: number }>>(true);
  // Nested placeholders inside plural branches count; `#` does not.
  is<Equal<MessageParamsOf<(typeof en)['greeting']>, { name: string | number; count: number; sender: string | number; since: Date | number | string }>>(true);
  is<Equal<MessageParamsOf<(typeof en)['kind']>, { kind: string; label: string | number }>>(true);
  is<Equal<MessageParamsOf<(typeof en)['plain']>, {}>>(true);
  // Without `as const` the text is just `string`: anything goes.
  is<Equal<MessageParamsOf<string>, Record<string, unknown>>>(true);

  const t = <M extends string>(_message: M, ..._params: TranslateArgs<M>) => '';
  t(en.attempts, { count: 3 });
  t(en.plain);
  // @ts-expect-error — a text with placeholders needs their values
  t(en.attempts);
  // @ts-expect-error — `cnt` is not a placeholder of the text
  t(en.attempts, { cnt: 3 });
  // @ts-expect-error — a plural takes a number
  t(en.attempts, { count: 'three' });
}

export function translations() {
  const de = {
    login: { title: 'Anmelden', failed: 'Diese Zugangsdaten passen nicht.' },
    attempts: '{count, plural, one {# Versuch} other {# Versuche}} übrig',
    greeting: 'Hallo {name}, seit {since, date, short}: {count, plural, =0 {keine Nachrichten} one {# von {sender}} other {# Nachrichten}}',
    kind: '{kind, select, link {{label} hinzugefügt} other {Beigetreten}}',
    plain: 'Nichts einzusetzen',
  } satisfies Messages<typeof en>;

  const missing = {
    // @ts-expect-error — `failed` is missing in the translation
    login: { title: 'Anmelden' },
    attempts: '{count, plural, one {# Versuch} other {# Versuche}} übrig',
    greeting: 'Hallo {name} {count, plural, other {#}} {sender} {since}',
    kind: '{kind, select, link {{label}} other {x}}',
    plain: 'x',
  } satisfies Messages<typeof en>;

  const renamed = {
    login: { title: 'Anmelden', failed: 'x' },
    // @ts-expect-error — the placeholder `count` was renamed
    attempts: '{anzahl, plural, one {# Versuch} other {# Versuche}} übrig',
    greeting: 'Hallo {name} {count, plural, other {#}} {sender} {since}',
    kind: '{kind, select, link {{label}} other {x}}',
    plain: 'x',
  } satisfies Messages<typeof en>;

  const extra = {
    login: { title: 'Anmelden', failed: 'x' },
    attempts: '{count, plural, other {#}}',
    greeting: 'Hallo {name} {count, plural, other {#}} {sender} {since}',
    kind: '{kind, select, link {{label}} other {x}}',
    plain: 'x',
    // @ts-expect-error — a key the source does not have
    surplus: 'x',
  } satisfies Messages<typeof en>;

  return [de, missing, renamed, extra];
}

export type Unused = [KeyOf<string>, ParamsOf<string>, CheckKey<'a', {}, 'b'>, CoreKeyOf<string>];
