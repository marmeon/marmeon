import { actions, resolveRoute, type ActionException, type ActionMethod, type ActionOutcome, type Confirm, type OptimisticUpdate, type Reloading, type Submission } from '@bespokecore/http/client';
import type {
  ActionBodyOf,
  ActionDataOf,
  ActionRedirects,
  BrowserRouteNameInput,
  CheckActionRouteName,
  CheckBrowserRouteName,
  FlashMessage,
  MethodOf,
  Param,
  ParamsOf,
  Query,
  QueryParams,
} from '@bespokecore/http/page';
import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';
import { RoutesContext } from './routes.ts';
import type { RouteFormFields } from './use-form.ts';

export type { ActionException } from '@bespokecore/http/client';

/** The fields of an action's body (its request schema's input), by name — any string without a schema. */
export type ActionField<N extends string> = [ActionBodyOf<N>] extends [never] ? string : keyof ActionBodyOf<N> & string;

/**
 * How an action of route `N` ended, typed by its controller (E59):
 * - `data`: it answered `this.json(…)` — `data` is what JSON made of it (`Serialize<T>`); only when the controller has such a branch;
 * - `redirect`: it redirected — reported, not followed (`onRedirect: 'visit'` follows it); only when the controller can;
 * - `flash` (with both): the flash messages its controller flashed (E60) — they also fire for `useFlash`, once;
 * - `invalid`: 422 — the first message per field of its request schema;
 * - `exception`: offline, or a failure status (401/419 after signing out, 403, 404, 5xx) — shown, never retried by itself;
 * - `cancelled`: `cancel()`, a newer call with the same `key`, or the page was left.
 *
 * ```ts
 * const result = await remove.submit({ params: { user, link } });
 * if (result.ok && result.kind === 'data') result.data.deleted;
 * ```
 */
export type ActionResultOf<N extends string> =
  | ([ActionDataOf<N>] extends [never]
      ? never
      : { readonly ok: true; readonly kind: 'data'; readonly status: number; readonly data: ActionDataOf<N>; readonly flash: readonly FlashMessage[] })
  | (ActionRedirects<N> extends true ? { readonly ok: true; readonly kind: 'redirect'; readonly redirect: string; readonly flash: readonly FlashMessage[] } : never)
  | { readonly ok: false; readonly kind: 'invalid'; readonly errors: Partial<Record<ActionField<N>, string>>; readonly message: string | undefined }
  | { readonly ok: false; readonly kind: 'exception'; readonly exception: ActionException }
  | { readonly ok: false; readonly kind: 'cancelled' };

/** Reloads to run once an action succeeded — from `router.reloading(…)` / `useIsland().reloading(…)`. */
export type ActionReload = Reloading | readonly Reloading[];

type DataOption<N extends string> = [ActionBodyOf<N>] extends [never]
  ? { data?: `'${N}' takes no body — its controller has no request schema (or it is a GET: pass \`query\`)` }
  : {} extends ActionBodyOf<N>
    ? { data?: ActionBodyOf<N> }
    : { data: ActionBodyOf<N> };

type ParamsOption<N extends string, RequiresParams extends boolean> = RequiresParams extends true ? { params: ParamsOf<N> } : { params?: ParamsOf<N> };

type QueryOption<N extends string> = MethodOf<N> extends 'get' ? { query?: QueryParams<N> } : { query?: never };

/** What one call of an action sends, and what it does on screen meanwhile and afterwards. */
export type ActionSubmitOptions<N extends string, RequiresParams extends boolean = false> = DataOption<N> &
  ParamsOption<N, RequiresParams> &
  QueryOption<N> & {
    /**
     * Shown at once, rolled back unless it succeeds (model 1) — `router.optimistic((props) => …)`, typed against the page (or
     * layer, or island) it patches.
     */
    optimistic?: OptimisticUpdate | readonly OptimisticUpdate[];
    /**
     * Reloaded in the background once it succeeded — `router.reloading({ only: ['profile'] })`, typed against the page. A patch
     * on what reloads goes in the same render the server's props land in; any other patch becomes the state.
     */
    reload?: ActionReload | readonly ActionReload[];
    /** A newer call with the same key cancels this one (the last click of a toggle counts). Without one, calls run side by side. */
    key?: string;
    /** `'visit'`: follow the controller's redirect afterwards. Default: report it (`{ kind: 'redirect' }`). */
    onRedirect?: 'visit';
    /**
     * Ask first (E64): `confirm: t('links.confirm_remove')`, or `{ message, prompt: 'DELETE' }` to type a text. A no sends
     * nothing — the call ends `cancelled`, nothing optimistic shows.
     */
    confirm?: Confirm;
  };

