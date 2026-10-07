import type { ErrorPageProps } from '@marmeon/http/page';

/**
 * Built-in error page, used until the app provides `modules/errors/views/Error.tsx` — loaded on demand, a chunk of its own.
 * Exception details only arrive in debug mode (development). Its look: `marmeon-error…` classes of `@marmeon/react/styles.css`.
 */
export function ErrorPage({ status, title, message, exception }: ErrorPageProps) {
  return (
    <main className="marmeon-error">
      <p className="marmeon-error__status">{status}</p>
      <h1 className="marmeon-error__title">{title}</h1>
      {message !== title && <p>{message}</p>}
      {exception && (
        <pre className="marmeon-error__exception">
          {exception.stack || `${exception.name}: ${exception.message}`}
        </pre>
      )}
    </main>
  );
}
