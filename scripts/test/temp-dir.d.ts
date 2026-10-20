/**
 * A fresh temporary directory (`<os.tmpdir()>/<prefix>XXXXXX`) that removes itself: made inside a test, when the test ends; made
 * anywhere else in a test file, when the file's tests are done. The prefix starts with `marmeon-`, so the run's hygiene check
 * (`scripts/test/temp-hygiene.ts`) names whatever is left behind. Import it statically (its file hook is registered on import).
 */
export declare function tempDir(prefix: `marmeon-${string}`): string;

/**
 * Like `tempDir`, inside the checkout (`<repo>/.tmp/`), where the repository's lockfile and workspace declaration make it part of the
 * workspace: the root of an app whose modules come from the repository. Throws without `MARMEON_WORKSPACE_TMPDIR` (set by the run).
 */
export declare function workspaceTempDir(prefix: `marmeon-${string}`): string;