type SubmitArgs<N extends string, RequiresParams extends boolean> = {} extends ActionSubmitOptions<N, RequiresParams>
  ? [options?: ActionSubmitOptions<N, RequiresParams>]
  : [options: ActionSubmitOptions<N, RequiresParams>];

/** A call of an action under way, as `usePendingSubmissions` and `action.submissions` list it — a ghost row's data (E59 model 2). */
export interface PendingSubmission<N extends string> {
  readonly id: number;
  /** What it sends: the route's request schema input. */
  readonly input: RouteFormFields<N>;
  readonly method: ActionMethod;
  readonly url: string;
}

/** What `useAction` gives a component. */
export interface Action<N extends string, RequiresParams extends boolean = false> {
  /**
   * Sends the action — without navigating: no history entry, no page change. Resolves with how it ended (never rejects for a
   * failed request). Calls run side by side; each has its own optimistic patches.
   */
  submit(...args: SubmitArgs<N, RequiresParams>): Promise<ActionResultOf<N>>;
  /** A call is under way. */
  readonly pending: boolean;
  /** This component's calls under way, oldest first. */
  readonly submissions: readonly PendingSubmission<N>[];
  /** How the last call that finished ended. */
  readonly result: ActionResultOf<N> | undefined;
  /** The data of the last call that succeeded with data. */
  readonly data: ([ActionDataOf<N>] extends [never] ? never : ActionDataOf<N>) | undefined;
  /** The first message per field of the last call's validation errors (422). */
  readonly errors: Partial<Record<ActionField<N>, string>>;
  readonly hasErrors: boolean;
  /** Why the last call failed — offline, or the server's status (401/419: signed out). Cleared by the next call. */
  readonly exception: ActionException | undefined;
  clearErrors(...fields: ActionField<N>[]): void;
  /** Aborts this component's calls under way: each ends `cancelled`, its patches rolled back. */
  cancel(): void;
}

function firstMessages(errors: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const first: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) if (typeof messages[0] === 'string') first[field] = messages[0];
  return first;
}

function flatten<T>(value: T | readonly T[] | readonly (T | readonly T[])[] | undefined): T[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? (value as unknown[]) : [value]).flat() as T[];
}

/**
 * A non-navigating request to a named route (E59) — Inertia's `useHttp`, React Router's `useFetcher`, typed by the route:
 * the body by its controller's request schema, the result by what its controller returns (`this.json(…)`, a redirect).
 *
 * ```tsx
 * const router = useRouter<ShowUserProfileController>();
 * const remove = useAction('user-profile.links.destroy');
 * await remove.submit({
 *   params: { user: profile.id, link: link.id },
 *   optimistic: router.optimistic((props) => ({ profile: { ...props.profile, links: props.profile.links.filter((l) => l.id !== link.id) } })),
 *   reload: router.reloading({ only: ['profile'] }),
 * });
 * ```
 *
 * An action is an ordinary request of its route — middleware, CSRF, authorization and validation run as for a form. It never
 * touches the history; its answer is never cached; a redirect is reported, not followed.
 */
