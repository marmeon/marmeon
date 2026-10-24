import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { DataTables } from '@marmeon/table';
import { MembersTable } from '../tables/MembersTable.ts';

/**
 * The query of `/members`: the table's state — sort, page, page size, search, filters. Stricter than other lists:
 * a sort, a filter or a page size the table does not have is a 400.
 */
export const ListMembersRequest = defineRequest({ query: MembersTable.query });

/** `/members`: the members table — what the user may see of it, a page at a time. */
export class ListMembersController extends Controller {
  static request = ListMembersRequest;

  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: ContextOf<typeof ListMembersRequest> & Authenticated) {
    // A function: computed when sent — a partial reload of something else leaves it out.
    return this.view('members/Index', { members: () => this.#tables.resolve(MembersTable, ctx) });
  }
}
