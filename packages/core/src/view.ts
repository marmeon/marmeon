const VIEW_RESULT = Symbol.for('bespokecore.view-result');

export type ViewProps = Record<string, unknown>;

/** What a controller returns to render a page. The server decides how (SSR HTML or JSON). */
export interface ViewResult<TProps extends ViewProps = ViewProps> {
  readonly [VIEW_RESULT]: true;
  readonly component: string;
  readonly props: TProps;
  readonly status: number;
}

export function view<const TProps extends ViewProps>(component: string, props: TProps, status = 200): ViewResult<TProps> {
  return { [VIEW_RESULT]: true, component, props, status };
}

export function isViewResult(value: unknown): value is ViewResult {
  return typeof value === 'object' && value !== null && VIEW_RESULT in value;
}

/**
 * Infers a page's props from the controller method that renders it — the
 * controller is the single source of truth for the data contract.
 *
 * ```ts
 * export default function Show({ user }: PageProps<UserProfileController['show']>) {}
 * ```
 *
 * Non-view branches (redirects, JSON `Response`s) are filtered out.
 */
export type PageProps<TAction extends (...args: never[]) => unknown> =
  Awaited<ReturnType<TAction>> extends infer TResult ? (TResult extends ViewResult<infer TProps> ? TProps : never) : never;
