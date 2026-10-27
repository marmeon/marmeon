import type { ConfirmAnswer, ConfirmRequest } from '@marmeon/http/client';
import { useId, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';

export type { Confirm, ConfirmAnswer, ConfirmOptions, ConfirmRequest } from '@marmeon/http/client';

/** What the app's confirmation dialog gets: the question, and how to answer it. */
export interface ConfirmProps {
  readonly request: ConfirmRequest;
  /**
   * Yes (`true`) or no (`false`) — for a type-to-confirm question (`request.prompt`), the text typed: the core compares it,
   * so a dialog cannot say yes to a wrong text by mistake.
   */
  answer(value: ConfirmAnswer): void;
}

/**
 * The dialog that asks the user — `createMarmeonApp({ confirm: ConfirmDialog })`, or one of the app's own. Without one, the
 * browser's `confirm()`/`prompt()` asks.
 */
export type ConfirmComponent = ComponentType<ConfirmProps>;

/**
 * The props of the default confirmation dialog: a {@link ConfirmProps} with the texts of its buttons, a class and
 * inline styles. See docs/dialogs.md#asking-the-user.
 */
export interface ConfirmDialogProps extends ConfirmProps {
  /** The yes button of a confirmation (default `OK`; `request.confirmLabel` wins). */
  confirmLabel?: string;
  /** The no button (default `Cancel`; `request.cancelLabel` wins). */
  cancelLabel?: string;
  /** The guard's yes: leave the unsaved changes (default `Leave`). */
  leaveLabel?: string;
  /** The guard's no (default `Stay`). */
  stayLabel?: string;
  /** The label of the field of a type-to-confirm question (default `Type “…” to confirm`). */
  promptLabel?: (prompt: string) => string;
  className?: string;
  /** Inline properties over the default look (rendered in the browser only, through the CSSOM — a strict CSP blocks none of them). */
  style?: CSSProperties;
}

/**
 * The default confirmation dialog: a native modal `<dialog>`, `role="alertdialog"`. Focus starts on the safe choice (no) or
 * in the field of a type-to-confirm question, whose yes stays disabled until the text matches. Wrap it for the app's labels:
 * `confirm: (props) => <ConfirmDialog {...props} cancelLabel={t('cancel')} />`. See docs/dialogs.md#asking-the-user.
 */
export function ConfirmDialog({
  request,
  answer,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  leaveLabel = 'Leave',
  stayLabel = 'Stay',
  promptLabel = (prompt) => `Type “${prompt}” to confirm`,
  className,
  style,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const [typed, setTyped] = useState('');
  // What had the focus (the button that asked) gets it back. Read while rendering, before anything inside takes it.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  const prompt = request.prompt !== undefined && request.prompt !== '' ? request.prompt : undefined;
  const leave = request.kind === 'leave';
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    element.setAttribute('aria-modal', 'true');
    // The safe choice first: no — or the field to type into. (showModal() would focus the first button.)
    (prompt ? field.current : safe.current)?.focus();
    return () => {
      if (element.open) element.close();
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected && opener !== opener.ownerDocument.body) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  const yes = prompt === undefined || typed === prompt;
  const title = request.title ?? request.message;
  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={request.title !== undefined ? `${id}-message` : undefined}
      data-marmeon-confirm=""
      data-kind={request.kind}
      data-destructive={request.destructive ? '' : undefined}
      className={`marmeon-confirm${className ? ` ${className}` : ''}`}
      style={style}
      onCancel={(event) => {
        // Escape: no — answered here, the dialog goes with the answer.
        event.preventDefault();
        answer(false);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          // A wrong text is no answer yet (the field says what to type); the core compares again.
          if (!yes) return;
          answer(prompt ?? true);
        }}
      >
        <h2 id={`${id}-title`} className="marmeon-confirm__title">
          {title}
        </h2>
        {request.title !== undefined && <p id={`${id}-message`}>{request.message}</p>}
        {prompt !== undefined && (
          <p>
            <label htmlFor={`${id}-prompt`}>{promptLabel(prompt)}</label>
            <br />
            <input
              ref={field}
              id={`${id}-prompt`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={typed !== '' && !yes ? true : undefined}
              className="marmeon-confirm__field"
            />
          </p>
        )}
        <p className="marmeon-confirm__actions">
          <button ref={safe} type="button" onClick={() => answer(false)}>
            {request.cancelLabel ?? (leave ? stayLabel : cancelLabel)}
          </button>
          <button type="submit" disabled={!yes} data-confirm="">
            {request.confirmLabel ?? (leave ? leaveLabel : confirmLabel)}
          </button>
        </p>
      </form>
    </dialog>
  );
}

/** One question at a time, in order — the dialog of the app shows the first. @internal */
export interface PendingQuestion {
  readonly id: number;
  readonly request: ConfirmRequest;
  readonly resolve: (answer: ConfirmAnswer) => void;
}

/** @internal Renders the first question waiting with the app's dialog. */
export function ConfirmHost({ questions, component: Dialog }: { questions: readonly PendingQuestion[]; component: ConfirmComponent | undefined }) {
  const first = questions[0];
  if (!first || !Dialog) return null;
  return <Dialog key={first.id} request={first.request} answer={(value) => first.resolve(value)} />;
}
