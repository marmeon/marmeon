import { fileURLToPath } from 'node:url';

/** The module templates of this package: `stubs/<adapter>/modules/auth`. The path `make:auth` copies from, and the one other generators name when they point at a template of the kit. */
export const AUTH_STUBS = fileURLToPath(new URL('../stubs/', import.meta.url));
