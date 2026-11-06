import { Controller } from '@marmeon/http';

/** `/islands/render-clock`: the moment it rendered, and nothing else — an island is public, so it answers with no per-visitor or per-host data. */
export class ShowRenderClockController extends Controller {
  handle() {
    return this.island('site/islands/RenderClock', { renderedAt: new Date() });
  }
}
