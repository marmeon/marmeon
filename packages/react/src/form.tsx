import {
  defaultFormEntries,
  fieldPath,
  firstErrors,
  FORM_METHOD_FIELD,
  FORM_TOKEN_FIELD,
  formEntries,
  formObject,
  isSensitiveRememberField,
  linkQuery,
  liveValidationOnFirstUse,
  resolveRoute,
  restoreFormEntries,
  sameEntries,
  sensitiveControl,
  type Confirm,
  type LooksLikePassword,
  type FormLiveValidation,
  type VisitMethod,
  type VisitOptions,
  type VisitProgress,
} from '@marmeon/http/client';
import type { BrowserRouteNameInput, CheckBrowserRouteName, MethodOf, ParamsOf, RouteQueryOf, Routes } from '@marmeon/http/page';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type FormHTMLAttributes,
  type ReactNode,
} from 'react';
import { usePage, useRouterContext } from './app.tsx';
import { useRememberStore } from './remember.ts';
import { RoutesContext } from './routes.ts';
import { useGuard } from './state.ts';
import type { LiveValidationSetting, PasswordNeverRemembered, RouteFormFields } from './use-form.ts';

type Primitive = string | number | boolean | bigint | null | undefined | Date;

/**
 * The `name` attributes of a form's fields, in bracket notation (what a browser sends and the server parses back): `label`,
 * `user[name]`, `abilities[]` for a list of values, `links[0][url]` for a list of objects. Four levels deep at most.
 */
export type FieldName<F, Depth extends unknown[] = []> = Depth['length'] extends 4
  ? never
  : { [K in keyof F & string]-?: NameOf<K, NonNullable<F[K]>, Depth> }[keyof F & string];

type NameOf<P extends string, V, Depth extends unknown[]> = V extends Primitive | Blob
  ? P
  : V extends readonly (infer Item)[]
    ? NonNullable<Item> extends Primitive | Blob
      ? `${P}[]`
      : `${P}[${number}]` | Nested<`${P}[${number}]`, NonNullable<Item>, Depth>
    : V extends object
      ? Nested<P, V, Depth>
      : P;

type Nested<P extends string, V, Depth extends unknown[]> = { [K in keyof V & string]-?: NameOf<`${P}[${K}]`, NonNullable<V[K]>, [...Depth, 0]> }[keyof V & string];

/** A GET form writes the query: its fields are the route's query schema's — never a body. */
type QueryFieldsOf<N extends string> = [RouteQueryOf<N>] extends [never] ? {} : RouteQueryOf<N>;

/** The fields of `<Form route>`: a GET route's query schema, any other route's request schema (none: a button-only form). */
export type FormFieldsOf<N extends string> = [MethodOf<N>] extends ['get'] ? QueryFieldsOf<N> : RouteFormFields<N> extends Record<string, unknown> ? (string extends keyof RouteFormFields<N> ? {} : RouteFormFields<N>) : RouteFormFields<N>;

/**
 * A route `<Form>` may send to: one the browser knows — a GET route only with a query schema (its fields are the query:
 * a form never puts body fields into a URL).
 */
export type CheckFormElementRoute<N extends string> =
  CheckBrowserRouteName<N> extends N
    ? N extends keyof Routes
      ? [MethodOf<N>] extends ['get']
        ? [RouteQueryOf<N>] extends [never]
          ? `'${N}' is a GET route without a query schema — a form's fields would go into its URL; give its controller \`static request = defineRequest({ query })\`, or send it with a <Link>`
          : N
        : N
      : N
    : CheckBrowserRouteName<N>;

