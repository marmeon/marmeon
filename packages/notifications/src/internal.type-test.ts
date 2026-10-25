// The delivery machinery is not exported — checked by `tsc` (pnpm build / typecheck), never run.
import type { NotificationError } from './index.ts';
// @ts-expect-error — `NotificationDeliverer` is not exported
import type { NotificationDeliverer } from './index.ts';
// @ts-expect-error — `DelivererDependencies` is not exported
import type { DelivererDependencies } from './index.ts';
// @ts-expect-error — `PendingDelivery` is not exported
import type { PendingDelivery } from './index.ts';
// @ts-expect-error — `NotificationRegistry` is not exported
import type { NotificationRegistry } from './index.ts';
// @ts-expect-error — `RecipientRegistry` is not exported
import type { RecipientRegistry } from './index.ts';

export type Moved = [NotificationError, NotificationDeliverer, DelivererDependencies, PendingDelivery, NotificationRegistry, RecipientRegistry];
