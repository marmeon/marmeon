/**
 * The features every navigator still attaches by default (E70). Wave 5c step 4 takes them out one by one — the adapter then
 * attaches each where it is used (`useFeature`); query state, remembered state, actions and optimistic patches are out. The
 * order is the order of their hooks: the guard sees a popstate before the instant visit ends and before a layer's close takes
 * it; a page fetched ahead is known before an instant visit decides on its placeholder.
 */
import type { Feature } from '../feature.ts';
import { guard } from './guard.ts';
import { instant } from './instant.ts';
import { islands } from './islands.ts';
import { layers } from './layers.ts';
import { prefetch } from './prefetch.ts';
import { revalidateOnBack } from './revalidate-on-back.ts';

export const DEFAULT_FEATURES: readonly Feature[] = [guard, prefetch, instant, layers, islands, revalidateOnBack];
