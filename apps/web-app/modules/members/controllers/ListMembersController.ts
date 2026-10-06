import type { Authenticated } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Tables } from '@bespokecore/table';
import { MembersTable } from '../tables/MembersTable.ts';

/**
 * The query of `/members`: the table's state — sort, page, page size, search, filters (E183). Stricter than other lists (E55/E56):
 * a sort, a filter or a page size the table does not have is a 400.
 */
export const ListMembersRequest = defineRequest({ query: MembersTable.query });

/** `/members`: the members table — what the user may see of it, a page at a time. */
export class ListMembersController extends Controller {
  static request = ListMembersRequest;

  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: ContextOf<typeof ListMembersRequest> & Authenticated) {
    // A function: computed when sent — a partial reload of something else leaves it out.
    return this.view('members/Index', { members: () => this.#tables.resolve(MembersTable, ctx) });
  }
}
