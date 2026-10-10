import { dirtyPaths, firstErrors, isDirtyPath, liveValidationOnFirstUse, resolveRoute, type FormLiveValidation, type VisitMethod, type VisitOptions, type VisitProgress } from '@marmeon/http/client';
import type { BrowserRouteNameInput, CheckBrowserRouteName, CheckLiveField, CheckUploadField, ControllerOf, FormOf, ParamsOf, PasswordNeverLive, Routes } from '@marmeon/http/page';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';
import { useRememberStore } from './remember.ts';
import { RoutesContext } from './routes.ts';
import { useGuard } from './state.ts';

/** The data of a form: the controller's schema input (`useForm<UpdateUserProfileController>`), or given directly. */
type FormFields<T> = [FormOf<T>] extends [never] ? T : FormOf<T>;

type Field<F> = keyof F & string;

type Primitive = string | number | boolean | bigint | symbol | null | undefined | Date | Blob;

/**
 * The paths into a form's data — `name`, `address.city`, `links.${number}.url` — what `isDirty(path)` takes. Five levels
 * deep at most.
 */
export type FieldPath<F, Depth extends unknown[] = []> = Depth['length'] extends 5
  ? never
  : F extends Primitive
    ? never
    : F extends readonly (infer Item)[]
      ? `${number}` | `${number}.${FieldPath<Item, [...Depth, 0]>}`
      : { [K in keyof F & string]: K | (FieldPath<F[K], [...Depth, 0]> extends infer Deeper extends string ? `${K}.${Deeper}` : never) }[keyof F & string];

/** What a remembered form may not keep — in `remember.include`, the message for a password field. */
export type PasswordNeverRemembered = 'password fields are never remembered — they stay in the field until the page is left';

/** The fields of a form whose names look sensitive (a token, a secret, a card) — what `remember.include` may name. Never passwords. */
type SensitiveFormField<F> = keyof {
  [K in keyof F & string as Lowercase<K> extends `${string}password${string}`
    ? never
    : Lowercase<K> extends `${string}${'secret' | 'token' | 'card' | 'cvc'}${string}`
      ? K
      : never]: true;
} &
  string;

/** How a form remembers its input across Back/Forward. */
export interface RememberFormOptions<F> {
  /** The key it is kept under in its history entry — default `form:<route name>` (a route form). */
  key?: string;
  /**
   * Fields kept although their names look sensitive (`card_holder`, `token_name`) — left out by default, like files. Passwords
   * never. (Spelled out, so a message lists the names.)
   */
  include?: readonly (PasswordNeverRemembered | SensitiveFormField<F>)[];
}

/** How a form behaves beyond its data. */
export interface FormOptions<F = Record<string, unknown>> {
  /**
   * The navigation guard: while the form is dirty, leaving asks first. `true`, or the question to ask. Its own submit
   * passes. See docs/forms.md#unsaved-changes.
   */
  guard?: boolean | string;
  /**
   * Remember the input across Back/Forward, in memory only, per history entry — the key it is kept under (a form by
   * controller needs one), or the options. Password-, token-, secret- and card-like fields and files are never kept
   * (`include` lets the non-password ones in). See docs/forms.md#remembering-input.
   */
  remember?: string | RememberFormOptions<F>;
}

/**
 * Live validation of a route form: its touched fields checked against the server's request schema while they are filled
 * in. Password fields are never sent. See docs/forms.md#validating-while-typing.
 */
export interface LiveValidationSetting<F> {
  /**
   * When: `blur` (the default) — call `form.validate('email')` in `onBlur`; a field that shows an error is checked again while
   * it is typed into, so fixing it clears the message. `change` — while typing, after a pause (`debounce`).
   */
  on?: 'blur' | 'change';
  /** The pause after typing before a check (ms, default 300). */
  debounce?: number;
  /** Which fields — default all of them (but passwords). (`LiveField<F>`, spelled out: a message lists the names, not the alias.) */
  fields?: readonly (PasswordNeverLive | (keyof { [K in keyof F & string as Lowercase<K> extends `${string}password${string}` ? never : K]: true } & string))[];
}