export function useAction<const N extends BrowserRouteNameInput>(name: CheckActionRouteName<N>): Action<N, {} extends ParamsOf<N> ? false : true>;
export function useAction<const N extends BrowserRouteNameInput>(name: CheckActionRouteName<N>, params: ParamsOf<N>): Action<N, false>;
export function useAction(name: string, params?: Readonly<Record<string, Param>>): Action<string, boolean> {
  const router = useRouterContext();
  const manifest = useContext(RoutesContext);
  const [calls, setCalls] = useState<readonly PendingSubmission<string>[]>([]);
  const [result, setResult] = useState<ActionResultOf<string> | undefined>(undefined);
  const [data, setData] = useState<unknown>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const controller = useRef(new AbortController());
  const boundParams = useRef(params);
  boundParams.current = params;
  const nextCall = useRef(0);

  const submit = useCallback(
    async (options: Partial<ActionSubmitOptions<string>> & { params?: Readonly<Record<string, Param>>; query?: Query } = {}): Promise<ActionResultOf<string>> => {
      const navigator = router.navigator();
      if (!navigator) throw new Error(`useAction('${name}'): actions run in the browser, not while rendering on the server.`);
      const target = resolveRoute(manifest, name, { ...boundParams.current, ...options.params }, options.query);
      const method = target.method.split(',')[0]!.toLowerCase() as ActionMethod;
      const body = options.data as Record<string, unknown> | undefined;
      const id = ++nextCall.current;
      const pending: PendingSubmission<string> = { id, input: (body ?? {}) as RouteFormFields<string>, method, url: target.url };
      setCalls((current) => [...current, pending]);
      setErrors({});
      let outcome: ActionOutcome;
      try {
        // The feature attaches on first use (E70): an app without actions carries none of it.
        outcome = await navigator.use(actions).run(target.url, {
          method,
          ...(method === 'get' ? {} : { data: body ?? {} }),
          name,
          ...(options.key !== undefined ? { key: `${name}#${options.key}` } : {}),
          signal: controller.current.signal,
          ...(options.optimistic ? { optimistic: options.optimistic } : {}),
          reload: flatten<Reloading>(options.reload as ActionReload | readonly ActionReload[] | undefined),
          ...(options.onRedirect ? { onRedirect: options.onRedirect } : {}),
          ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
        });
      } finally {
        setCalls((current) => current.filter((call) => call !== pending));
      }
      const typed: ActionResultOf<string> = outcome.kind === 'invalid' ? { ok: false, kind: 'invalid', errors: firstMessages(outcome.errors), message: outcome.message } : outcome;
      setResult(typed);
      if (typed.kind === 'invalid') setErrors(typed.errors as Record<string, string>);
      if (typed.kind === 'data') setData(typed.data);
      return typed;
    },
    [router, manifest, name],
  );

  const cancel = useCallback(() => {
    controller.current.abort();
    controller.current = new AbortController();
  }, []);
  const clearErrors = useCallback(
    (...fields: string[]) => setErrors((current) => (fields.length === 0 ? {} : Object.fromEntries(Object.entries(current).filter(([field]) => !fields.includes(field))))),
    [],
  );

  return useMemo(
    () => ({
      submit: submit as Action<string, boolean>['submit'],
      pending: calls.length > 0,
      submissions: calls,
      result,
      data: data as never,
      errors,
      hasErrors: Object.keys(errors).length > 0,
      exception: result?.kind === 'exception' ? result.exception : undefined,
      clearErrors,
      cancel,
    }),
    [submit, calls, result, data, errors, clearErrors, cancel],
  );
}

const NO_SUBMISSIONS: readonly Submission[] = [];
const noSubscription = () => () => {};

/**
 * The calls under way to route `N` — of every component, actions and route forms (`useForm(name, …)`) alike, oldest first:
 * optimistic UI derived from what is being sent (E59 model 2, React Router's pending UI) — ghost rows, with nothing to roll
 * back. A call is listed until the props it reloads have landed, so its row never blinks out before the real one is there.
 *
 * ```tsx
 * const adding = usePendingSubmissions('user-profile.links.store');
 * {adding.map((call) => <li key={call.id} aria-busy="true">{call.input.label}</li>)}
 * ```
 */
export function usePendingSubmissions<const N extends BrowserRouteNameInput>(name: CheckBrowserRouteName<N>): readonly PendingSubmission<N>[] {
  // Attached while rendering (E70): a route form's visit is listed from then on — the component showing its ghost rows is there first.
  const submissions = useRouterContext().navigator()?.use(actions).submissions();
  const all = useSyncExternalStore(submissions?.subscribe ?? noSubscription, () => submissions?.list ?? NO_SUBMISSIONS, () => NO_SUBMISSIONS);
  return useMemo(
    () =>
      all
        .filter((submission) => submission.name === name)
        .map((submission) => ({ id: submission.id, input: submission.input as RouteFormFields<N>, method: submission.method, url: submission.url })),
    [all, name],
  );
}
