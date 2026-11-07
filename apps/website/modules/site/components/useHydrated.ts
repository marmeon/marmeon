import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/**
 * `false` in the server's HTML and while React hydrates, `true` afterwards. A component that only works with JavaScript renders its enhanced
 * form once this is `true`, so the markup the server sent never mismatches and no inline script is needed.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