/** What the render function of `<Form>` gets — the form's state, typed by its route. */
export interface FormRenderState<F> {
  /** The first message per field (by path: `label`, `links.0.url`) — from the server's answer, or a live validation. */
  readonly errors: Partial<Record<string, string>>;
  readonly hasErrors: boolean;
  /** Its request is under way (`data-pending` on the form). */
  readonly processing: boolean;
  /** How far an upload is (a form with a file), else null. */
  readonly progress: VisitProgress | null;
  readonly wasSuccessful: boolean;
  /** The last submit succeeded less than two seconds ago — for a short "Saved." */
  readonly recentlySuccessful: boolean;
  /** Whether a field differs from where the form started (`data-dirty` on the form) — any field, or the one named. */
  isDirty(name?: FieldName<F>): boolean;
  /**
   * The attributes of a field, its name checked against the route's fields — spread them onto any input, shadcn's
   * `<Input>` too: `<input {...form.field('label')} />` gives `name="label"` and `aria-invalid` while it has an error. (A
   * `name` written out by hand is not checked: the DOM's names are strings.)
   */
  field(name: FieldName<F>): { name: string; 'aria-invalid'?: true };
  /** The first message of a field — `form.error('links[0][url]')`. */
  error(name: FieldName<F>): string | undefined;
  /** Whether a live check of the field (or any) is under way (`validate`). */
  validating(name?: FieldName<F>): boolean;
  /** Sends it — what pressing its submit button does. */
  submit(): void;
  /** Back to where it started: the markup's values (the DOM's reset), no errors. */
  reset(): void;
  clearErrors(...names: FieldName<F>[]): void;
}

/** The fields of a form that `remember.include` may name: any but those named like a password, which are never remembered. */
type IncludableName<F> = Extract<FieldName<F>, string> extends infer N ? (N extends string ? (LooksLikePassword<N> extends true ? never : N) : never) : never;

type ParamsProp<N extends string> = {} extends ParamsOf<N> ? { params?: ParamsOf<N> } : { params: ParamsOf<N> };

export type FormProps<N extends string> = {
  /** The route it sends to — method and URL from it; a GET route writes its query. */
  route: CheckFormElementRoute<N>;
  children: ReactNode | ((form: FormRenderState<FormFieldsOf<N>>) => ReactNode);
  /** Ask first: `confirm="Revoke the token?"`, or with a title, labels or a text to type. A no sends nothing. */
  confirm?: Confirm;
  /** Live validation: fields checked against the server's schema when they are left (or while typed into). Not for GET. */
  validate?: true | Omit<LiveValidationSetting<FormFieldsOf<N>>, 'fields'> & { fields?: readonly string[] };
  /** The navigation guard while the form is dirty — `true`, or the question to ask. Its own submit passes. */
  guard?: boolean | string;
  /**
   * Remember the input across Back/Forward: `true` (as `form:<route>`), a key, or `{ key, include }` — in memory only, never
   * password-, token-, secret-, code- or card-like fields, nor password, one-time-code or card controls (`include` lets the non-password ones in, a card control by its name) or files.
   */
  remember?: true | string | { key?: string; include?: readonly (PasswordNeverRemembered | IncludableName<FormFieldsOf<N>>)[] };
  /** After it succeeded, back to the markup's values (a create form: empty again). */
  resetOnSuccess?: boolean;
  /** Visit options of the submit — keep the scroll position (the default), replace the history entry, a partial reload. */
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  only?: readonly string[];
  reset?: readonly string[];
  onSuccess?: () => void;
  /** The server rejected the input: the first message per field. */
  onError?: (errors: Record<string, string>) => void;
  onFinish?: () => void;
} & ParamsProp<N> &
  Omit<FormHTMLAttributes<HTMLFormElement>, 'action' | 'method' | 'children' | 'onSubmit'>;

const noSubscription = () => () => {};
const NOTHING_PENDING: readonly string[] = [];

/**
 * An uncontrolled form for a named route: it reads its fields from the DOM — any input with a `name` — and
 * sends them like `useForm` does. Without JavaScript it is a real `<form>` (`_method`, the CSRF token as `_token`); only a GET
 * route's form writes its fields into the URL, any other sends them in the body. See docs/forms.md#forms-without-state.
 */
