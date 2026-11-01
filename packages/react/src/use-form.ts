import { dirtyPaths, firstErrors, isDirtyPath, liveValidationOnFirstUse, type FormLiveValidation } from '@marmeon/http/client/adapter';
import { resolveRoute, type LooksLikePassword, type LooksSensitive, type VisitMethod, type VisitOptions, type VisitProgress } from '@marmeon/http/client';
import type { BrowserParamsOf, BrowserRouteNameInput, CheckBrowserRouteName, CheckLiveField, CheckUploadField, ControllerOf, FormOf, Routes, SensitiveNeverLive, Upload } from '@marmeon/http/page';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';
import { useRememberStore } from './remember.ts';
import { RoutesContext } from './routes.ts';
import { useGuard } from './state.ts';

/**
 * What `r.boolean()` and `r.accepted()` take (`BooleanInput` of @marmeon/validation, spelled out: this package does not import
 * it) — kept equal by apps/web-app/modules/lab/boolean-field.type-test.tsx.
 */
type BooleanRuleInput = boolean | 0 | 1 | '0' | '1' | 'true' | 'false' | 'on' | 'off' | 'yes' | 'no';

/**
 * A field whose input is exactly what `r.boolean()` takes holds a `boolean` in the form (a checkbox gives one); `undefined` and
 * `null` stay. Equality by assignability both ways, so a field that takes only some of those inputs keeps its type. Objects
 * and lists are searched too; dates, files, uploads and functions are left alone.
 */
type FormValue<V> = unknown extends V
  ? V
  : [NonNullable<V>] extends [never]
    ? V
    : [NonNullable<V>] extends [BooleanRuleInput]
      ? [BooleanRuleInput] extends [NonNullable<V>]
        ? boolean | Extract<V, null | undefined>
        : V
      : V extends Primitive | Upload | ((...args: never) => unknown)
        ? V
        : { [K in keyof V]: FormValue<V[K]> };

/**
 * The data of a form: the controller's schema input (`useForm<UpdateUserProfileController>`), with a boolean rule's field as
 * `boolean`, or given directly.
 */
type FormFields<T> = [FormOf<T>] extends [never] ? T : BooleanFields<FormOf<T>>;

/** `F` with every boolean rule's field typed `boolean`. */
export type BooleanFields<F> = { [K in keyof F]: FormValue<F[K]> };

type Field<F> = keyof F & string;

/** What `errors` is keyed by: the top-level fields (also of a generic `F`), every path into the data, and `_`. */
type ErrorKey<F> = Field<F> | FieldPath<F> | '_';

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

/** The fields of a form whose names look sensitive (a token, a secret, a code, a card) — what `remember.include` may name. Never passwords. */
type SensitiveFormField<F> = keyof {
  [K in keyof F & string as LooksLikePassword<K> extends true ? never : LooksSensitive<K> extends true ? K : never]: true;
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
   * controller needs one), or the options. Password-, token-, secret-, code- and card-like fields and files are never kept
   * (`include` lets the non-password ones in). See docs/forms.md#remembering-input.
   */
  remember?: string | RememberFormOptions<F>;
}

/**
 * Live validation of a route form: its touched fields checked against the server's request schema while they are filled
 * in. Password, card, one-time-code and token fields are never sent. See docs/forms.md#validating-while-typing.
 */
export interface LiveValidationSetting<F> {
  /**
   * When: `blur` (the default) — call `form.validate('email')` in `onBlur`; a field that shows an error is checked again while
   * it is typed into, so fixing it clears the message. `change` — while typing, after a pause (`debounceMs`).
   */
  on?: 'blur' | 'change';
  /** The pause after typing before a check (ms, default 300). */
  debounceMs?: number;
  /** Which fields — default all of them (but those named like a secret). (`LiveField<F>`, spelled out: a message lists the names, not the alias.) */
  fields?: readonly (SensitiveNeverLive | (keyof { [K in keyof F & string as LooksSensitive<K> extends true ? never : K]: true } & string))[];
}

/** How a route form behaves beyond its data: the guard — and live validation, which needs its route's URL. */
export interface RouteFormOptions<F> extends Omit<FormOptions<F>, 'remember'> {
  /** Check fields against the server while they are filled in: `true`, or when and which (see {@link LiveValidationSetting}). */
  validate?: true | LiveValidationSetting<F>;
  /** Remember the input across Back/Forward — `true` (kept as `form:<route name>`), a key, or the options. See {@link FormOptions.remember}. */
  remember?: true | string | RememberFormOptions<F>;
}

/** The keys of a route form's options (and `params`), to tell options from fields at run time. */
const routeFormOptionKeys = ['params', 'guard', 'remember', 'validate'] as const satisfies readonly (keyof RouteFormOptions<never> | 'params')[];
// A new option that is missing in `routeFormOptionKeys` is a compile error here.
const optionKeysComplete: Exclude<keyof RouteFormOptions<never> | 'params', (typeof routeFormOptionKeys)[number]> extends never ? true : never = true;
void optionKeysComplete;

