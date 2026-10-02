/**
 * The features every navigator still attaches by default (E70). Wave 5c step 4 takes them out one by one — the adapter then
 * attaches each where it is used (`useFeature`, or on first use — E74); query state, remembered state, actions, optimistic
 * patches, prefetching and revalidateOnBack are out. Their hooks run in the features' `order`, not in the order they were attached.
 */
import type { Feature } from '../feature.ts';
import { guard } from './guard.ts';
import { instant } from './instant.ts';
import { islands } from './islands.ts';
import { layers } from './layers.ts';

export const DEFAULT_FEATURES: readonly Feature[] = [guard, instant, layers, islands];
