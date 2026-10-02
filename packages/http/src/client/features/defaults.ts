/**
 * The features every navigator attaches until Wave 5c step 4 (E70): then each leaves this list, and the adapter attaches it
 * where it is used (`useFeature`). The order is the order of their hooks: the guard sees a popstate before the instant visit
 * ends and before a layer's close takes it; a page fetched ahead is known before an instant visit decides on its placeholder.
 */
import type { Feature } from '../feature.ts';
import { actions } from './actions.ts';
import { guard } from './guard.ts';
import { instant } from './instant.ts';
import { islands } from './islands.ts';
import { layers } from './layers.ts';
import { optimistic } from './optimistic.ts';
import { prefetch } from './prefetch.ts';
import { revalidateOnBack } from './revalidate-on-back.ts';

export const DEFAULT_FEATURES: readonly Feature[] = [guard, prefetch, instant, layers, optimistic, actions, islands, revalidateOnBack];
