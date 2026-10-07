import type { ErrorPageProps } from '@marmeon/http/page';

/**
 * Built-in error page, used until the app provides `modules/errors/views/Error.tsx`.
 * Exception details only arrive in debug mode (development).
 */
export function ErrorPage({ status, title, message, exception }: ErrorPageProps) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '10vh auto', padding: '0 16px' }}>
      <p style={{ fontSize: 14, letterSpacing: 1, opacity: 0.6, margin: 0 }}>{status}</p>
      <h1 style={{ margin: '4px 0 12px' }}>{title}</h1>
      {message !== title && <p>{message}</p>}
      {exception && (
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, background: 'rgba(127,127,127,0.12)', padding: 16, borderRadius: 8 }}>
          {exception.stack || `${exception.name}: ${exception.message}`}
        </pre>
      )}
    </main>
  );
}
