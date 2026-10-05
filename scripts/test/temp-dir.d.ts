/**
 * A fresh temporary directory (`<os.tmpdir()>/<prefix>XXXXXX`) that removes itself: made inside a test, when the test ends; made
 * anywhere else in a test file, when the file's tests are done. The prefix starts with `bespoke-`, so the run's hygiene check
 * (`scripts/test/temp-hygiene.ts`) names whatever is left behind. Import it statically (its file hook is registered on import).
 */
export declare function tempDir(prefix: `bespoke-${string}`): string;
