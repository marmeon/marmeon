import { ERROR_PAGE, type ErrorPageProps } from '@bespokecore/http/page';
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ErrorPage } from './error-page.tsx';
import type { VisitError } from './navigation.ts';
import type { PageComponent, ResolvePage } from './pages.ts';

/**
 * Development builds (Vite replaces `process.env.NODE_ENV`, as for React itself). Without a bundler that
 * replaces it, `process` does not exist in the browser: production.
 */
export function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

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

interface ErrorBoundaryProps {
  /** A new page resets the boundary — the next page gets its chance. */
  resetKey: unknown;
  fallback: (error: unknown) => ReactNode;
  onError?: (error: unknown) => void;
  /** The children rendered without throwing. */
  onRendered?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
  error: unknown;
  resetKey: unknown;
}

/** Catches what its children throw while rendering and shows the fallback instead. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  override componentDidMount(): void {
    if (!this.state.failed) this.props.onRendered?.();
  }

  override componentDidUpdate(): void {
    if (!this.state.failed) this.props.onRendered?.();
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.state.error) : this.props.children;
  }
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
  return <LazyPage resolve={resolve} name={ERROR_PAGE} props={renderErrorProps(error)} />;
}

/**
 * What a failed visit shows, over the page (which stays, with whatever was typed into it):
 * - the server could not be reached: a notice;
 * - a 5xx: the server's error page in a dialog — with the exception in debug mode (development), else just
 *   status and title. Plain HTML from something in front of the server goes into a sandboxed frame.
 */
export function VisitFailure({ failure, resolve, onDismiss }: { failure: VisitError | null; resolve: ResolvePage; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
  }, [failure]);

  if (!failure) return null;
  if (failure.type === 'network') {
    return (
      <div role="alert" data-bespoke-failure="network" style={noticeStyle}>
        The server could not be reached. Check your connection and try again.{' '}
        <button type="button" onClick={onDismiss} style={buttonStyle}>
          Dismiss
        </button>
      </div>
    );
  }
  const { page, html, status } = failure;
  return (
    <dialog ref={dialog} data-bespoke-failure="server" aria-label={`Server error ${status}`} onClose={onDismiss} style={dialogStyle}>
      <form method="dialog" style={{ textAlign: 'right', margin: 0 }}>
        <button type="submit" aria-label="Close" style={buttonStyle}>
          Close
        </button>
      </form>
      {page ? (
        <LazyPage resolve={resolve} name={page.component} props={page.props} />
      ) : html ? (
        // No scripts, no access to this origin: the answer is shown, never run.
        <iframe sandbox="" srcDoc={html} title={`Server error ${status}`} style={{ width: '100%', height: '70vh', border: 0 }} />
      ) : (
        <ErrorPage status={status} title="Server Error" message="Server Error" exception={null} />
      )}
    </dialog>
  );
}

const noticeStyle = {
  position: 'fixed',
  insetInline: 16,
  bottom: 16,
  zIndex: 2147483646,
  padding: '12px 16px',
  borderRadius: 8,
  font: '14px/1.4 system-ui, sans-serif',
  background: 'var(--bespoke-failure-background, #1f2937)',
  color: 'var(--bespoke-failure-color, #f9fafb)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
} as const;

const dialogStyle = {
  width: 'min(960px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  padding: 16,
  border: 0,
  borderRadius: 8,
  background: 'var(--bespoke-failure-dialog-background, Canvas)',
  color: 'var(--bespoke-failure-dialog-color, CanvasText)',
} as const;

const buttonStyle = { font: 'inherit', cursor: 'pointer' } as const;
