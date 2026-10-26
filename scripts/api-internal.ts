/**
 * The exceptions to the two rules about `./internal` that `pnpm api:check` enforces (`scripts/api.ts`; CONTRIBUTING.md, "The API
 * snapshot"): every name of an `./internal` entry is imported by a file outside its package, and every class that a public
 * signature names is exported by an entry point. A key is `<specifier of the entry> <name>` for the first rule and
 * `<package> <class>` for the second.
 */

/** Names that stand on purpose. Each says why; nothing else belongs here. */
export const INTERNAL_EXCEPTIONS: Readonly<Record<string, string>> = {};
