import { defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import * as v from 'valibot';
import { LabController } from './ShowLabPageController.ts';

/**
 * The devtools' bar at work (W7 step 9): the client hook API (E132) — a link `before` cancels, a form whose errors `invalid`
 * reports — and, with `?mismatch=1`, markup that differs between the server and the browser on purpose: React recovers (it
 * renders that part again in the browser) and the bar lists the mismatch in its SSR tab (development only).
 */
export class ShowDevtoolsLabController extends LabController {
  handle(ctx: HttpContext) {
    this.enabled();
    return this.view('lab/Devtools', { blocked: '/lab/devtools/blocked', mismatch: new URL(ctx.request.url).searchParams.get('mismatch') === '1' });
  }
}

export const SendDevtoolsLabRequest = defineRequest({
  schema: v.object({ name: v.pipe(v.string(), v.trim(), v.minLength(2, 'At least two characters.')) }),
});

/** Takes a name — or sends the form back with its errors (what `invalid` reports). */
export class SendDevtoolsLabController extends LabController {
  static request = SendDevtoolsLabRequest;

  handle(_ctx: ContextOf<typeof SendDevtoolsLabRequest>) {
    this.enabled();
    return this.redirect('/lab/devtools');
  }
}
