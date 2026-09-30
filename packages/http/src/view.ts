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

/** A controller class instance (`handle(ctx)`) or a route closure. */
type PageAction = { handle: (...args: never[]) => unknown } | ((...args: never[]) => unknown);

type ActionResult<TAction extends PageAction> = TAction extends { handle: (...args: never[]) => infer R }
  ? R
  : TAction extends (...args: never[]) => infer R
    ? R
    : never;

/**
 * Infers a page's props from the controller that renders it — the controller
 * is the single source of truth for the data contract.
 *
 * ```ts
 * export default function Show({ profile }: PageProps<ShowUserProfileController>) {}
 * ```
 *
 * Non-view branches (redirects, JSON `Response`s) are filtered out.
 */
export type PageProps<TAction extends PageAction> =
  Awaited<ActionResult<TAction>> extends infer TResult ? (TResult extends ViewResult<infer TProps> ? TProps : never) : never;
