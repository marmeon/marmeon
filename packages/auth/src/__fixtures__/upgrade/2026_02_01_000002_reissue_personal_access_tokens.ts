import type { Migration } from '@marmeon/database';

// The migration `make:upgrade-migrations` writes, as the package ships it (loaded by path: the stubs are no part of the build).
const stub = new URL('../../../stubs/migrations/reissue_personal_access_tokens.ts', import.meta.url);

export default ((await import(stub.href)) as { default: Migration }).default;
