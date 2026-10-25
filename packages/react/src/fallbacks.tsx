import type { VisitError } from '@marmeon/http/client';
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import type { ErrorFallback, ResolvePage } from './pages.ts';

/** The digest of errors in a Suspense boundary on the server — how the browser tells them from a hydration mismatch. */
export const SSR_ERROR_DIGEST = 'marmeon:ssr';

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

type ServerFailure = Extract<VisitError, { type: 'server' }>;

/**
 * The notice when the server could not be reached — in the first download: offline, no chunk could load. Also what a server's
 * failure shows when the failure chunk cannot load either.
 */
function NetworkNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="alert" data-marmeon-failure="network" className="marmeon-failure marmeon-failure--network">
      The server could not be reached. Check your connection and try again.{' '}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** When the failure chunk cannot load: the notice for a visit, nothing for a page that threw — never an error of its own. */
const unloaded = { RenderErrorFallback: () => null, LayoutErrorFallback: () => null, ServerFailure: NetworkNotice } as unknown as typeof import('./failure.tsx');

// The rest of what a failure shows is a chunk of its own (like the layers): the server's error page in a dialog and the
// app's error page for a page that threw — loaded when it happens.
const loadFailure = () => import('./failure.tsx').catch(() => unloaded);
const LazyRenderError = lazy(() => loadFailure().then((module) => ({ default: module.RenderErrorFallback })));
const LazyLayoutError = lazy(() => loadFailure().then((module) => ({ default: module.LayoutErrorFallback })));
const LazyServerFailure = lazy(() => loadFailure().then((module) => ({ default: module.ServerFailure })));

/** The app's error page (`errors/Error`) for an error thrown while rendering. */
export function RenderErrorFallback(props: { resolve: ResolvePage; error: unknown }) {
  return (
    <Suspense fallback={null}>
      <LazyRenderError {...props} />
    </Suspense>
  );
}

/** A layout's `error` in place of its children: the error page's props and a retry, from the failure chunk. */
export function LayoutError(props: { fallback: ErrorFallback; error: unknown; retry: () => void }) {
  return (
    <Suspense fallback={null}>
      <LazyLayoutError {...props} />
    </Suspense>
  );
}

/** Hands an error on to the next boundary above — for a page whose layout (with `error`) shows it. */
export function Rethrow({ error }: { error: unknown }): never {
  throw error;
}

/**
 * What a failed visit shows, over the page (which stays, with whatever was typed into it): the server could not be reached — a
 * notice; a 5xx — the server's error page in a dialog (`failure.tsx`).
 */
export function VisitFailure({ failure, resolve, onDismiss }: { failure: VisitError | null; resolve: ResolvePage; onDismiss: () => void }) {
  if (!failure) return null;
  if (failure.type === 'network') return <NetworkNotice onDismiss={onDismiss} />;
  return (
    <Suspense fallback={null}>
      <LazyServerFailure failure={failure satisfies ServerFailure} resolve={resolve} onDismiss={onDismiss} />
    </Suspense>
  );
}
