import { ConfirmDialog, useTranslation, type ConfirmProps } from '@bespokecore/react';

/**
 * How the app asks (E64): a link's, an action's or a form's `confirm`, and the question before unsaved changes are left — the
 * framework's accessible dialog (a native modal `<dialog>`, the safe choice focused, type-to-confirm) with the app's words in
 * the page's language (`lang/en.ts`, `lang/de.ts`). `createBespokeApp({ confirm: Confirm })` in `bootstrap/client.tsx`.
 */
export function Confirm(props: ConfirmProps) {
  const t = useTranslation('app');
  // Another tab signed in or out, or switched the language (tab sync): load this page again, or stay with the unsaved changes.
  const session = props.request.reason === 'session';
  return (
    <ConfirmDialog
      {...props}
      request={session ? { ...props.request, message: t('confirm.session') } : props.request}
      confirmLabel={t('confirm.ok')}
      cancelLabel={t('confirm.cancel')}
      leaveLabel={t(session ? 'confirm.reload' : 'confirm.leave')}
      stayLabel={t('confirm.stay')}
      promptLabel={(text) => t('confirm.prompt', { text })}
    />
  );
}
