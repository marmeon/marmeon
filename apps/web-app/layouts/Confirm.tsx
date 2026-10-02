import { ConfirmDialog, useTranslation, type ConfirmProps } from '@bespokecore/react';

/**
 * How the app asks (E64): a link's, an action's or a form's `confirm`, and the navigation guard's question before unsaved
 * changes are left — the framework's accessible dialog (native modal `<dialog>`, the safe choice focused, type-to-confirm)
 * with the app's words. `createBespokeApp({ confirm: Confirm })`.
 */
export function Confirm(props: ConfirmProps) {
  const t = useTranslation('app');
  return (
    <ConfirmDialog
      {...props}
      confirmLabel={t('confirm.ok')}
      cancelLabel={t('confirm.cancel')}
      leaveLabel={t('confirm.leave')}
      stayLabel={t('confirm.stay')}
      promptLabel={(text) => t('confirm.prompt', { text })}
    />
  );
}
