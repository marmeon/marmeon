import { useFlash, usePage, useTranslation } from '@bespokecore/react';
import { useEffect, useState } from 'react';

/** How long a toast stays (ms) — its close button takes it away sooner. */
const TOAST_DURATION = 6000;

interface Toast {
  readonly id: string;
  readonly kind: 'success' | 'error' | 'info';
  readonly message: string;
}

/**
 * The app's toasts (E60): every `toast` flash message, once — from a redirect's page, an action's answer, a layer's close.
 * A live region that is always there, so screen readers read what appears; an error is an alert. Without JavaScript, the
 * page's messages show in a `<noscript>` (rendered on the server only — the browser fires them as toasts instead).
 */
export function Toasts() {
  const t = useTranslation('app');
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  useFlash('toast', (toast, { id }) => setToasts((current) => [...current, { id, ...toast }]));
  const { flash } = usePage();
  const dismiss = (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id));
  return (
    <>
      <noscript>
        {flash
          ?.filter((message) => message.key === 'toast')
          .map((message) => (
            <p key={message.id} role="status">
              {message.data.message}
            </p>
          ))}
      </noscript>
      <section aria-label={t('notifications')} aria-live="polite" style={{ position: 'fixed', insetInlineEnd: 16, bottom: 16, display: 'grid', gap: 8, zIndex: 10, maxWidth: 'min(24rem, calc(100vw - 2rem))' }}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} closeLabel={t('close')} />
        ))}
      </section>
    </>
  );
}

const COLORS: Record<Toast['kind'], string> = { success: '#166534', error: '#991b1b', info: '#1e3a8a' };

function ToastItem({ toast, onDismiss, closeLabel }: { toast: Toast; onDismiss: () => void; closeLabel: string }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, TOAST_DURATION);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : undefined}
      data-toast={toast.kind}
      style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '10px 14px', borderRadius: 8, color: '#fff', background: COLORS[toast.kind], boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)' }}
    >
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button type="button" aria-label={closeLabel} onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
        ×
      </button>
    </div>
  );
}
