import type { BrowserRouteNameInput, CheckBrowserRouteName, ControllerOf, FormOf, ParamsOf, Routes } from '@bespokecore/http/page';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter, type VisitMethod, type VisitOptions, type VisitProgress } from './app.tsx';
import { resolveRoute, RoutesContext } from './routes.ts';

/** The data of a form: the controller's schema input (`useForm<UpdateUserProfileController>`), or given directly. */
type FormFields<T> = [FormOf<T>] extends [never] ? T : FormOf<T>;

type Field<F> = keyof F & string;

/**
 * How a form is sent — the visit's callbacks with Inertia's meanings (E44): `onError` gets the *validation* errors
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
  /** Something differs from the initial data. */
  readonly isDirty: boolean;
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

/** A form for a named route (E40): it knows method, URL and fields — `form.submit()`. */
export interface RouteForm<F> extends FormState<F> {
  /** Sends the data with the route's method to its URL. */
  submit(options?: FormSubmitOptions): Promise<void>;
  readonly method: VisitMethod;
  readonly url: string;
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

/** `(params, initial)`, or just `(initial)` when the route takes no required parameters. */
type RouteFormArgs<N extends string> = {} extends ParamsOf<N>
  ? [initial: RouteFormFields<N>] | [params: ParamsOf<N>, initial: RouteFormFields<N>]
  : [params: ParamsOf<N>, initial: RouteFormFields<N>];

/**
 * Form state and submission, typed from the endpoint's request schema. By route name (E40), the form knows
 * method, URL and fields — from `bootstrap/routes.ts`:
 *
 * ```tsx
 * const form = useForm('user-profile.update', { user: profile.id }, { name: profile.name, bio: profile.bio });
 * <input value={form.data.name} onChange={(e) => form.set('name', e.target.value)} />
 * {form.errors.name && <p>{form.errors.name}</p>}
 * <button disabled={form.processing} onClick={() => form.submit()}>Save</button>
 * ```
 *
 * Or by controller, sent to any URL: `useForm<UpdateUserProfileController>(initial)` and `form.put(url)`.
 *
 * The fields are the schema's *input* (what the browser sends), and the errors come
 * back from the server — a failed submit redirects back with `errors` in the page
 * props, without a reload and without losing what was typed.
 */
export function useForm<const N extends BrowserRouteNameInput>(name: CheckFormRoute<N>, ...args: RouteFormArgs<N>): RouteForm<RouteFormFields<N>>;
export function useForm<T>(initial: FormFields<T>): Form<T>;
export function useForm(...args: unknown[]): unknown {
  const named = typeof args[0] === 'string';
  const name = named ? (args[0] as string) : undefined;
  const params = named && args.length >= 3 ? (args[1] as Record<string, string | number>) : undefined;
  const initial = (named ? args.at(-1) : args[0]) as Record<string, unknown>;

  const { visit } = useRouter();
  const manifest = useContext(RoutesContext);
  const target = name === undefined ? undefined : resolveRoute(manifest, name, params);
  const [defaults] = useState(initial);
  const [data, setData] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<VisitProgress | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = useCallback(
    async (method: VisitMethod, url: string, { onSuccess, onError, onFinish, onProgress, ...options }: FormSubmitOptions = {}) => {
      setProcessing(true);
      setWasSuccessful(false);
      try {
        const page = await visit(url, {
          preserveScroll: true,
          ...options,
          method,
          data,
          onProgress: (next, current) => {
            setProgress(next);
            onProgress?.(next, current);
          },
        });
        if (!page) return;
        const failed = firstMessages((page.props as { errors?: unknown }).errors);
        setErrors(failed);
        if (Object.keys(failed).length > 0) {
          onError?.(failed);
        } else {
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
    [visit, data],
  );

  const submit = (...submitArgs: unknown[]): Promise<void> => {
    if (target) return send(target.method as VisitMethod, target.url, submitArgs[0] as FormSubmitOptions | undefined);
    return send(submitArgs[0] as VisitMethod, submitArgs[1] as string, submitArgs[2] as FormSubmitOptions | undefined);
  };

  const form: Form<Record<string, unknown>> & { method?: VisitMethod; url?: string } = {
    data,
    set: (field, value) => setData((current) => ({ ...current, [field]: value })),
    setData,
    errors,
    hasErrors: Object.keys(errors).length > 0,
    clearErrors: (...fields) =>
      setErrors((current) => (fields.length === 0 ? {} : Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key))))),
    processing,
    progress,
    wasSuccessful,
    recentlySuccessful,
    isDirty: JSON.stringify(data) !== JSON.stringify(defaults),
    reset: (...fields) => {
      if (fields.length === 0) setData(defaults);
      else setData((current) => ({ ...current, ...Object.fromEntries(fields.map((field) => [field, defaults[field]])) }));
    },
    submit: submit as Form<Record<string, unknown>>['submit'],
    get: (url, options) => send('get', url, options),
    post: (url, options) => send('post', url, options),
    put: (url, options) => send('put', url, options),
    patch: (url, options) => send('patch', url, options),
    delete: (url, options) => send('delete', url, options),
    ...(target ? { method: target.method as VisitMethod, url: target.url } : {}),
  };
  return form;
}

/** Server errors are lists per field; forms show the first. */
function firstMessages(errors: unknown): Record<string, string> {
  if (typeof errors !== 'object' || errors === null) return {};
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (typeof first === 'string') result[field] = first;
  }
  return result;
}
