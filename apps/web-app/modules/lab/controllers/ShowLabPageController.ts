import { abort, Controller } from '@bespokecore/http';
import { LabConfig } from '../config.ts';

/** The lab's pages, each one view: a 404 unless the lab is on (`LabConfig`). */
abstract class LabController extends Controller {
  protected readonly config: LabConfig;

  constructor(config: LabConfig) {
    super();
    this.config = config;
  }

  protected enabled(): void {
    if (!this.config.enabled) abort(404);
  }
}

/** A page with a slow Suspense boundary: the shell is sent at once, the slow part streams in after `LAB_DELAY` ms. */
export class ShowStreamingLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/Streaming', { slow: { delay: this.config.delay, text: `Rendered ${this.config.delay} ms after the shell.` }, now: new Date() });
  }
}

/** A page that reads `window` while rendering: server rendering fails, the browser renders it (client fallback). */
export class ShowClientOnlyLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/ClientOnly', { now: new Date() });
  }
}

/** A page that opts out of server rendering (`BrowserOnly.ssr = false`) — the right way to do what ClientOnly does. */
export class ShowBrowserOnlyLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/BrowserOnly', {});
  }
}

/** A page whose Suspense boundary fails on the server after the shell was sent: the browser renders that boundary. */
export class ShowLateErrorLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/LateError', { late: { delay: Math.min(this.config.delay, 300) } });
  }
}
