import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

/** One approved entry. `entry` is bound by the route: an entry nobody approved never gets here — it is a 404. */
export class ShowGuestbookEntryController extends Controller {
  handle(ctx: HttpContext<{}, { entry: Row<'guestbook_entries'> }>) {
    const { id, name, message, created_at } = ctx.params.entry;
    return this.view('guestbook/ShowGuestbookEntry', { entry: { id, name, message, created_at } });
  }
}
