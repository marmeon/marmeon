/**
 * The neutral surface under a layer whose base the user may not see (`system/layers/Backdrop`): a deep link to the layer shows
 * it alone over this — in the app's default layout, without any of the base's data. Built in until the app brings its own
 * (`modules/system/views/layers/Backdrop.tsx`).
 */
export function Backdrop() {
  return <main data-marmeon-backdrop="" />;
}