/**
 * How a form is sent — the visit's callbacks: `onError` gets the *validation* errors
 * (here the first message per field), `onException` a request that failed (offline, 5xx, an answer that is no page — the app also shows it over
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
  /**
   * The first message per field, from the server's validation, keyed by every path of the data (`address.city`, `items.0.name`,
   * `answers.${string}` for a record) — and `_` for a message that belongs to the form, not a field. See `docs/forms.md#errors-at-nested-and-dynamic-fields`.
   */
  readonly errors: Partial<Record<ErrorKey<F>, string>>;
  readonly hasErrors: boolean;
  clearErrors(...fields: ErrorKey<F>[]): void;
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

/**
 * What a component needs of a form that shows only some of its fields: `form: FormPart<StoreNoteController, 'title' | 'body'>`.
 * Any form that has those fields fits — a `useForm<StoreNoteController>` and a `useForm<UpdateNoteController>`, or a route form —
 * and a form whose field cannot hold what the part's type allows does not; type the part from the controller with the narrower
 * field types. `errors` and `clearErrors` take the part's fields and their paths. There is no `setData`, which would replace the
 * data of the whole form, and `reset()` without arguments resets the whole form, not only the part.
 * See `docs/forms.md#a-component-shared-by-two-forms`.
 */
export type FormPart<C, K extends keyof FormFields<C> & string> = Omit<FormState<Pick<FormFields<C>, K>>, 'setData'>;

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
export type RouteFormFields<N extends string> = [RouteFormOf<N>] extends [never] ? Record<string, unknown> : BooleanFields<RouteFormOf<N>>;

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
type ParamsMissing<N extends string> = `'${N}' takes route parameters — pass them as useForm('${N}', initial, { params })`;

/**
 * The options of a route form, with its route parameters: `{ params }` is required when the route has required parameters,
 * else optional.
 */
type RouteFormRest<N extends string> = {} extends BrowserParamsOf<N>
  ? [options?: RouteFormOptions<RouteFormFields<N>> & { params?: BrowserParamsOf<N> }]
  : [options: RouteFormOptions<RouteFormFields<N>> & { params: BrowserParamsOf<N> }];

/**
 * Form state typed by a controller's request schema, sent to a URL you pass to `form.post(url)`.
 * The fields are the schema's *input* (what the browser sends): `useForm<StoreNoteController>(initial)`.
 * See docs/forms.md#forms-by-controller.
 */
export function useForm<T extends object>(initial: FormFields<T> & object, options?: FormOptions<FormFields<T>>): Form<T>;
/**
 * Form state for a named route, with method, URL and fields taken from `bootstrap/routes.ts`; the route's parameters go in
 * `options.params`. `form.submit()` sends it. See docs/forms.md#forms-by-route-name.
 */
