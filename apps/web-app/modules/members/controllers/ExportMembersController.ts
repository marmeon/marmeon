import type { Authenticated } from '@marmeon/auth';
import { Controller } from '@marmeon/http';
import { DataTables, type TableContext } from '@marmeon/table';
import { MembersTable } from '../tables/MembersTable.ts';

/** `/members/exports`: the files of the members table the user may download — the table's exports, not its rows. */
export class ExportMembersController extends Controller {
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: TableContext<Authenticated>) {
    return this.view('members/Exports', { exports: await this.#tables.exports(MembersTable, ctx) });
  }
}
