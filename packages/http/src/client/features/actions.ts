/**
 * Actions (E59) and route forms under way, as a feature: actions with what they need of the navigator (`actionHost`), and
 * the listing of what is under way — actions, and the visits of route forms (`visit({ name })`) — for ghost rows (E59 model
 * 2) and `isPending(name)`. What is under way lives in slots of the document: aborted and gone when it is left. Attached
 * where it is used (`useAction`, `usePendingSubmissions`, E70); a form's optimistic patches are the `optimistic` feature's.
 */
import { Actions, Submissions } from '../action.ts';
import { actionHost } from '../action-host.ts';
import { defineFeature, slot } from '../feature.ts';

/** What adapters use of actions: run one, follow what is under way. */
export interface ActionsFeature {
  run: Actions['run'];
  /** The submissions under way (the document's — a new one after it was left). */
  submissions(): Submissions;
}

export const actions = defineFeature('actions', (host): ActionsFeature => {
  const actionsHost = actionHost(host);
  // The actions and route forms under way — a slot of the document. Whether one of a route is under way is `isPending`'s too.
  const listed = slot('submissions', () => {
    const list = new Submissions();
    list.subscribe(() => host.pendingChanged());
    return list;
  });
  const submissions = () => host.document(listed);
  // Under way: aborted when the document is left (signed out — their answers are not for whoever comes next).
  const running = slot(
    'actions',
    () => new Actions(actionsHost, submissions()),
    (under) => under.abortAll(),
  );
  // A route form is listed while its visit is under way, by its name (`usePendingSubmissions(name)`: ghost rows).
  host.on('start', ({ options, method, url }) =>
    options.name !== undefined && method !== 'get' ? { end: submissions().add({ name: options.name, method, url, input: options.data }) } : undefined,
  );
  host.on('pending', (name) => submissions().list.some((submission) => submission.name === name) || undefined);
  return {
    run: (url, options) => host.document(running).run(url, options),
    submissions,
  };
});