/** How a route form behaves beyond its data: the guard — and live validation, which needs its route's URL. */
export interface RouteFormOptions<F> extends Omit<FormOptions<F>, 'remember'> {
  /** Check fields against the server while they are filled in: `true`, or when and which (see {@link LiveValidationSetting}). */
  validate?: true | LiveValidationSetting<F>;
  /** Remember the input across Back/Forward — `true` (kept as `form:<route name>`), a key, or the options. See {@link FormOptions.remember}. */
  remember?: true | string | RememberFormOptions<F>;
}

/**
 * How a form is sent — the visit's callbacks with Inertia's meanings: `onError` gets the *validation* errors
 * (here the first message per field), `onException` a request that failed (offline, 5xx — the app also shows it over
 * the page), and `onFinish` runs after every submit.
 */
export interface FormSubmitOptions extends Omit<VisitOptions, 'method' | 'data' | 'onSuccess' | 'onError' | 'onFinish'> {
  onSuccess?: () => void;
  /** The server rejected the input: the first message per field. */
  onError?: (errors: Record<string, string>) => void;
  /** After every submit — succeeded, invalid, failed or cancelled. */
  onFinish?: () => void;
}

/** What every form has: its data, the server's errors and the state of the last submit. */
export interface FormState<F> {
  readonly data: F;
  set<K extends keyof F & string>(field: K, value: F[K]): void;
  setData(data: F): void;
  /** The first message per field, from the server's validation. */
  readonly errors: Partial<Record<Field<F>, string>>;
  readonly hasErrors: boolean;
  clearErrors(...fields: Field<F>[]): void;
  /** A request is in flight. */
  readonly processing: boolean;
  /** How far the upload is, while a form with a file (`FormData`) is sent — else null. */
  readonly progress: VisitProgress | null;
  /** The last submit succeeded. */
  readonly wasSuccessful: boolean;
  /** The last submit succeeded less than two seconds ago — for a short "Saved." */
  readonly recentlySuccessful: boolean;
  /**
   * Whether something differs from where the form started — anything, or the field at `path` (`isDirty('bio')`,
   * `isDirty('links.0.url')`, typed). Where it started: the initial data, or what the last successful submit sent.
   */
  isDirty(path?: FieldPath<F>): boolean;
  /** The paths that differ, leaves first: `['bio', 'links.0.url']` — for `data-dirty` on the fields. */
  readonly dirty: readonly string[];
  /** Back to the initial data — all fields or some. */
  reset(...fields: Field<F>[]): void;
}

/** A form for a controller, sent to any URL: `useForm<UpdateUserProfileController>(initial)` then `form.put(url)`. */
export interface Form<T> extends FormState<FormFields<T>> {
  submit(method: VisitMethod, url: string, options?: FormSubmitOptions): Promise<void>;
  get(url: string, options?: FormSubmitOptions): Promise<void>;
  post(url: string, options?: FormSubmitOptions): Promise<void>;
  put(url: string, options?: FormSubmitOptions): Promise<void>;
  patch(url: string, options?: FormSubmitOptions): Promise<void>;
  delete(url: string, options?: FormSubmitOptions): Promise<void>;
}

/** A field of a route form, bound to an input — what `<FileInput field>` takes: `form.field('avatar')`. */
export interface FormField {
  readonly form: Pick<RouteForm<Record<string, unknown>>, 'data' | 'set' | 'method' | 'url'>;
  readonly name: string;
}

/** A form for a named route: it knows method, URL and fields — `form.submit()`. */
export interface RouteForm<F> extends FormState<F> {
  /** Sends the data with the route's method to its URL. */
  submit(options?: FormSubmitOptions): Promise<void>;
  readonly method: VisitMethod;
  readonly url: string;
  /**
   * Live validation (`validate` option): checks the touched fields now — when `field` was changed (so in `onBlur`:
   * tabbing through an untouched field asks nothing). Without `field`: every touched one. Without the option: nothing.
   */
  validate<const K extends string>(field?: CheckLiveField<F, K>): void;
  /** Whether a live check of `field` (or of any field) is under way — for a spinner, `aria-busy`. */
  validating<const K extends string>(field?: CheckLiveField<F, K>): boolean;
  /**
   * An upload field (its rule is `upload()`), bound for `<FileInput field={form.field('avatar')} />`. The field's value is
   * then the {@link Upload} — `form.data.avatar?.uploading`, `.progress`, `.preview`, `.error`, `.cancel()` — and goes to the
   * server as its token.
   */
  field<const K extends string>(name: CheckUploadField<F, K>): FormField;
}

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

