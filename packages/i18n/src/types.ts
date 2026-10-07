/**
 * Types of messages, keys and placeholders — computed from the English (source) files themselves, without code
 * generation (E38). Browser-safe: types only.
 */
import type { Suggest } from '@marmeon/router';

/** The messages of one namespace: `{ login: { title: 'Sign in' } }` — strings, nested in objects. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/**
 * The app's messages by namespace, merged in by declaration from each module's source file (`lang/en.ts`) — the
 * namespace is the module's name, `app` for the app-wide `lang/` folder:
 *
 * ```ts
 * const en = { login: { title: 'Sign in' } } as const;
 * export default en;
 * declare module '@marmeon/i18n/messages' {
 *   interface Translations { auth: typeof en }
 * }
 * ```
 *
 * `as const` keeps the texts as types: that is what types the placeholders (`{count}` → `count: number`).
 */
export interface Translations {}

/** A namespace of the app's messages — any string until a module declares one. */
export type Namespace = [keyof Translations] extends [never] ? string : keyof Translations & string;

type Segment = string | number;

/** The keys of a message tree: dot paths to its texts — `'login.title' | 'attempts'`. */
export type KeyOf<T> = T extends string
  ? never
  : { [K in keyof T & Segment]: T[K] extends string ? `${K}` : `${K}.${KeyOf<T[K]>}` }[keyof T & Segment];

type Prop<T, K extends string> = K extends keyof T ? T[K] : K extends `${infer N extends number}` ? (N extends keyof T ? T[N] : never) : never;

/** The text at key `P` of tree `T`. */
export type MessageAt<T, P extends string> = P extends `${infer Head}.${infer Rest}` ? MessageAt<Prop<T, Head>, Rest> : Prop<T, P>;

/** Every key of the app — `namespace.path`: `'auth.login.title'`. Any string until a module declares its messages. */
export type TranslationKey = [keyof Translations] extends [never]
  ? string
  : { [N in keyof Translations & string]: `${N}.${KeyOf<Translations[N]>}` }[keyof Translations & string];

/** The text of an app-wide key (`auth.login.title`). */
export type MessageOf<K extends string> = K extends `${infer N}.${infer P}`
  ? N extends keyof Translations
    ? MessageAt<Translations[N], P>
    : string
  : string;

// ---------------------------------------------------------------------------------------------------------------
// Placeholders — an ICU subset, read from the text's type: `{name}`, `{n, number}`, `{d, date, short}`,
// `{count, plural, one {# item} other {# items}}`, `{kind, select, a {…} other {…}}` (nested ones included).

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;
type FirstPart<S extends string> = S extends `${infer First},${string}` ? First : S;

/** What a placeholder of this type takes. */
type ValueOf<Type extends string> = Type extends 'plural' | 'selectordinal' | 'number'
  ? number
  : Type extends 'date' | 'time'
    ? Date | number | string
    : Type extends 'select'
      ? string
      : string | number;

type Add<Out, Name extends string, Type extends string> = Out & { [K in Trim<Name>]: ValueOf<Trim<Type>> };

/** Message text: the next `{` opens a placeholder, a `}` before it closes the branch we are in. */
type Text<S extends string, Depth extends 0[], Out> = S extends `${infer Before}{${infer After}`
  ? Before extends `${string}}${infer Rest}`
    ? Close<`${Rest}{${After}`, Depth, Out>
    : Placeholder<After, Depth, Out>
  : S extends `${string}}${infer Rest}`
    ? Close<Rest, Depth, Out>
    : Out;

type Close<S extends string, Depth extends 0[], Out> = Depth extends [0, ...infer Outer extends 0[]] ? Branches<S, Outer, Out> : Text<S, Depth, Out>;

/** After `{`: `name}`, `name, type}`, `name, type, style}` — or `name, plural, <branches>}`. */
type Placeholder<S extends string, Depth extends 0[], Out> = S extends `${infer Head}}${infer Rest}`
  ? Head extends `${infer Start}{${string}`
    ? Start extends `${infer Name},${infer Type},${string}`
      ? Branches<S extends `${Name},${Type},${infer Body}` ? Body : never, Depth, Add<Out, Name, Type>>
      : Out
    : Head extends `${infer Name},${infer Type}`
      ? Text<Rest, Depth, Add<Out, Name, FirstPart<Type>>>
      : Text<Rest, Depth, Add<Out, Head, ''>>
  : Out;

/** The branches of `plural`/`select`: `{` opens one (a message of its own), a `}` before it ends the placeholder. */
type Branches<S extends string, Depth extends 0[], Out> = S extends `${infer Before}{${infer After}`
  ? Before extends `${string}}${infer Rest}`
    ? Text<`${Rest}{${After}`, Depth, Out>
    : Text<After, [0, ...Depth], Out>
  : S extends `${string}}${infer Rest}`
    ? Text<Rest, Depth, Out>
    : Out;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The placeholders of a text and what they take: `'{count, plural, …} left'` → `{ count: number }`. */
export type ParamsOf<M> = M extends string ? (string extends M ? Record<string, unknown> : Simplify<Text<M, [], {}>>) : Record<string, unknown>;

/**
 * The arguments after the key: the placeholders' values — required when the text has any. For a key that is no key
 * (`never`), optional: the error is the key's, not a count of arguments.
 */
export type TranslateArgs<M> = [M] extends [never] ? [params?: Record<string, unknown>] : {} extends ParamsOf<M> ? [params?: ParamsOf<M>] : [params: ParamsOf<M>];

// ---------------------------------------------------------------------------------------------------------------
// Translations of a source file.

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** A text containing `{name` for every placeholder name — what a translation of a text with placeholders must keep. */
type Keeps<Names extends string> = [Names] extends [never] ? string : UnionToIntersection<Names extends string ? `${string}{${Names}${string}` : never>;

/**
 * What a translation of a source file must be — every key of it, nothing more, and each text keeping the source's
 * placeholders (`{count}` stays `{count}`, whatever the words around it):
 *
 * ```ts
 * import type en from './en.ts';
 * export default { login: { title: 'Anmelden' } } satisfies Messages<typeof en>;
 * ```
 */
export type Messages<T> = {
  readonly [K in keyof T]: T[K] extends string ? (string extends T[K] ? string : Keeps<keyof ParamsOf<T[K]> & string>) : Messages<T[K]>;
};

/** `K` when it is a key of tree `T`; otherwise a message naming the namespace, with the keys next to it. */
export type CheckKey<K extends string, T, N extends string> = K extends KeyOf<T>
  ? K
  : `'${K}' is not a key of the ${N} messages${Suggest<K, KeyOf<T> & string>}`;

/** `K` when it is an app-wide key; otherwise a message saying why. */
export type CheckTranslationKey<K extends string> = string extends TranslationKey
  ? K
  : K extends TranslationKey
    ? K
    : K extends `${infer N}.${infer P}`
      ? N extends keyof Translations
        ? `'${P}' is not a key of the ${N} messages${Suggest<P, KeyOf<Translations[N]> & string>}`
        : `'${N}' is not a namespace of messages — namespaces are module names (modules/<module>/lang/en.ts) and 'app' (lang/en.ts)`
      : `'${K}' is not a translation key — keys are '<namespace>.<path>', e.g. 'auth.login.title'`;
