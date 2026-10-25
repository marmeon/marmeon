import { ERROR_PAGE, type ErrorPageProps } from '@marmeon/http/client/adapter';
import { isDevelopment, type VisitError } from '@marmeon/http/client';
import { useEffect, useRef, useState } from 'react';
import { ErrorPage } from './error-page.tsx';
import { viewName, type ErrorFallback, type PageComponent, type ResolvePage } from './pages.ts';

/*
 * What a failure shows — a chunk of its own (like the layers): `fallbacks.tsx` loads it when the server answers a visit
 * with a 5xx or a page throws while rendering, never with the first download (the notice for an unreachable server stays there:
 * offline, no chunk loads). Its look: classes of `@marmeon/react/styles.css`, no inline style.
 */

/** What the error page shows for an error thrown while rendering — the details only in development. */
export function renderErrorProps(error: unknown): ErrorPageProps {
  const exception = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? '' } : { name: 'Error', message: String(error), stack: '' };
  const development = isDevelopment();
  return {
    status: 500,
    title: 'Something went wrong',
    message: development ? exception.message : 'This page could not be shown. Please try again.',
    exception: development ? exception : null,
  };
}

/** A page component by name — loaded on demand (the error page is a chunk of its own). The built-in one if it cannot load. */
export function LazyPage({ resolve, name, props }: { resolve: ResolvePage; name: string; props: object }) {
  const [loaded, setLoaded] = useState<{ name: string; Component: PageComponent } | null>(null);
  useEffect(() => {
    let current = true;
    resolve(name).then(
      (Component) => current && setLoaded({ name, Component }),
      () => current && setLoaded({ name, Component: ErrorPage }),
    );
    return () => {
      current = false;
    };
  }, [resolve, name]);
  if (!loaded || loaded.name !== name) return null;
  return <loaded.Component {...props} />;
}

/** The app's error page (`errors/Error`) for an error thrown while rendering. */
export function RenderErrorFallback({ resolve, error }: { resolve: ResolvePage; error: unknown }) {
  const props = renderErrorProps(error);
  return <LazyPage resolve={resolve} name={viewName(resolve, ERROR_PAGE, props)} props={props} />;
}

/** A layout's `error` for an error thrown while rendering below it — inside the layout, with a retry. */
export function LayoutErrorFallback({ fallback: Fallback, error, retry }: { fallback: ErrorFallback; error: unknown; retry: () => void }) {
  return <Fallback {...renderErrorProps(error)} retry={retry} />;
}

/**
 * A 5xx over the page (which stays, with whatever was typed into it): the server's error page in a dialog — with the exception in
 * debug mode (development), else just status and title. Plain HTML from something in front of the server goes into a sandboxed frame.
 */
export function ServerFailure({ failure, resolve, onDismiss }: { failure: Extract<VisitError, { type: 'server' }>; resolve: ResolvePage; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
  }, [failure]);

  const { page, html, status } = failure;
  return (
    <dialog ref={dialog} data-marmeon-failure="server" aria-label={`Server error ${status}`} onClose={onDismiss} className="marmeon-failure marmeon-failure--server">
      <form method="dialog" className="marmeon-failure__close">
        <button type="submit" aria-label="Close">
          Close
        </button>
      </form>
      {page ? (
        <LazyPage resolve={resolve} name={viewName(resolve, page.component, page.props)} props={page.props} />
      ) : html ? (
        // No scripts, no access to this origin: the answer is shown, never run.
        <iframe sandbox="" srcDoc={html} title={`Server error ${status}`} className="marmeon-failure__frame" />
      ) : (
        <ErrorPage status={status} title="Server Error" message="Server Error" exception={null} />
      )}
    </dialog>
  );
}