type RouteFormOf<N extends string> = FormOf<Instance<ControllerOf<N>>>;

/** The fields of route `N`: its controller's request schema input. */
export type RouteFormFields<N extends string> = [RouteFormOf<N>] extends [never] ? Record<string, unknown> : RouteFormOf<N>;

/** A browser route whose controller has a request schema — the form's fields come from it. (Any name while no routes are generated.) */
type CheckFormRoute<N extends string> =
  CheckBrowserRouteName<N> extends N
    ? N extends keyof Routes
      ? [RouteFormOf<N>] extends [never]
        ? `'${N}' has no request schema to type a form with — give its controller \`static request = defineRequest(…)\``
        : N
      : N
    : CheckBrowserRouteName<N>;

/** What a route form with required parameters says when they are left out — `useForm(name, initial)`. */
type ParamsFirst<N extends string> = `'${N}' takes route parameters — pass them before the initial data: useForm('${N}', params, initial)`;

/**
 * `(params, initial)`, or just `(initial)` when the route takes no required parameters. Without the parameters a route needs,
 * the one argument is the message (else TypeScript would report the controller overload: "'string' is not assignable to 'object'").
 */
type RouteFormArgs<N extends string> = {} extends ParamsOf<N>
  ? [initial: RouteFormFields<N>] | [params: ParamsOf<N>, initial: RouteFormFields<N>]
  : [params: ParamsOf<N>, initial: RouteFormFields<N>] | [initial: ParamsFirst<N>];

/**
 * Form state and submission, typed from the endpoint's request schema — by route name (method, URL and fields from
 * `bootstrap/routes.ts`), or by controller, sent to any URL (`useForm<UpdateUserProfileController>(initial)`, `form.put(url)`).
 * The fields are the schema's *input* (what the browser sends). See docs/forms.md#forms-by-route-name.
 */