export function Form<const N extends BrowserRouteNameInput>(props: FormProps<N>) {
  const {
    route,
    params,
    children,
    confirm,
    validate,
    guard: guardSetting,
    remember: rememberSetting,
    resetOnSuccess = false,
    preserveScroll = true,
    preserveState,
    replace,
    only,
    reset: resetProps,
    onSuccess,
    onError,
    onFinish,
    ...attributes
  } = props as FormProps<string> & { params?: Record<string, string | number> };
  const page = usePage();
  const { visit } = useRouterContext();
  const manifest = useContext(RoutesContext);
  const target = resolveRoute(manifest, route as string, params);
  const method = target.method.toLowerCase() as VisitMethod;
  const element = useRef<HTMLFormElement | null>(null);

  const [errors, setErrors] = useState<Partial<Record<string, string>>>(() => firstErrors(page as never));
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<VisitProgress | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Dirty: the entries now against where the form started — the markup's defaults, or what the last success sent.
  const baseline = useRef<[string, string][] | undefined>(undefined);
  const [dirtyNames, setDirtyNames] = useState<readonly string[]>([]);
  const measure = useCallback(() => {
    const form = element.current;
    if (!form) return;
    const start = baseline.current ?? defaultFormEntries(form);
    const now = formEntries(form);
    const names = [...new Set([...start, ...now].map(([name]) => name))].filter(
      (name) => !sameEntries(start.filter(([n]) => n === name), now.filter(([n]) => n === name)),
    );
    setDirtyNames((current) => (current.length === names.length && current.every((name, index) => name === names[index]) ? current : names));
  }, []);
  const dirty = dirtyNames.length > 0;
  const guard = useGuard(guardSetting !== undefined && guardSetting !== false && dirty, typeof guardSetting === 'string' ? guardSetting : undefined);

  // Remembered input: the entries (never sensitive ones, never files) and the errors, with the history entry.
  const remember = rememberSetting === undefined ? undefined : rememberOf(rememberSetting, route as string);
  const { store, key: rememberKey } = useRememberStore(remember?.key ?? '');
  useLayoutEffect(() => {
    const form = element.current;
    if (!form || !remember || !store?.has(rememberKey)) return;
    const kept = store.get(rememberKey) as KeptEntries;
    restoreFormEntries(form, kept.entries, kept.names);
    setErrors(kept.errors);
    measure();
    // Once, when the form mounts in its entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rememberKey]);
  const neverNames = useRef(new Set<string>());
  const keep = useCallback(
    (nextErrors: Partial<Record<string, string>>) => {
      const form = element.current;
      if (!form || !remember || !store) return;
      // A control that says what it holds (a password, a one-time code, a card detail) counts, whatever its name; only a card
      // detail can be let in, by name, with `include`. A name stays one it has been: a show-password toggle that turns the field
      // into plain text does not let it in.
      const never = neverNames.current;
      const card = new Set<string>();
      const controls = Array.from(form.elements as unknown as ArrayLike<HTMLInputElement>);
      for (const control of controls) {
        const kind = sensitiveControl(control);
        if (kind) (kind === 'never' ? never : card).add(control.name);
      }
      // What the controls say about themselves is noted now, before a toggle can change it; the rest is read when the rules that
      // tell sensitive names are there (the first write waits for their chunk).
      store.set(rememberKey, () => {
        const allowed = (name: string) => !never.has(name) && !(card.has(name) && !remember.include.includes(fieldPath(name))) && !isSensitiveRememberField(fieldPath(name), remember.include);
        const entries = formEntries(form).filter(([name]) => allowed(name));
        const names = [...new Set(controls.map((control) => control.name).filter((name) => name && allowed(name)))];
        const unchanged = sameEntries(entries, (baseline.current ?? defaultFormEntries(form)).filter(([name]) => allowed(name)));
        // Nothing typed and nothing to show: nothing to keep.
        return unchanged && Object.keys(nextErrors).length === 0 ? undefined : ({ entries, names, errors: nextErrors } satisfies KeptEntries);
      });
    },
    [remember?.key, remember?.include.join(','), store, rememberKey],
  );
  useEffect(() => keep(errors), [keep, errors]);

  // Live validation: the form's data as the server would parse it, the field left by its path.
  const live = useFormLiveValidation(method, target.url, validate, element, errors, setErrors);

  const send = async (submitter?: HTMLElement | null) => {
    const form = element.current;
    if (!form || processing) return;
    live?.cancel();
    // The button that sent it adds its `name=value` (a form of buttons: the language switcher) — when it is this form's.
    const data = submitter && (submitter as HTMLButtonElement).form === form ? new FormData(form, submitter) : new FormData(form);
    data.delete(FORM_TOKEN_FIELD);
    data.delete(FORM_METHOD_FIELD);
    const entries = [...data];
    let url = target.url;
    let body: VisitOptions['data'];
    if (method === 'get') {
      // A GET form writes the query — its fields, nothing else; defaults of the page on screen left out.
      const query: Record<string, string | string[]> = {};
      for (const [name, value] of entries) {
        if (typeof value !== 'string') continue;
        const current = query[name];
        query[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
      }
      url = resolveRoute(manifest, route as string, params, linkQuery(page as never, target.url, query)).url;
    } else {
      // Files: multipart (with progress), as the browser would; else the fields as the server parses them.
      body = entries.some(([, value]) => value instanceof Blob) ? data : formObject(entries);
    }
    setProcessing(true);
    setWasSuccessful(false);
    try {
      const sent = baseline.current;
      const answer = await visit(url, {
        method,
        ...(body !== undefined ? { data: body } : {}),
        preserveScroll,
        ...(preserveState !== undefined ? { preserveState } : {}),
        ...(replace !== undefined ? { replace } : {}),
        ...(only ? { only } : {}),
        ...(resetProps ? { reset: resetProps } : {}),
        ...(confirm !== undefined ? { confirm } : {}),
        name: route as string,
        // Its own guard does not stop it — the others still ask.
        ignoreGuards: [guard],
        onProgress: (next) => setProgress(next),
      });
      if (!answer) return;
      const failed = firstErrors(answer);
      setErrors(failed);
      if (Object.keys(failed).length > 0) {
        onError?.(failed);
        return;
      }
      if (resetOnSuccess) {
        form.reset();
        baseline.current = sent;
      } else {
        // What was sent is where it starts over: not dirty any more (the guard lets go).
        baseline.current = formEntries(form);
      }
      measure();
      setWasSuccessful(true);
      setRecentlySuccessful(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRecentlySuccessful(false), 2000);
      onSuccess?.();
    } finally {
      setProcessing(false);
      setProgress(null);
      onFinish?.();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send((event.nativeEvent as SubmitEvent).submitter);
  };

  const state: FormRenderState<Record<string, unknown>> = {
    errors,
    hasErrors: Object.keys(errors).length > 0,
    processing,
    progress,
    wasSuccessful,
    recentlySuccessful,
    isDirty: (name?: string) => (name === undefined ? dirty : dirtyNames.includes(name)),
    field: (name: string) => ({ name, ...(errors[fieldPath(name)] !== undefined ? { 'aria-invalid': true as const } : {}) }),
    error: (name: string) => errors[fieldPath(name)],
    validating: (name?: string) => (live ? live.pending.some((path) => name === undefined || path === fieldPath(name) || path.startsWith(`${fieldPath(name)}.`)) : false),
    submit: () => void send(),
    reset: () => {
      element.current?.reset();
      baseline.current = undefined;
      setErrors({});
      live?.reset();
      queueMicrotask(measure);
    },
    clearErrors: (...names: string[]) => {
      const paths = names.map(fieldPath);
      setErrors((current) => (paths.length === 0 ? {} : Object.fromEntries(Object.entries(current).filter(([path]) => !paths.includes(path)))));
    },
  } as unknown as FormRenderState<Record<string, unknown>>;

  // Without JavaScript: a plain form — POST for every write (the method in `_method`), the token in `_token`.
  const native = method === 'get' ? 'get' : 'post';
  return (
    <form
      {...attributes}
      ref={element}
      action={target.url}
      method={native}
      onSubmit={onSubmit}
      onInput={(event) => {
        attributes.onInput?.(event);
        measure();
        keep(errors);
        const name = (event.target as { name?: unknown }).name;
        if (typeof name === 'string' && name !== '') live?.changed(fieldPath(name));
      }}
      onChange={(event) => {
        attributes.onChange?.(event);
        measure();
        keep(errors);
      }}
      onBlur={(event) => {
        attributes.onBlur?.(event);
        const name = (event.target as { name?: unknown }).name;
        if (typeof name === 'string' && name !== '') live?.blurred(fieldPath(name));
      }}
      {...(processing ? { 'data-pending': '' } : {})}
      {...(dirty ? { 'data-dirty': '' } : {})}
    >
      {/* `_method` first: the server looks for it at the start of the body only. */}
      {native === 'post' && method !== 'post' && <input type="hidden" name={FORM_METHOD_FIELD} value={method.toUpperCase()} />}
      {native === 'post' && page.csrf !== undefined && <input type="hidden" name={FORM_TOKEN_FIELD} value={page.csrf} />}
      {typeof children === 'function' ? (children as (form: FormRenderState<Record<string, unknown>>) => ReactNode)(state) : children}
    </form>
  );
}

/** What a remembered `<Form>` keeps: its entries, which names it kept (the others were left out), its errors. */
interface KeptEntries {
  readonly entries: [string, string][];
  readonly names: string[];
  readonly errors: Partial<Record<string, string>>;
}

function rememberOf(setting: NonNullable<FormProps<string>['remember']>, route: string): { key: string; include: readonly string[] } {
  if (setting === true) return { key: `form:${route}`, include: [] };
  if (typeof setting === 'string') return { key: setting, include: [] };
  return { key: setting.key ?? `form:${route}`, include: ((setting.include ?? []) as readonly string[]).map(fieldPath) };
}

/** The live validation of an uncontrolled form — its data read from the DOM when a check is sent. */
function useFormLiveValidation(
  method: VisitMethod,
  url: string,
  setting: FormProps<string>['validate'],
  element: { readonly current: HTMLFormElement | null },
  errors: Partial<Record<string, string>>,
  setErrors: (update: (current: Partial<Record<string, string>>) => Partial<Record<string, string>>) => void,
): FormLiveValidation | undefined {
  const navigator = useRouterContext().navigator();
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const config = setting === true ? {} : setting || undefined;
  const fieldsKey = config?.fields?.join(',');
  const live = useMemo(() => {
    if (!navigator || !config || method === 'get') return undefined;
    return liveValidationOnFirstUse(navigator, url, {
      method,
      data: () => (element.current ? formObject(formEntries(element.current)) : {}),
      hasError: (field) => errorsRef.current[field] !== undefined,
      on: config.on ?? 'blur',
      ...(config.debounce === undefined ? {} : { debounce: config.debounce }),
      ...(config.fields ? { fields: config.fields.map(fieldPath) } : {}),
      onResult: (outcome) =>
        setErrors((current) => {
          const next = Object.fromEntries(Object.entries(current).filter(([field]) => !outcome.fields.some((name) => field === name || field.startsWith(`${name}.`))));
          if (outcome.kind === 'invalid') for (const [field, messages] of Object.entries(outcome.errors)) if (typeof messages[0] === 'string') next[field] = messages[0];
          return next;
        }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigator, url, method, config === undefined, config?.on, config?.debounce, fieldsKey]);
  useEffect(() => () => live?.cancel(), [live]);
  useSyncExternalStore(live?.subscribe ?? noSubscription, () => live?.pending ?? NOTHING_PENDING, () => NOTHING_PENDING);
  return live;
}
