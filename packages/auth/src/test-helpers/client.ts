import type { ClientInfo } from '@marmeon/http';

/** The sender of a request outside any request — what `ClientInfo` is in a test that builds `Auth` by hand. */
export const NO_CLIENT: ClientInfo = Object.freeze({ ip: undefined, userAgent: undefined });
