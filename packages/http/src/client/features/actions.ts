/**
 * What actions (E59) and live validations (E62) need of the navigator: its window, the document's state, the request of a
 * write, the confirmation, the flash messages — and the pages fetched ahead, out of date after a write.
 */
import type { ActionHost } from '../action.ts';
import type { NavigatorCore } from '../core.ts';
import { buildRequest } from '../request.ts';

type ActionsCore = Pick<NavigatorCore, 'navigator' | 'window' | 'left' | 'leave' | 'flash' | 'prefetches'>;

/** The host of one navigator's actions. */
export function actionHost(core: ActionsCore): ActionHost {
  return {
    get left() {
      return core.left;
    },
    get href() {
      return core.window.location.href;
    },
    fetch: (url, init) => core.window.fetch(url, init),
    leaveFor: (location) => {
      core.leave();
      core.window.location.assign(location);
    },
    changed: () => core.prefetches.flush(),
    visit: (url) => core.navigator.visit(url),
    request: (target, method, data) => buildRequest(target, method, data),
    confirm: (confirm) => core.navigator.confirm(confirm),
    flash: (messages) => core.flash.deliver(messages),
  };
}
