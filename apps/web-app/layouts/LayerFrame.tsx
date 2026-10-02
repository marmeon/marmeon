import { LayerDialog, useTranslation, type LayerFrameProps } from '@bespokecore/react';

/**
 * Around every layer's view (E53): the framework's native modal `<dialog>` — focus kept inside, Escape and the backdrop
 * close it, focus back to what opened it — with the close button in the app's language. Shared by the client and SSR entries.
 */
export function LayerFrame(props: LayerFrameProps) {
  const t = useTranslation('app');
  return <LayerDialog {...props} closeLabel={t('close')} />;
}
