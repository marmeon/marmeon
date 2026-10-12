import { LayerDialog, type LayerFrameProps } from '@marmeon/react';

/** The frame of the search as a layer: a palette anchored near the top, the whole screen on a phone (`styles/search.css`). */
export function SearchFrame(props: LayerFrameProps) {
  return <LayerDialog {...props} className="search-layer" closeLabel="Close search" />;
}
