import { always, isPrefetch, regionOf, SharedData, type ValidationErrors } from '@marmeon/http';
import { DOCUMENT_HEADER, SUBMIT_HEADER } from '@marmeon/http/internal';
import type { HttpContext, Next } from '@marmeon/router';
import { Session } from './session.ts';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /**
     * The validation errors of the form that was sent back to this page, `{}` if none — what `useForm` shows next to the fields. They wait
     * for the page of that submit, not for the next request. See `docs/session.md#flash-data`.
     */
    errors: ValidationErrors;
    /**
     * The conflict a form was sent back to this page with (`conflict(current)` of a form sent as a page visit), `null` if none — what
     * `useForm` shows as `form.conflict`. `current` is left out when it was too big to keep. The prefixed name is the framework's: a
     * page's own prop of that name is dropped. See `docs/forms.md#conflicts`.
     */
    _conflict: { message: string; current?: unknown } | null;
  }
}

/**
 * Shares what a form that was sent back comes back with: its validation errors, and the conflict of a stale save, `null` when there is
 * none. Both come from the record the page of that submit takes (see `docs/session.md#flash-data`), and reach every page of the `web`
 * group, partial reloads too (`always`).
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
    const { request } = ctx;
    const document = request.headers.get(DOCUMENT_HEADER) ?? undefined;
    const submit = request.headers.get(SUBMIT_HEADER) ?? undefined;
    // A submit that is not the one a record waits for ends it: what a form was sent back with never lands on the page of another form.
    // (The controller of this very submit may queue a new one afterwards.)
    if (submit !== undefined && request.method !== 'GET' && request.method !== 'HEAD') this.#session.dropSentBack(document, submit);
    // The page the user is shown takes the record: not a prefetch or an island (they stay unseen), only the document — and, with the
    // client, the submit — that sent the form (a poll, a partial reload or another tab leaves it waiting).
    if (!isPrefetch(request) && regionOf(request) !== 'island') this.#session.expectSentBack(document, submit);
    // The errors this request shows come from the record it took, else from the plain flash data where no record governs.
    this.#shared.share('errors', always(() => this.#session.shownErrors()));
    // `null`, not absent: a partial reload keeps a prop the answer leaves out.
    this.#shared.share('_conflict', always(() => this.#session.sentBack()?.conflict ?? null));
    return next();
  }
}
