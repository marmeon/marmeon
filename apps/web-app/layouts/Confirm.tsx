import { ConfirmDialog, useTranslation, type ConfirmProps } from '@marmeon/react';

/**
 * How the app asks: a link's, an action's or a form's `confirm`, and the navigation guard's question before unsaved
 * changes are left — the framework's accessible dialog (native modal `<dialog>`, the safe choice focused, type-to-confirm)
 * with the app's words. `createMarmeonApp({ confirm: Confirm })`.
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
