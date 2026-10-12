import { LayerDialog, type LayerFrameProps } from '@marmeon/react';
import { useEffect } from 'react';
import { followVisualViewport } from '../follow-visual-viewport.ts';

/**
 * The frame of the search as a layer: a palette anchored near the top, the whole screen on a phone (`styles/search.css`). On a
 * phone the whole screen is the visible part: it follows the visual viewport while the keyboard is open.
 */
export function SearchFrame(props: LayerFrameProps) {
  const { key, depth } = props.layer;
  useEffect(() => {
    if (key === undefined) return undefined;
    const dialog = document.querySelector<HTMLElement>(`dialog[data-marmeon-layer="${CSS.escape(key)}"][data-depth="${depth}"]`);
    return dialog ? followVisualViewport(dialog, window.visualViewport) : undefined;
  }, [key, depth]);
  return <LayerDialog {...props} className="search-layer" closeLabel="Close search" />;
}