export function useForm<const N extends BrowserRouteNameInput>(name: CheckFormRoute<N>, initial: RouteFormFields<N>, ...rest: RouteFormRest<N>): RouteForm<RouteFormFields<N>>;
// Last: TS reports a mistake against the last overload whose arity fits — for a call without options this one, where a route
// with required parameters says how to pass them (else the error would be an argument count).
/** A route form without options: the route takes no required parameters. */
export function useForm<const N extends BrowserRouteNameInput>(
  name: CheckFormRoute<N>,
  initial: {} extends BrowserParamsOf<N> ? RouteFormFields<N> : ParamsMissing<N>,
): RouteForm<RouteFormFields<N>>;
export function useForm(...args: unknown[]): unknown {
  const named = typeof args[0] === 'string';
  const name = named ? (args[0] as string) : undefined;
  // `(name, params, initial[, options])` would read `params` as the data and the data as the options, silently: the third
  // argument is options only if its keys are options.
  if (named) {
    const unknown = typeof args[2] === 'object' && args[2] !== null ? Object.keys(args[2]).find((key) => !(routeFormOptionKeys as readonly string[]).includes(key)) : undefined;
    const hint = `the route parameters go in options.params: useForm('${name}', initial, { params })`;
    if (unknown !== undefined) throw new TypeError(`'${unknown}' is no option of useForm (${routeFormOptionKeys.join(', ')}) — ${hint}`);
    if (args.length > 3) throw new TypeError(`useForm('${name}', …) takes (name, initial, options) — ${hint}`);
  }
  // (name, initial) · (name, initial, options) · (initial) · (initial, options)
  const options = ((named ? args[2] : args[1]) || {}) as RouteFormOptions<Record<string, unknown>> & { params?: Record<string, string | number> };
  const params = named ? options.params : undefined;
  const initial = (named ? args[1] : args[0]) as Record<string, unknown>;

  const { visit, page } = useRouterContext();
  const manifest = useContext(RoutesContext);
  const target = name === undefined ? undefined : resolveRoute(manifest, name, { params, pageLocale: page.locale });
  // Remembered input: what this history entry kept of the form, back where it was typed — sensitive fields never were.
  const remember = rememberSetting(options.remember, name);
  const { store, key: rememberKey } = useRememberStore(remember?.key ?? '');
  const kept = remember && store?.has(rememberKey) ? (store.get(rememberKey) as KeptForm | undefined) : undefined;
  const [defaults, setDefaults] = useState(initial);
  const [data, setState] = useState(() => (kept ? { ...initial, ...kept.data } : initial));
  // The newest data, written by `set()`, `setData()` and `reset()` as they run: a `submit()` in the same handler sends it before the next render.
  const dataRef = useRef(data);
  // `render` is a functional update for field changes, so React applies them by lane: an urgent `set()` must not render a field a pending transition set.
  const setData = (next: Record<string, unknown>, render: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>) = next) => {
    dataRef.current = next;
    setState(render);
  };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `remember` is read by its key and fields (`include`), not by identity
  }, [store, rememberKey, include, data, errors, dirty.length]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<VisitProgress | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const live = useLiveValidation(target, options.validate, dataRef, errors, setErrors);

  const send = useCallback(
    async (method: VisitMethod, url: string, { onSuccess, onError, onFinish, onProgress, ...options }: FormSubmitOptions = {}) => {
      // Sent: its answer decides the errors — a live check under way would only land on top of it.
      live?.cancel();
      setProcessing(true);
      setWasSuccessful(false);
      // One snapshot for the body and for the baseline: a `set()` after this point is not part of the request.
      const sentData = dataRef.current;
      let atSuccess: Record<string, unknown> | undefined;
      try {
        const page = await visit(url, {
          preserveScroll: true,
          ...options,
          // Its own guard does not stop it — the others (another form's unsaved changes) still ask.
          ignoreGuards: options.ignoreGuards === true ? true : [...(options.ignoreGuards ?? []), guard],
          method,
          data: sentData,
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
          atSuccess = dataRef.current;
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
        try {
          onFinish?.();
        } finally {
          // Saved: the form starts over where the request left it, not dirty any more (the guard lets go). That is what was sent — an
          // edit typed while it was under way was never sent and stays dirty, and a sent edit a transition has not rendered yet is
          // saved all the same — plus what the callbacks changed (a `reset()` of the password, a cleared form), so their result is clean.
          if (atSuccess) setDefaults(savedBaseline(sentData, atSuccess, dataRef.current));
        }
      }
    },
    [visit, guard, live],
  );

  const submit = (...submitArgs: unknown[]): Promise<void> => {
    // A route form is listed while under way, by its name (`usePendingSubmissions(name)`: ghost rows).
    if (target) return send(target.method as VisitMethod, target.url, { name, ...(submitArgs[0] as FormSubmitOptions | undefined) } as FormSubmitOptions);
    return send(submitArgs[0] as VisitMethod, submitArgs[1] as string, submitArgs[2] as FormSubmitOptions | undefined);
  };

  const form: Form<Record<string, unknown>> & { method?: VisitMethod; url?: string } = {
    data,
    set: (field, value) => {
      setData({ ...dataRef.current, [field]: value }, (current) => ({ ...current, [field]: value }));
      live?.changed(field);
    },
    setData: (next) => {
      const current = dataRef.current;
      for (const field in { ...current, ...next }) if (!Object.is(current[field], next[field])) live?.changed(field);
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
    reset: (...fields) => {
      if (fields.length === 0) return setData(defaults);
      const restored = Object.fromEntries(fields.map((field) => [field, defaults[field]]));
      setData({ ...dataRef.current, ...restored }, (current) => ({ ...current, ...restored }));
    },
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

/** The baseline after a success: what was sent, with every top-level field the success callbacks changed (or removed) taken over. */
function savedBaseline(sent: Record<string, unknown>, atSuccess: Record<string, unknown>, now: Record<string, unknown>): Record<string, unknown> {
  const baseline = { ...sent };
  for (const key in { ...atSuccess, ...now }) {
    if (Object.is(atSuccess[key], now[key]) && key in atSuccess === key in now) continue;
    if (key in now) baseline[key] = now[key];
    else delete baseline[key];
  }
  return baseline;
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
  dataRef: { readonly current: Record<string, unknown> },
  errors: Partial<Record<string, string>>,
  setErrors: (update: (current: Partial<Record<string, string>>) => Partial<Record<string, string>>) => void,
): FormLiveValidation | undefined {
  const navigator = useRouterContext().navigator();
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
      debounceMs: config.debounceMs as number,
      fields: config.fields as readonly string[],
      onResult: (outcome) =>
        setErrors((current) => {
          const next = Object.fromEntries(Object.entries(current).filter(([field]) => !outcome.fields.some((name) => under(field, name))));
          if (outcome.kind === 'invalid') for (const [field, messages] of Object.entries(outcome.errors)) if (typeof messages[0] === 'string') next[field] = messages[0];
          return next;
        }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `config` is a new object each render: the memo follows its URL, method, trigger, debounce and field list
  }, [navigator, target?.url, method, config === undefined, config?.on, config?.debounceMs, fieldsKey]);
  // Nothing scheduled or under way outlives the form (a remount gets the same instance back: cancel, never close).
  useEffect(() => () => live?.cancel(), [live]);
  useSyncExternalStore(live?.subscribe ?? noSubscription, () => live?.pending ?? NOTHING_PENDING, () => NOTHING_PENDING);
  return live;
}
