/** An app's page components, relative to its root: every `.tsx` under a module's `views/`, minus `PAGE_TESTS_GLOB`. See docs/pages.md. */
export const PAGES_GLOB = 'modules/*/views/**/*.tsx';

/**
 * The tests among them (`Show.test.tsx`, `.spec.tsx`, `.type-test.tsx`): no page — not in `interface Views`, not in
 * `virtual:marmeon/pages`, so no build ships one with its test runner.
 */
export const PAGE_TESTS_GLOB = 'modules/*/views/**/*.{test,spec,type-test}.tsx';
