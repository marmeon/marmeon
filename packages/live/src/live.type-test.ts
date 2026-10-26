// Type guarantees of live props — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the
// compiler shows them, are quoted in the comments.
import { island, view, type SharedData } from '@marmeon/http';
import type { Broadcaster } from './broadcaster.ts';
import type { LiveConfig } from './config.ts';
import { notificationsChannel } from './notifications.ts';

declare const broadcast: Broadcaster;
declare const shared: SharedData;

// The heartbeat and the reconnect delay say their unit in the name.
export const heartbeat: LiveConfig['heartbeatSeconds'] = 20;
export const retry: LiveConfig['retryMs'] = 3000;
// @ts-expect-error — the old name is gone
export type Old = LiveConfig['heartbeat'];
// Namespace '"…/live/src/index"' has no exported member 'LiveBackend'.
// @ts-expect-error — the backend belongs to the framework, not to the entry point
export type Backend = import('@marmeon/live').LiveBackend;

export function liveTypes() {
  const profile = { name: 'Ada' };
  // A page follows a channel — its own props and the shared ones by name.
  view('users/Show' as never, { profile, activity: [] as string[] }).live('users.1', { only: ['profile', 'activity'] });
  view('users/Show' as never, { profile }).live('users.1').flash as unknown;
  island('dash/SignIns' as never, { entries: [] as number[] }).live('dashboard.sign-ins');
  view('users/Edit' as never, { profile }).layer({} as never).live('users.1', { only: ['profile'] });
  shared.live(() => notificationsChannel({ type: 'user', id: 1 }), { only: ['errors'] });

  // Type '"unknownProp"' is not assignable to type '"'unknownProp' is not a prop of this page — its props: errors, profile"'.
  // @ts-expect-error — not a prop of the page
  view('users/Show' as never, { profile }).live('users.1', { only: ['unknownProp'] });
  // Type '"entris"' is not assignable to type '"'entris' is not a prop of this island — its props: entries"'.
  // @ts-expect-error — not a prop of the island (an island has no shared props)
  island('dash/SignIns' as never, { entries: [] as number[] }).live('dashboard.sign-ins', { only: ['entris'] });
  // Type '"profle"' is not assignable to type '"'profle' is not a prop of this layer — its props: errors, profile"'.
  // @ts-expect-error — not a prop of the layer
  view('users/Edit' as never, { profile }).layer({} as never).live('users.1', { only: ['profle'] });
  // Type '"nope"' is not assignable to type '"'nope' is not a prop of the shared props — its props: errors"'.
  // @ts-expect-error — not a shared prop
  shared.live('x', { only: ['nope'] });
  // Argument of type 'number' is not assignable to parameter of type 'string'.
  // @ts-expect-error — a channel is a name
  void broadcast.refresh(7);
  // Type 'string' is not assignable to type 'readonly string[]'.
  // @ts-expect-error — only is a list
  void broadcast.refresh('users.1', { only: 'profile' });
}
