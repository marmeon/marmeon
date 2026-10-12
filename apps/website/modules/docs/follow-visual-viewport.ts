/**
 * Keeps `element` over exactly the visible part of the screen: sets `--vv-top` and `--vv-height` from the visual viewport, which
 * a phone shrinks and shifts when its keyboard opens (a fixed element would otherwise slide out of view). Set through the CSSOM —
 * no `style` attribute in the markup. Returns the cleanup.
 */
export function followVisualViewport(element: HTMLElement, viewport: Pick<VisualViewport, 'offsetTop' | 'height' | 'addEventListener' | 'removeEventListener'> | null | undefined): () => void {
  if (!viewport) return () => undefined;
  const update = () => {
    element.style.setProperty('--vv-top', `${viewport.offsetTop}px`);
    element.style.setProperty('--vv-height', `${viewport.height}px`);
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    element.style.removeProperty('--vv-top');
    element.style.removeProperty('--vv-height');
  };
}
