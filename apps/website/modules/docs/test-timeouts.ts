/**
 * The time a test that renders pages on the server gets: Vitest's 5 s suffice alone (0.3 to 3.3 s), not beside the other suites
 * of a full run on the same machine (up to 7.1 s). Pass it as the last argument of every test (or `it.each`) that creates an app
 * with `{ ssr: true }`.
 */
export const SSR_TEST_TIMEOUT = 30_000;
