import type { Authenticated } from '@marmeon/auth';
import { Logger } from '@marmeon/core';
import type { TableContext, TableExportInfo } from '@marmeon/table';

/**
 * Export recorder of the members table: who downloaded the list, how many rows and as which filter, written before the first byte.
 * If the log throws, the download fails with it. An app that must keep a durable trail writes a row instead (see docs/events.md#an-audit-trail).
 */
export class RecordMembersExport {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  handle(info: TableExportInfo, ctx: TableContext<Authenticated>) {
    this.#logger.info('members exported', { userId: ctx.user.id, table: info.table, export: info.export, rows: info.rows, columns: info.columns, state: info.state });
  }
}
