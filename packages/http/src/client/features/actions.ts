/**
 * Actions (E59), live validations (E62) and route forms under way, as a feature: what actions need of the navigator (its
 * window, the document's state, the request of a write, the confirmation, the flash messages), a form's optimistic patches
 * and its listing while it is sent. What is under way lives in slots of the document — aborted and gone when it is left.
 */
import { Actions, applyPatches, rollBack, Submissions, type ActionHost } from '../action.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, slot, type PendingVisit, type VisitPart } from '../feature.ts';
import { sendLiveValidation, type LiveValidationOutcome, type LiveValidationRequest } from '../live-validation.ts';
import { listOf } from '../optimistic.ts';
import { buildRequest } from '../request.ts';

/** The actions and route forms under way — what ghost rows are made of — a slot of the document. */
export const SUBMISSIONS = slot('submissions', () => new Submissions());

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
    fetch: (url, init) => core.window.fetch(url, init),
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

/** What adapters use of actions: run one, validate a form, follow what is under way. */
export interface ActionsFeature {
  run: Actions['run'];
  validate(url: string, request: LiveValidationRequest): Promise<LiveValidationOutcome>;
  /** The submissions under way (the document's — a new one after it was left). */
  submissions(): Submissions;
}

/** A form's optimistic patches (E59) and its listing as a submission while it is under way — gone when it ends. */
function formPart({ options, method, url }: PendingVisit, submissions: Submissions): VisitPart {
  const applied = applyPatches(listOf(options.optimistic));
  const untrack = options.name !== undefined && method !== 'get' ? submissions.add({ name: options.name, method, url, input: options.data }) : undefined;
  return {
    // The answer replaces what the patches showed — in the same render (the server's props then, or its errors).
    landed: () => {
      for (const [target, ids] of applied) target.settle(ids, false, { quiet: true });
    },
    // Failed, cancelled, or the browser took over: nothing of the patches stays.
    end: () => {
      rollBack(applied);
      untrack?.();
    },
  };
}

export const actions = defineFeature('actions', (host): ActionsFeature => {
  const actionsHost = actionHost(host);
  const submissions = () => host.document(SUBMISSIONS);
  // Under way: aborted when the document is left (signed out — their answers are not for whoever comes next).
  const running = slot(
    'actions',
    () => new Actions(actionsHost, submissions()),
    (under) => under.abortAll(),
  );
  host.on('start', (visit) => formPart(visit, submissions()));
  return {
    run: (url, options) => host.document(running).run(url, options),
    validate: (url, request) => sendLiveValidation(actionsHost, url, request),
    submissions,
  };
});