export function useForm<T extends object>(initial: FormFields<T> & object, options?: FormOptions<FormFields<T>>): Form<T>;
export function useForm<const N extends BrowserRouteNameInput>(name: CheckFormRoute<N>, ...args: RouteFormArgs<N>): RouteForm<RouteFormFields<N>>;
// Last: TS reports a mistake against the last overload whose arity fits — this one for four arguments (a wrong option, a
// password field in `validate.fields`), the one above for two or three (the route's message).
export function useForm<const N extends BrowserRouteNameInput>(
  name: CheckFormRoute<N>,
  params: ParamsOf<N>,
  initial: RouteFormFields<N>,
  options: RouteFormOptions<RouteFormFields<N>>,
): RouteForm<RouteFormFields<N>>;
export function useForm(...args: unknown[]): unknown {
  const named = typeof args[0] === 'string';
  const name = named ? (args[0] as string) : undefined;
  // (name, initial) · (name, params, initial) · (name, params, initial, options) · (initial) · (initial, options)
  const options = ((named ? args.length === 4 && args[3] : args.length === 2 && args[1]) || {}) as RouteFormOptions<Record<string, unknown>>;
  const params = named && args.length >= 3 ? (args[1] as Record<string, string | number>) : undefined;
  const initial = (named ? args[args.length === 4 ? 2 : args.length - 1] : args[0]) as Record<string, unknown>;

  const { visit } = useRouterContext();
  const manifest = useContext(RoutesContext);
  const target = name === undefined ? undefined : resolveRoute(manifest, name, params);
  // Remembered input: what this history entry kept of the form, back where it was typed — sensitive fields never were.
  const remember = rememberSetting(options.remember, name);
  const { store, key: rememberKey } = useRememberStore(remember?.key ?? '');
  const kept = remember && store?.has(rememberKey) ? (store.get(rememberKey) as KeptForm | undefined) : undefined;
  const [defaults, setDefaults] = useState(initial);
  const [data, setData] = useState(() => (kept ? { ...initial, ...kept.data } : initial));
  // Saved: the form starts over where it is once the submit's callbacks ran — what was sent, but what they `reset()` back at the
  // defaults it had before (a password field empty again). Taken in the next render, so a reset inside `onSuccess`/`onFinish` counts.
  const [saved, setSaved] = useState(false);
  if (saved) {
    setSaved(false);
    setDefaults(data);
  }
  const dirty = useMemo(() => dirtyPaths(defaults, data), [defaults, data]);
  // The navigation guard, while dirty — its own submit passes it. A remembered input that differs is dirty, too.
  const guard = useGuard(options.guard !== undefined && options.guard !== false && dirty.length > 0, typeof options.guard === 'string' ? options.guard : undefined);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>(() => kept?.errors ?? {});
  const include = remember?.include.join(',');
  useEffect(() => {
    if (!remember || !store) return;
    // Nothing typed and nothing to show: nothing to keep (an entry that comes back shows the initial data anyway).
    if (dirty.length === 0 && Object.keys(errors).length === 0) {
      store.delete(rememberKey);
      return;
    }
    store.set(rememberKey, { data, errors }, remember.include.map((field) => `data.${field}`));
    // `remember` is read by its key and fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rememberKey, include, data, errors, dirty.length]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<VisitProgress | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const live = useLiveValidation(target, options.validate, data, errors, setErrors);

  const send = useCallback(
    async (method: VisitMethod, url: string, { onSuccess, onError, onFinish, onProgress, ...options }: FormSubmitOptions = {}) => {
      // Sent: its answer decides the errors — a live check under way would only land on top of it.
      live?.cancel();
      setProcessing(true);
      setWasSuccessful(false);
      try {
        const page = await visit(url, {
          preserveScroll: true,
          ...options,
          // Its own guard does not stop it — the others (another form's unsaved changes) still ask.
          ignoreGuards: options.ignoreGuards === true ? true : [...(options.ignoreGuards ?? []), guard],
          method,
          data,
          onProgress: (next, current) => {
            setProgress(next);
            onProgress?.(next, current);
          },
        });
        if (!page) return;
        const failed = firstErrors(page);
        setErrors(failed);
        if (Object.keys(failed).length > 0) {
          onError?.(failed);
        } else {
          // Saved: not dirty any more (the guard lets go) — see `saved`.
          setSaved(true);
          live?.reset();
          setWasSuccessful(true);
          setRecentlySuccessful(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setRecentlySuccessful(false), 2000);
          onSuccess?.();
        }
      } finally {
        setProcessing(false);
        setProgress(null);
        onFinish?.();
      }
    },
    [visit, data, guard, live],
  );

  const submit = (...submitArgs: unknown[]): Promise<void> => {
    // A route form is listed while under way, by its name (`usePendingSubmissions(name)`: ghost rows).
    if (target) return send(target.method as VisitMethod, target.url, { name, ...(submitArgs[0] as FormSubmitOptions | undefined) } as FormSubmitOptions);
    return send(submitArgs[0] as VisitMethod, submitArgs[1] as string, submitArgs[2] as FormSubmitOptions | undefined);
  };

  const form: Form<Record<string, unknown>> & { method?: VisitMethod; url?: string } = {
    data,
    set: (field, value) => {
      setData((current) => ({ ...current, [field]: value }));
      live?.changed(field);
    },
    setData: (next) => {
      for (const field in { ...data, ...next }) if (!Object.is(data[field], next[field])) live?.changed(field);
      setData(next);
    },
    errors,
    hasErrors: Object.keys(errors).length > 0,
    clearErrors: (...fields) =>
      setErrors((current) => Object.fromEntries(fields.length === 0 ? [] : Object.entries(current).filter(([key]) => !fields.includes(key)))),
    processing,
    progress,
    wasSuccessful,
    recentlySuccessful,
    isDirty: (path?: string) => isDirtyPath(dirty, path),
    dirty,
    reset: (...fields) => setData((current) => (fields.length === 0 ? defaults : { ...current, ...Object.fromEntries(fields.map((field) => [field, defaults[field]])) })),
    submit: submit as Form<Record<string, unknown>>['submit'],
    ...(Object.fromEntries((['get', 'post', 'put', 'patch', 'delete'] as const).map((method) => [method, (url: string, options?: FormSubmitOptions) => send(method, url, options)])) as Pick<
      Form<Record<string, unknown>>,
      VisitMethod
    >),
    ...(target
      ? {
          method: target.method as VisitMethod,
          url: target.url,
          validate: (field?: string) => {
            if (!live) return;
            if (field === undefined) void live.validate();
            else live.blurred(field);
          },
          validating: (field?: string) => !!live && isPending(live.pending, field),
          field: (name: string) => ({ form, name }),
        }
      : {}),
  };
  return form;
}

const noSubscription = () => () => {};
const NOTHING_PENDING: readonly string[] = [];

/** What a remembered form keeps. */
interface KeptForm {
  readonly data: Record<string, unknown>;
  readonly errors: Partial<Record<string, string>>;
}

/** The `remember` option as key and fields — undefined when the form remembers nothing. */
function rememberSetting(setting: RouteFormOptions<Record<string, unknown>>['remember'], name: string | undefined): { key: string; include: readonly string[] } | undefined {
  // Not set, or `false` (an empty key is none either).
  if (!setting) return undefined;
  const options = typeof setting === 'object' ? setting : {};
  const key = typeof setting === 'string' ? setting : (options.key ?? (name !== undefined ? `form:${name}` : 'form'));
  return { key, include: (options.include ?? []) as readonly string[] };
}

/** Whether path `name` is `field` or lies under it (`address.city` under `address`). */
const under = (name: string, field: string) => name === field || name.startsWith(`${field}.`);

function isPending(pending: readonly string[], field?: string): boolean {
  return field === undefined ? pending.length > 0 : pending.some((name) => under(name, field));
}

/**
 * The live validation of a route form — the core's `LiveValidation`, with its results merged into the form's errors:
 * a checked field's message is replaced by what the server said now (or removed); fields not checked keep theirs. Its code
 * loads on the form's first use: an app whose forms check nothing live never downloads it.
 */
function useLiveValidation(
  target: { method: string; url: string } | undefined,
  setting: RouteFormOptions<Record<string, unknown>>['validate'],
  data: Record<string, unknown>,
  errors: Partial<Record<string, string>>,
  setErrors: (update: (current: Partial<Record<string, string>>) => Partial<Record<string, string>>) => void,
): FormLiveValidation | undefined {
  const navigator = useRouterContext().navigator();
  const dataRef = useRef(data);
  dataRef.current = data;
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const config = setting === true ? {} : setting || undefined;
  const method = target?.method.toLowerCase();
  const fieldsKey = config?.fields?.join(',');
  const live = useMemo(() => {
    if (!navigator || !target || !config || method === undefined || method === 'get') return undefined;
    return liveValidationOnFirstUse(navigator, target.url, {
      method: method as 'post' | 'put' | 'patch' | 'delete',
      data: () => dataRef.current,
      hasError: (field) => errorsRef.current[field] !== undefined,
      on: config.on ?? 'blur',
      // Unset ones stay undefined: the live validation's defaults apply.
      debounce: config.debounce as number,
      fields: config.fields as readonly string[],
      onResult: (outcome) =>
        setErrors((current) => {
          const next = Object.fromEntries(Object.entries(current).filter(([field]) => !outcome.fields.some((name) => under(field, name))));
          if (outcome.kind === 'invalid') for (const [field, messages] of Object.entries(outcome.errors)) if (typeof messages[0] === 'string') next[field] = messages[0];
          return next;
        }),
    });
    // The setting is read once per URL, method, trigger and field list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigator, target?.url, method, config === undefined, config?.on, config?.debounce, fieldsKey]);
  // Nothing scheduled or under way outlives the form (a remount gets the same instance back: cancel, never close).
  useEffect(() => () => live?.cancel(), [live]);
  useSyncExternalStore(live?.subscribe ?? noSubscription, () => live?.pending ?? NOTHING_PENDING, () => NOTHING_PENDING);
  return live;
}
