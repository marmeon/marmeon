import { LayerDialog, useTranslation, type LayerFrameProps } from '@marmeon/react';
import type { CSSProperties } from 'react';

/**
 * Around every layer's view (E53): the framework's native modal `<dialog>` — focus kept inside, Escape and the backdrop
 * close it, focus back to what opened it — with the close button in the app's language. Shared by the client and SSR entries.
 * Its look: `@marmeon/react/styles.css` and `.app-layer` (styles/app.css). The depth goes in as a CSS variable through the
 * `style` prop, which LayerDialog writes through the CSSOM once mounted (E202) — never a `style` attribute a strict
 * `style-src` would block; a nested modal sits a little lower and to the side of the one beneath.
 */
export function LayerFrame(props: LayerFrameProps) {
  const t = useTranslation('app');
  return <LayerDialog {...props} closeLabel={t('close')} className="app-layer" style={{ '--layer-depth': props.layer.depth } as CSSProperties} />;
}
