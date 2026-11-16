import { always, isPrefetch, regionOf, SharedData, type SharedProps, type ValidationErrors } from '@marmeon/http';
import { DOCUMENT_HEADER, SUBMIT_HEADER } from '@marmeon/http/internal';
import type { HttpContext, Next } from '@marmeon/router';
import { Session } from './session.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /** Validation errors of the previous request, `{}` if none — what `useForm` shows next to the fields. */
    errors: ValidationErrors;
    /**
     * The conflict the previous request answered with (`conflict(current)` of a form sent as a page visit), `null` if none — what
     * `useForm` shows as `form.conflict`. `current` is left out when it was too big to keep. The prefixed name is the framework's: a
     * page's own prop of that name is dropped. See `docs/forms.md#conflicts`.
     */
    _conflict: { message: string; current?: unknown } | null;
  }
}

/**
 * Shares what a form that failed comes back with: its validation errors, and the conflict of a stale save, `null` when there is none.
 * Both reach every page of the `web` group, partial reloads too (`always`).
 */
export class ShareErrorsFromSession {
  readonly #session: Session;
  readonly #shared: SharedData;

  /** @internal Built by the container. */
  constructor(session: Session, shared: SharedData) {
    this.#session = session;
    this.#shared = shared;
  }

  handle(ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('errors', always(() => this.#session.get('errors') ?? {}));
    const { request } = ctx;
    const document = request.headers.get(DOCUMENT_HEADER) ?? undefined;
    const submit = request.headers.get(SUBMIT_HEADER) ?? undefined;
    // A submit that is not the one a conflict waits for ends it: the conflict never lands on the page of another form. (The controller
    // of this very submit may queue a new one afterwards.)
    if (submit !== undefined && request.method !== 'GET' && request.method !== 'HEAD') this.#session.dropConflict(document, submit);
    // The page the user is shown takes the conflict: not a prefetch or an island (they stay unseen), only the document — and, with the
    // client, the submit — that sent the form (a poll, a partial reload or another tab leaves it waiting). `null`, not absent: a
    // partial reload keeps a prop the answer leaves out.
    const shown = !isPrefetch(request) && regionOf(request) !== 'island';
    // Taken once, whatever number of times the prop is read for this request.
    let conflict: SharedProps['_conflict'] | undefined;
    this.#shared.share(
      '_conflict',
      always(() => (conflict ??= shown ? (this.#session.takeConflict(document, submit) ?? null) : null)),
    );
    return next();
  }
}
