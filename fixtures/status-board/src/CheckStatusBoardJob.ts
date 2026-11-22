import { Logger, type StandardSchemaV1 } from '@marmeon/core';
import type { JobPayload } from '@marmeon/queue';

/** The payload of {@link CheckStatusBoardJob}: which service was checked. */
interface CheckPayload {
  readonly service: string;
}

/** Checks the payload by hand, so the package needs no schema library for one job. */
const schema: StandardSchemaV1<CheckPayload> = {
  '~standard': {
    version: 1,
    vendor: 'status-board',
    validate: (value) =>
      typeof value === 'object' && value !== null && typeof (value as { service?: unknown }).service === 'string'
        ? { value: { service: (value as { service: string }).service } }
        : { issues: [{ message: 'Expected { service: string }' }] },
  },
};

/** A job the package brings on its provider (`static jobs`): the app lists it nowhere, and a worker still runs it. */
export class CheckStatusBoardJob {
  static readonly job = 'status-board.check';
  static readonly schema = schema;
  static readonly inject = [Logger];

  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  handle(payload: JobPayload<typeof CheckStatusBoardJob>): void {
    this.#logger.info(`status board checked ${payload.service}`);
  }
}
