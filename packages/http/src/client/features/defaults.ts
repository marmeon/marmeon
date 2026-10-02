/**
 * The features every navigator still attaches by default (E70). Wave 5c step 4 takes them out one by one — the adapter then
 * attaches each where it is used (`useFeature`, or on first use — E74); query state, remembered state, actions, optimistic
 * patches, prefetching, revalidateOnBack, instant visits, the guard and islands are out — layers follow in step 5 (a chunk the core loads). Their hooks run in the features' `order`, not in the order they were attached.
 */
import type { Feature } from '../feature.ts';
import { layers } from './layers.ts';

export const DEFAULT_FEATURES: readonly Feature[] = [layers];
