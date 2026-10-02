/**
 * The neutral surface under a layer whose base the user may not see (E54, `layers/Backdrop`): a deep link to the layer shows
 * it alone over this — in the app's default layout, without any of the base's data. Built in until the app brings its own
 * (`modules/layers/views/Backdrop.tsx`).
 */
export function Backdrop() {
  return <main data-bespoke-backdrop="" />;
}
