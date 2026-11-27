import { withCode } from '@marmeon/core/internal';
import { MysqlQueryCompiler } from 'kysely';
import { UnsupportedDriverError } from './supported-driver.ts';

/**
 * Kysely's MySQL compiler, where Marmeon's own differences from it go: what MySQL spells otherwise than the other drivers. Every
 * statement of a MySQL connection is compiled here, before it is sent, so a refusal sends nothing.
 */
export class MarmeonMysqlCompiler extends MysqlQueryCompiler {
  protected override visitReturning(): never {
    throw new UnsupportedDriverError(
      withCode(
        'D29',
        "MySQL has no RETURNING, so this statement was not sent: the repository's insert() and update() return the row on MySQL; otherwise read the row after the write. See docs/queries.md#writing-on-mysql.",
      ),
    );
  }

  protected override visitOnConflict(): never {
    throw new UnsupportedDriverError(
      withCode(
        'D29',
        "MySQL has no ON CONFLICT, so this statement was not sent: use onDuplicateKeyUpdate(), which acts on a conflict with any unique index, or read the row and then insert or update it. See docs/queries.md#writing-on-mysql.",
      ),
    );
  }

  protected override visitMergeQuery(): never {
    throw new UnsupportedDriverError(withCode('D29', 'MySQL has no MERGE, so this statement was not sent: write the rows with insert() and update(). See docs/queries.md#writing-on-mysql.'));
  }
}
