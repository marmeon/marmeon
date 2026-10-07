import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { LayerFrameProps, LayerVariant } from './layer.tsx';

export interface LayerDialogProps extends LayerFrameProps {
  /** The close button's accessible name (default `Close` — pass the app's translation). */
  closeLabel?: string;
  className?: string;
  /**
   * Merged over the default look — a few inline properties. Rendered on the server (a deep link to a layer) they are a `style`
   * attribute, which a strict `style-src` blocks: an app with one styles the frame by `data-marmeon-layer`/`data-variant` instead.
   */
  style?: CSSProperties;
}

const LOOK: Record<LayerVariant, CSSProperties> = {
  modal: { padding: 0, border: 'none', borderRadius: 8, width: 'min(36rem, calc(100vw - 2rem))', maxHeight: 'calc(100dvh - 2rem)', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.25)' },
  slideover: { padding: 0, border: 'none', margin: '0 0 0 auto', width: 'min(28rem, 100vw)', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.2)' },
};

/**
 * The default frame of a layer: a native `<dialog>`, opened modally — the browser keeps focus inside it and makes the page
 * (and the layers beneath) inert; named by its first heading, described by an element with `data-layer-description`. Escape, the close button and a click on the
 * backdrop close it (Back in the history); focus returns to what opened it. Unstyled but for a few inline properties
 * (`data-marmeon-layer`, `data-variant` to style it). Wrap it for the app's labels:
 * `createMarmeonApp({ layer: (props) => <LayerDialog {...props} closeLabel={t('close')} /> })`.
 */
export function LayerDialog({ layer, variant, children, closeLabel = 'Close', className, style }: LayerDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  // What had the focus — the link that opened it — gets it back when the layer goes. Read while rendering: by the time the
  // effects run, an `autoFocus` field inside has taken it.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (typeof element.showModal === 'function' && !isModal(element)) {
      // React focused an `autoFocus` field already (it never writes the attribute): showModal() would move the focus to
      // the first focusable element instead — the destructive button of a confirmation, say. It stays where the view put it.
      const chosen = element.contains(element.ownerDocument.activeElement) ? element.ownerDocument.activeElement : null;
      // Server-rendered (a deep link) it is open, but not modal yet.
      if (element.open) element.close();
      name(element, id);
      element.showModal();
      if (chosen instanceof HTMLElement && chosen !== element.ownerDocument.activeElement) chosen.focus();
    }
    // Modal now (not before: a server-rendered, not yet modal dialog must not hide the page from screen readers).
    element.setAttribute('aria-modal', 'true');
    return () => {
      // Out of the modal state first: while it is modal, everything outside is inert and refuses the focus. A task later:
      // when two layers close at once, the one over this is gone by then (its opener inside this one, disconnected).
      if (element.open) element.close();
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected && opener !== opener.ownerDocument.body) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  // Its name (and description) on every commit: an answer that replaces the layer in place brings another heading.
  useLayoutEffect(() => {
    if (dialog.current) name(dialog.current, id);
  });
  /** Where a press on the dialog began — a click on the backdrop closes only when it began there too (not a text selection). */
  const pressed = useRef<EventTarget | null>(null);
  return (
    <dialog
      ref={dialog}
      open
      data-marmeon-layer={layer.key}
      data-variant={variant}
      data-depth={layer.depth}
      className={className}
      style={{ ...LOOK[variant], ...style }}
      onCancel={(event) => {
        // Escape: closed by the layer (Back), not by the browser — the dialog stays until the layer goes.
        event.preventDefault();
        void layer.close();
      }}
      onPointerDown={(event) => {
        pressed.current = event.target;
      }}
      onClick={(event) => {
        // The backdrop: a click on the dialog element itself, outside its content — pressed there as well.
        if (event.target === event.currentTarget && pressed.current === event.currentTarget) void layer.close();
      }}
    >
      <div style={{ padding: '1.5rem', paddingInlineEnd: '3rem' }}>{children}</div>
      <button
        type="button"
        data-marmeon-layer-close=""
        aria-label={closeLabel}
        onClick={() => void layer.close()}
        style={{ position: 'absolute', top: 8, insetInlineEnd: 8, font: 'inherit', fontSize: '1.25rem', lineHeight: 1, padding: '4px 8px', cursor: 'pointer', background: 'none', border: 'none' }}
      >
        ×
      </button>
    </dialog>
  );
}

/**
 * Names the dialog by its first heading (`aria-labelledby`) and describes it by `[data-layer-description]` — unless the app
 * named it itself. Development warns when there is no heading: a dialog without a name.
 */
function name(element: HTMLDialogElement, id: string): void {
  const own = (attribute: string) => element.hasAttribute(attribute) && element.getAttribute(`data-marmeon-${attribute}`) === null;
  if (!own('aria-labelledby') && !element.hasAttribute('aria-label')) {
    const heading = element.querySelector('h1, h2, h3');
    if (heading) {
      if (!heading.id) heading.id = `${id}-title`;
      element.setAttribute('aria-labelledby', heading.id);
      element.setAttribute('data-marmeon-aria-labelledby', '');
    } else if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      console.warn(`[marmeon] The layer [${element.dataset.marmeonLayer}] has no heading (h1–h3) to name its dialog — add one, or wrap LayerDialog with an aria-label.`);
    }
  }
  if (!own('aria-describedby')) {
    const description = element.querySelector('[data-layer-description]');
    if (description) {
      if (!description.id) description.id = `${id}-description`;
      element.setAttribute('aria-describedby', description.id);
      element.setAttribute('data-marmeon-aria-describedby', '');
    } else if (element.hasAttribute('data-marmeon-aria-describedby')) {
      element.removeAttribute('aria-describedby');
    }
  }
}

function isModal(element: HTMLDialogElement): boolean {
  try {
    return element.matches(':modal');
  } catch {
    return false;
  }
}
