/**
 * What actions and live validations need of the navigator: its window, whether the document is being left, the
 * request of a write (XSRF), the confirmation, the flash messages. It keeps nothing.
 */
import type { ActionHost } from './action.ts';
import type { FeatureHost } from './core.ts';
import { atOrigin, buildRequest } from './request.ts';

type ActionsCore = Pick<FeatureHost, 'navigator' | 'window' | 'left' | 'leave' | 'flash' | 'fire'>;

/** The host of one navigator's actions. */
export function actionHost(core: ActionsCore): ActionHost {
  return {
    get left() {
      return core.left;
    },
    get href() {
      return core.window.location.href;
    },
    // Features add their headers first (the tab's live connection, so its own writes do not hint it).
    fetch: (url, init) => (core.fire('send', init.headers as Record<string, string>), core.window.fetch(atOrigin(url, core.window), init)),
    leaveFor: (location) => {
      core.leave();
      core.window.location.assign(location);
    },
    // A write changed what the server shows: pages fetched ahead are out of date.
    changed: () => core.fire('write'),
    visit: (url) => core.navigator.visit(url),
    request: (target, method, data) => buildRequest(target, method, data),
    confirm: (confirm) => core.navigator.confirm(confirm),
    flash: (messages) => core.flash.deliver(messages),
  };
}
