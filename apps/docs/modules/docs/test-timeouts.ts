/**
 * The time a test that renders pages on the server gets. Vitest's 5 s is enough alone (an SSR test takes 0.3 to 3.3 s, a test that boots two
 * more apps with Shiki highlighting every page about 3.3 s) but not beside the other suites of a full run, which share the machine: tests of
 * this kind took up to 7.1 s there and failed by the default. Pass it as the last argument of every test (or `it.each`) that creates an app with
 * `{ ssr: true }`, so a new one starts with the same limit instead of a one-off fix when it is the next to time out.
 */
export const SSR_TEST_TIMEOUT = 30_000;
