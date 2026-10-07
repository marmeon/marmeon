/**
 * Asking the user (E64), UI-free: a confirmation before a link, an action or a form is sent (`confirm`), and the navigation
 * guard's question before unsaved changes are left (`leave`). The adapter shows it — a dialog of the app's
 * (`createMarmeonApp({ confirm })`) or the browser's own `confirm()`/`prompt()` — and the core decides what the answer
 * means: a type-to-confirm question (`prompt`) is answered yes only by the text typed exactly, whatever the dialog does.
 */

/** What a confirmation asks: `confirm="Remove this link?"`, or with a title, labels — and a text to type (Livewire's `.prompt`). */
export interface ConfirmOptions {
  /** The question. */
  readonly message: string;
  /** A heading over it (the dialog's name) — default: the message. */
  readonly title?: string;
  /**
   * Type-to-confirm: yes only when exactly this is typed — `{ message: 'Delete the project?', prompt: 'DELETE' }`. For
   * what cannot be undone. The browser's own dialog asks with `prompt()`.
   */
  readonly prompt?: string;
  /** The yes button's label (the dialog's default otherwise). */
  readonly confirmLabel?: string;
  /** The no button's label. */
  readonly cancelLabel?: string;
  /** What is confirmed cannot be undone (a dialog may show the yes button as dangerous). */
  readonly destructive?: boolean;
}

/** What the navigation guard asks by default (E64). */
export const DEFAULT_LEAVE_MESSAGE = 'You have unsaved changes. Leave anyway?';

/** A confirmation as `confirm` takes it: the question, or {@link ConfirmOptions}. */
export type Confirm = string | ConfirmOptions;

/** What the adapter is asked to show: a confirmation (`confirm`) or the navigation guard's question (`leave`). */
export interface ConfirmRequest extends ConfirmOptions {
  readonly kind: 'confirm' | 'leave';
  /**
   * Why a `leave` question is asked, when it is not unsaved changes a navigation would lose: `session` — another tab signed in or
   * out, or switched the language (tab sync, W8 step 8), and loading the page again would lose them. An app's dialog words it.
   */
  readonly reason?: 'session';
}

/**
 * The adapter's answer: yes or no — or, for a type-to-confirm question, the text typed (the core compares it; `true` is not
 * enough there).
 */
export type ConfirmAnswer = boolean | string;

/** Shows a {@link ConfirmRequest} and resolves with the answer. */
export type ConfirmHandler = (request: ConfirmRequest) => ConfirmAnswer | Promise<ConfirmAnswer>;

/** The parts of `window` the browser's own dialogs need. */
export interface NativeDialogs {
  confirm?(message?: string): boolean;
  prompt?(message?: string, defaultValue?: string): string | null;
}

/** The request for `confirm` (a string is its message). */
export function confirmRequest(confirm: Confirm, kind: ConfirmRequest['kind'] = 'confirm'): ConfirmRequest {
  return typeof confirm === 'string' ? { kind, message: confirm } : { ...confirm, kind };
}

/** Whether `answer` says yes to `request` — for a type-to-confirm question only the text, exactly. */
export function accepted(request: ConfirmRequest, answer: ConfirmAnswer): boolean {
  if (request.prompt !== undefined && request.prompt !== '') return typeof answer === 'string' && answer === request.prompt;
  return answer === true;
}

/**
 * The browser's own dialogs: `confirm()`, and `prompt()` for a type-to-confirm question. Without them (no window): a guard's
 * question lets the navigation go (nothing to ask with), a confirmation is a no — nothing is sent unasked.
 */
export function nativeConfirm(dialogs: NativeDialogs | undefined): ConfirmHandler {
  return (request) => {
    const text = request.title && request.title !== request.message ? `${request.title}\n\n${request.message}` : request.message;
    if (request.prompt !== undefined && request.prompt !== '') return dialogs?.prompt?.(text, '') ?? false;
    if (dialogs?.confirm) return dialogs.confirm(text);
    return request.kind === 'leave';
  };
}
